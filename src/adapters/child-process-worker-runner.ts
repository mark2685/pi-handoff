/**
 * Child-process implementation of the isolated Pi worker boundary.
 *
 * This mirrors Pi's upstream subagent extension for reinvocation and NDJSON
 * buffering, while normalizing only the data Gate B and its widget need. The
 * injectable invocation resolver keeps tests hermetic without weakening the
 * production `pi --mode json` spawn contract.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
	WorkerActiveTool,
	WorkerActivity,
	WorkerRunOutcome,
	WorkerRunProgress,
	WorkerRunRequest,
	WorkerRunner,
	WorkerToolResult,
	WorkerUsage,
} from "../ports/worker-runner.ts";

/** Time given to a cooperative worker after SIGTERM before SIGKILL is sent. */
export const DEFAULT_ABORT_GRACE_PERIOD_MS = 5_000;

/** Cap redraw-producing updates from streaming text and tool output without hiding state changes. */
const MIN_PROGRESS_UPDATE_INTERVAL_MS = 250;

/** Command and argument vector used to launch Pi or an injected test worker. */
export interface PiInvocation {
	command: string;
	args: string[];
}

/** Resolves the executable that receives the standard worker arguments. */
export type PiInvocationResolver = (args: string[]) => PiInvocation;

/** Construction-time dependencies for the process adapter. */
export interface ChildProcessWorkerRunnerOptions {
	/** Replaces real-Pi resolution in hermetic tests. */
	getInvocation?: PiInvocationResolver;
	/** Kept configurable for fast escalation tests; production uses the upstream five-second grace period. */
	abortGracePeriodMs?: number;
}

interface AssistantMessage {
	text: string | undefined;
	usage: ParsedUsage | undefined;
	stopReason: string | undefined;
	errorMessage: string | undefined;
}

interface ParsedUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
}

/** Builds the exact Pi argument contract for an approved worker run. */
function buildWorkerArgs(request: WorkerRunRequest): string[] {
	return [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		`${request.choice.provider}/${request.choice.model}`,
		"--thinking",
		request.choice.thinking,
		`@${request.promptPath}`,
	];
}

/** Returns a fresh, zeroed usage aggregate for one worker run. */
function emptyUsage(): WorkerUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

/** Copies mutable aggregate state before it crosses the adapter boundary. */
function copyUsage(usage: WorkerUsage): WorkerUsage {
	return { ...usage };
}

/** Reads only records from untrusted NDJSON values. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a finite numeric field, treating absent or malformed provider data as zero. */
function numberField(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Extracts the first text part, matching upstream's final-output selection behavior. */
function firstTextPart(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;

	for (const part of content) {
		if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
		return part.text;
	}

	return undefined;
}

/** Joins every text part from a tool result while dropping non-text content such as images. */
function toolResultText(content: unknown): string {
	if (!Array.isArray(content)) return "";

	return content
		.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("");
}

/** Parses the provider usage shape carried by a completed assistant message. */
function parseUsage(value: unknown): ParsedUsage | undefined {
	if (!isRecord(value)) return undefined;
	const cost = isRecord(value.cost) ? value.cost : undefined;
	return {
		input: numberField(value, "input"),
		output: numberField(value, "output"),
		cacheRead: numberField(value, "cacheRead"),
		cacheWrite: numberField(value, "cacheWrite"),
		cost: cost === undefined ? 0 : numberField(cost, "total"),
		contextTokens: numberField(value, "totalTokens"),
	};
}

/** Normalizes an assistant message only when its event carries the expected role. */
function parseAssistantMessage(value: unknown): AssistantMessage | undefined {
	if (!isRecord(value) || value.role !== "assistant") return undefined;
	return {
		text: firstTextPart(value.content),
		usage: parseUsage(value.usage),
		stopReason: typeof value.stopReason === "string" ? value.stopReason : undefined,
		errorMessage: typeof value.errorMessage === "string" ? value.errorMessage : undefined,
	};
}

/** Reads the stable identity fields from a tool execution lifecycle event. */
function parseActiveTool(value: unknown): WorkerActiveTool | undefined {
	if (!isRecord(value) || typeof value.toolCallId !== "string" || typeof value.toolName !== "string") return undefined;
	return { toolCallId: value.toolCallId, toolName: value.toolName };
}

/** Reads the tool name Pi includes in a streaming toolcall_start event. */
function toolNameFromAssistantEvent(value: unknown): string | undefined {
	if (!isRecord(value) || value.type !== "toolcall_start" || typeof value.toolName !== "string") return undefined;
	return value.toolName;
}

/** Normalizes a completed tool result for the later running-widget adapter consumer. */
function parseToolResult(value: unknown): WorkerToolResult | undefined {
	if (!isRecord(value) || value.role !== "toolResult") return undefined;
	if (
		typeof value.toolCallId !== "string" ||
		typeof value.toolName !== "string" ||
		typeof value.isError !== "boolean"
	) {
		return undefined;
	}

	return {
		toolCallId: value.toolCallId,
		toolName: value.toolName,
		text: toolResultText(value.content),
		isError: value.isError,
	};
}

/** Finds the latest assistant text in upstream message order. */
function getFinalOutput(messages: readonly AssistantMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const text = messages[index]?.text;
		if (text !== undefined) return text;
	}

	return "";
}

/** Formats unknown process errors without allowing an error listener to throw. */
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves how to invoke the Pi CLI from the current runtime.
 *
 * This is deliberately kept equivalent to the upstream subagent example so it
 * can be diffed when Pi changes its launcher behavior: reuse a real current
 * script under Node/Bun, use a non-generic executable directly, otherwise use
 * the `pi` command from PATH.
 */
export function getPiInvocation(args: string[]): PiInvocation {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const executableName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(executableName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

/** Creates the process-backed runner used by the later composition root. */
export function createChildProcessWorkerRunner(options: ChildProcessWorkerRunnerOptions = {}): WorkerRunner {
	const getInvocation = options.getInvocation ?? getPiInvocation;
	const abortGracePeriodMs = options.abortGracePeriodMs ?? DEFAULT_ABORT_GRACE_PERIOD_MS;

	return {
		async run(request: WorkerRunRequest): Promise<WorkerRunOutcome> {
			if (request.signal?.aborted) {
				return {
					exitCode: undefined,
					report: "",
					usage: emptyUsage(),
					toolResults: [],
					stopReason: undefined,
					errorMessage: undefined,
					stderr: "",
					aborted: true,
				};
			}

			const args = buildWorkerArgs(request);
			const invocation = getInvocation(args);
			const usage = emptyUsage();
			const assistantMessages: AssistantMessage[] = [];
			const toolResults: WorkerToolResult[] = [];
			const completedToolCallIds = new Set<string>();
			const activeTools = new Map<string, WorkerActiveTool>();
			let activity: WorkerActivity = { kind: "starting" };
			let lastProgressAtMs = Number.NEGATIVE_INFINITY;
			let stopReason: string | undefined;
			let errorMessage: string | undefined;
			let stderr = "";
			let aborted = false;

			return new Promise<WorkerRunOutcome>((resolve) => {
				let settled = false;
				let buffer = "";
				let abortTimer: ReturnType<typeof setTimeout> | undefined;
				let noProgressTimer: ReturnType<typeof setTimeout> | undefined;
				let processHandle: ReturnType<typeof spawn> | undefined;

				const makeOutcome = (exitCode: number | undefined): WorkerRunOutcome => ({
					exitCode,
					report: getFinalOutput(assistantMessages),
					usage: copyUsage(usage),
					toolResults: toolResults.map((result) => ({ ...result })),
					stopReason,
					errorMessage,
					stderr,
					aborted,
				});

				const removeListeners = () => {
					if (!processHandle) return;
					processHandle.stdout?.removeListener("data", onStdout);
					processHandle.stderr?.removeListener("data", onStderr);
					processHandle.removeListener("close", onClose);
					processHandle.removeListener("error", onError);
				};

				const settle = (exitCode: number | undefined) => {
					if (settled) return;
					settled = true;
					if (abortTimer !== undefined) clearTimeout(abortTimer);
					// This is especially important for short-lived workers: the watchdog is
					// a prompt, not a process owner, and must not keep Node's event loop alive
					// after the child has already exited.
					if (noProgressTimer !== undefined) clearTimeout(noProgressTimer);
					request.signal?.removeEventListener("abort", onAbort);
					removeListeners();
					resolve(makeOutcome(exitCode));
				};

				const stopProcess = (markAborted: boolean) => {
					if (settled || !processHandle) return;
					if (markAborted) aborted = true;
					processHandle.kill("SIGTERM");
					abortTimer = setTimeout(() => {
						if (!settled) processHandle?.kill("SIGKILL");
					}, abortGracePeriodMs);
				};

				/**
				 * Re-arms the human-facing no-progress watchdog after a real worker event.
				 *
				 * Pi legitimately goes quiet during model requests and slow tools, so expiry
				 * deliberately emits a stalled activity and never calls `stopProcess`. Escape
				 * remains the only route that terminates a child.
				 */
				const resetNoProgressTimer = () => {
					if (noProgressTimer !== undefined) clearTimeout(noProgressTimer);
					noProgressTimer = setTimeout(() => {
						noProgressTimer = undefined;
						if (settled) return;
						setActivity({ kind: "stalled" });
						emitProgress(true);
					}, request.noProgressThresholdMs);
				};

				/** Updates activity and says whether its displayable state actually changed. */
				const setActivity = (next: WorkerActivity): boolean => {
					const changed = activity.kind !== next.kind || activity.toolName !== next.toolName;
					activity = next;
					return changed;
				};

				/** Sends phase changes immediately but coalesces high-frequency token and tool-output updates. */
				const emitProgress = (force = false) => {
					if (!request.onProgress || settled) return;
					const nowMs = Date.now();
					if (!force && nowMs - lastProgressAtMs < MIN_PROGRESS_UPDATE_INTERVAL_MS) return;
					lastProgressAtMs = nowMs;
					const progress: WorkerRunProgress = {
						report: getFinalOutput(assistantMessages),
						usage: copyUsage(usage),
						toolResults: toolResults.map((result) => ({ ...result })),
						stopReason,
						errorMessage,
						activity: { ...activity },
						activeTools: Array.from(activeTools.values(), (tool) => ({ ...tool })),
					};
					try {
						request.onProgress(progress);
					} catch (error) {
						errorMessage ??= `Worker progress callback failed: ${errorText(error)}`;
						stopProcess(false);
					}
				};

				/** Avoid duplicate tool rows when Pi emits both lifecycle and message-end records. */
				const addToolResult = (toolResult: WorkerToolResult) => {
					if (completedToolCallIds.has(toolResult.toolCallId)) return false;
					completedToolCallIds.add(toolResult.toolCallId);
					toolResults.push(toolResult);
					return true;
				};

				const processLine = (line: string) => {
					if (!line.trim() || settled) return;

					let event: unknown;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}
					if (!isRecord(event) || typeof event.type !== "string") return;

					if (event.type === "agent_start" || event.type === "turn_start") {
						resetNoProgressTimer();
						emitProgress(setActivity({ kind: "thinking" }));
						return;
					}

					if (event.type === "agent_end") {
						resetNoProgressTimer();
						emitProgress(setActivity({ kind: "finalizing" }));
						return;
					}

					if (event.type === "message_start") {
						if (parseAssistantMessage(event.message) !== undefined) {
							resetNoProgressTimer();
							emitProgress(setActivity({ kind: "thinking" }));
						}
						return;
					}

					if (event.type === "message_update") {
						const assistantEvent = event.assistantMessageEvent;
						const toolName = toolNameFromAssistantEvent(assistantEvent);
						const kind =
							isRecord(assistantEvent) && typeof assistantEvent.type === "string" ? assistantEvent.type : undefined;
						let nextActivity: WorkerActivity | undefined;
						if (toolName !== undefined) nextActivity = { kind: "preparing_tool", toolName };
						else if (kind === "thinking_delta") nextActivity = { kind: "thinking" };
						else if (kind === "text_delta") nextActivity = { kind: "writing" };
						else return;
						resetNoProgressTimer();
						emitProgress(setActivity(nextActivity));
						return;
					}

					if (event.type === "tool_execution_start") {
						const tool = parseActiveTool(event);
						if (tool === undefined) return;
						activeTools.set(tool.toolCallId, tool);
						resetNoProgressTimer();
						setActivity({ kind: "running_tools", toolName: tool.toolName });
						emitProgress(true);
						return;
					}

					if (event.type === "tool_execution_update") {
						const tool = parseActiveTool(event);
						if (tool === undefined) return;
						resetNoProgressTimer();
						emitProgress(setActivity({ kind: "running_tools", toolName: tool.toolName }));
						return;
					}

					if (event.type === "tool_execution_end") {
						const tool = parseActiveTool(event);
						if (tool === undefined) return;
						resetNoProgressTimer();
						activeTools.delete(tool.toolCallId);
						setActivity({ kind: "thinking" });
						emitProgress(true);
						return;
					}

					if (event.type === "message_end") {
						const message = parseAssistantMessage(event.message);
						if (message !== undefined) {
							resetNoProgressTimer();
							assistantMessages.push(message);
							usage.turns += 1;
							if (message.usage) {
								usage.inputTokens += message.usage.input;
								usage.outputTokens += message.usage.output;
								usage.cacheReadTokens += message.usage.cacheRead;
								usage.cacheWriteTokens += message.usage.cacheWrite;
								usage.cost += message.usage.cost;
								usage.contextTokens = message.usage.contextTokens;
							}
							if (message.stopReason !== undefined) stopReason = message.stopReason;
							if (message.errorMessage !== undefined) errorMessage = message.errorMessage;
							emitProgress(
								setActivity(message.stopReason === "toolUse" ? { kind: "preparing_tool" } : { kind: "writing" }),
							);
							return;
						}

						const toolResult = parseToolResult(event.message);
						if (toolResult !== undefined && addToolResult(toolResult)) {
							resetNoProgressTimer();
							setActivity({ kind: "thinking" });
							emitProgress(true);
						}
						return;
					}

					// pi 0.85 emitted a dedicated event, while current JSON mode emits the
					// same tool-result message through message_end. Accept both shapes.
					if (event.type === "tool_result_end") {
						const toolResult = parseToolResult(event.message);
						if (toolResult === undefined || !addToolResult(toolResult)) return;
						resetNoProgressTimer();
						setActivity({ kind: "thinking" });
						emitProgress(true);
					}
				};

				const onStdout = (chunk: Buffer) => {
					buffer += chunk.toString("utf8");
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) processLine(line);
				};

				const onStderr = (chunk: Buffer) => {
					stderr += chunk.toString("utf8");
				};

				const onClose = (code: number | null) => {
					if (buffer.trim()) processLine(buffer);
					settle(code ?? undefined);
				};

				const onError = (error: Error) => {
					errorMessage ??= errorText(error);
					settle(1);
				};

				const onAbort = () => {
					stopProcess(true);
				};

				try {
					processHandle = spawn(invocation.command, invocation.args, {
						cwd: request.cwd,
						shell: false,
						stdio: ["ignore", "pipe", "pipe"],
					});
				} catch (error) {
					errorMessage = errorText(error);
					settle(1);
					return;
				}

				processHandle.stdout?.on("data", onStdout);
				processHandle.stderr?.on("data", onStderr);
				processHandle.on("close", onClose);
				processHandle.on("error", onError);
				// Arm only after the pipes are observed; an immediate child event is buffered
				// by Node and will reset this timer when its lifecycle record is processed.
				resetNoProgressTimer();
				request.signal?.addEventListener("abort", onAbort, { once: true });
				if (request.signal?.aborted) onAbort();
			});
		},
	};
}
