/**
 * Integration-style tests for the child-process worker adapter.
 *
 * A temporary Node script behaves like Pi's NDJSON mode, giving these tests real
 * pipes, exit codes, and signals without invoking Pi, requiring credentials, or
 * reaching the network.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createChildProcessWorkerRunner } from "../../src/adapters/child-process-worker-runner.ts";
import { writeFakeWorker } from "./fake-worker.ts";
import { buildPromptPath } from "../../src/domain/draft/slug.ts";
import type { ModelChoice } from "../../src/domain/types.ts";
import {
	DEFAULT_NO_PROGRESS_THRESHOLD_MS,
	type WorkerRunProgress,
	type WorkerRunner,
	type WorkerUsage,
} from "../../src/ports/worker-runner.ts";

const WORKER_CHOICE: ModelChoice = { provider: "test-provider", model: "test-model", thinking: "high" };

const NORMAL_USAGE: WorkerUsage = {
	inputTokens: 17,
	outputTokens: 28,
	cacheReadTokens: 12,
	cacheWriteTokens: 14,
	cost: 0.03,
	contextTokens: 34,
	turns: 2,
};

let tempDir: string;
let fakeWorkerPath: string;
const promptPathsOutsideTemp = new Set<string>();
const spawnedPids = new Set<number>();

beforeEach(async () => {
	tempDir = await mkdtemp(path.join(tmpdir(), "pi-handoff-worker-runner-"));
	fakeWorkerPath = await writeFakeWorker(tempDir);
});

afterEach(async () => {
	for (const pid of spawnedPids) {
		if (processExists(pid)) process.kill(pid, "SIGKILL");
	}
	spawnedPids.clear();
	await Promise.all([...promptPathsOutsideTemp].map((promptPath) => rm(promptPath, { force: true })));
	promptPathsOutsideTemp.clear();
	await rm(tempDir, { recursive: true, force: true });
});

/** Starts the temporary Node worker in place of the real Pi executable. */
function createTestRunner(abortGracePeriodMs?: number): WorkerRunner {
	return createChildProcessWorkerRunner({
		getInvocation: (args) => ({ command: process.execPath, args: [fakeWorkerPath, ...args] }),
		...(abortGracePeriodMs === undefined ? {} : { abortGracePeriodMs }),
	});
}

/** Writes an otherwise unused handoff prompt because the runner intentionally does not create it. */
async function createPrompt(scenario: string): Promise<string> {
	const promptPath = path.join(tempDir, `${scenario}.md`);
	await writeFile(promptPath, "# Approved handoff prompt\n", "utf8");
	return promptPath;
}

/** Supplies the complete port request so optional behavior remains explicit under exactOptionalPropertyTypes. */
function request(
	promptPath: string,
	overrides: Partial<{
		signal: AbortSignal | undefined;
		onProgress: ((progress: WorkerRunProgress) => void) | undefined;
		noProgressThresholdMs: number;
	}> = {},
) {
	return {
		choice: WORKER_CHOICE,
		promptPath,
		cwd: tempDir,
		noProgressThresholdMs: overrides.noProgressThresholdMs ?? DEFAULT_NO_PROGRESS_THRESHOLD_MS,
		signal: overrides.signal ?? undefined,
		onProgress: overrides.onProgress ?? undefined,
	};
}

/** Returns whether a process id still exists without treating a missing child as an error. */
function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isErrnoWithCode(error, "ESRCH")) return false;
		throw error;
	}
}

/** Narrows a Node system error without using `any` in the test harness. */
function isErrnoWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

describe("child-process worker runner", () => {
	it("accumulates assistant messages, usage, and tool results from a normal worker run", async () => {
		const updates: WorkerRunProgress[] = [];
		const outcome = await createTestRunner().run(
			request(await createPrompt("normal"), { onProgress: (progress) => updates.push(progress) }),
		);

		assert.deepEqual(outcome, {
			exitCode: 0,
			report: "Implementation complete.",
			usage: NORMAL_USAGE,
			toolResults: [{ toolCallId: "tool-1", toolName: "read", text: "source contents", isError: false }],
			stopReason: "stop",
			errorMessage: undefined,
			stderr: "",
			aborted: false,
		});
		assert.equal(updates.length, 3);
		assert.deepEqual(updates[0], {
			report: "Inspecting the implementation.",
			usage: {
				inputTokens: 10,
				outputTokens: 20,
				cacheReadTokens: 3,
				cacheWriteTokens: 4,
				cost: 0.01,
				contextTokens: 37,
				turns: 1,
			},
			toolResults: [],
			stopReason: "toolUse",
			errorMessage: undefined,
			activity: { kind: "preparing_tool" },
			activeTools: [],
		});
	});

	it("turns worker lifecycle events into live phases and active-tool status", async () => {
		const updates: WorkerRunProgress[] = [];
		const outcome = await createTestRunner().run(
			request(await createPrompt("activity"), { onProgress: (progress) => updates.push(progress) }),
		);

		assert.equal(outcome.report, "Activity report.");
		assert.ok(updates.some((progress) => progress.activity?.kind === "thinking"));
		assert.ok(updates.some((progress) => progress.activity?.kind === "writing"));
		assert.ok(
			updates.some((progress) => progress.activity?.kind === "preparing_tool" && progress.activity.toolName === "bash"),
		);
		assert.ok(
			updates.some(
				(progress) =>
					progress.activity?.kind === "running_tools" &&
					progress.activeTools?.length === 1 &&
					progress.activeTools[0]?.toolName === "bash",
			),
		);
		assert.equal(updates.at(-1)?.activity?.kind, "finalizing");
		assert.deepEqual(updates.at(-1)?.toolResults, [
			{ toolCallId: "tool-activity", toolName: "bash", text: "done", isError: false },
		]);
	});

	it("parses a JSON event whose stdout line is genuinely split across writes", async () => {
		const outcome = await createTestRunner().run(request(await createPrompt("split")));

		assert.deepEqual(outcome, {
			exitCode: 0,
			report: "Split event report.",
			usage: {
				inputTokens: 10,
				outputTokens: 20,
				cacheReadTokens: 3,
				cacheWriteTokens: 4,
				cost: 0.01,
				contextTokens: 37,
				turns: 1,
			},
			toolResults: [],
			stopReason: "stop",
			errorMessage: undefined,
			stderr: "",
			aborted: false,
		});
	});

	it("passes exactly the approved Pi worker argument contract without hidden flags", async () => {
		const promptPath = buildPromptPath(`capture-args-${process.pid}-${Date.now()}`);
		promptPathsOutsideTemp.add(promptPath);
		await writeFile(promptPath, "# Approved handoff prompt\n", "utf8");

		const outcome = await createTestRunner().run(request(promptPath));

		assert.deepEqual(JSON.parse(outcome.report) as string[], [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			"test-provider/test-model",
			"--thinking",
			"high",
			`@${promptPath}`,
		]);
		assert.equal(outcome.report.includes("--tools"), false);
		assert.equal(outcome.report.includes("--append-system-prompt"), false);
	});

	it("reports a silent worker as stalled without terminating the child", async () => {
		let childAliveWhenWatchdogFired = false;
		let workerPid: number | undefined;
		const outcome = await createTestRunner().run(
			request(await createPrompt("stalled"), {
				noProgressThresholdMs: 200,
				onProgress: (progress) => {
					if (progress.activity?.kind !== "stalled") return;
					workerPid = Number(readFileSync(path.join(tempDir, "stalled.pid"), "utf8"));
					spawnedPids.add(workerPid);
					childAliveWhenWatchdogFired = processExists(workerPid);
				},
			}),
		);

		assert.equal(childAliveWhenWatchdogFired, true, "the watchdog must not end the worker");
		assert.equal(outcome.aborted, false);
		assert.equal(outcome.exitCode, 0);
		assert.equal(outcome.report, "Worker eventually finished.");
		if (workerPid !== undefined) spawnedPids.delete(workerPid);
	});

	it("resets the watchdog after each meaningful worker event", async () => {
		const updates: WorkerRunProgress[] = [];
		const outcome = await createTestRunner().run(
			request(await createPrompt("watchdog-reset"), {
				noProgressThresholdMs: 500,
				onProgress: (progress) => updates.push(progress),
			}),
		);

		assert.equal(outcome.report, "Frequent events prevented a stall.");
		assert.equal(
			updates.some((progress) => progress.activity?.kind === "stalled"),
			false,
		);
	});

	it("returns a non-zero worker exit and stderr as an outcome rather than throwing", async () => {
		const outcome = await createTestRunner().run(request(await createPrompt("failing")));

		assert.deepEqual(outcome, {
			exitCode: 17,
			report: "Partial report before failure.",
			usage: {
				inputTokens: 10,
				outputTokens: 20,
				cacheReadTokens: 3,
				cacheWriteTokens: 4,
				cost: 0.01,
				contextTokens: 37,
				turns: 1,
			},
			toolResults: [],
			stopReason: "error",
			errorMessage: "provider failed",
			stderr: "worker exploded\n",
			aborted: false,
		});
	});

	it("ignores malformed and non-event stdout lines while continuing to the final report", async () => {
		const outcome = await createTestRunner().run(request(await createPrompt("malformed")));

		assert.equal(outcome.exitCode, 0);
		assert.equal(outcome.report, "Report after malformed progress.");
		assert.deepEqual(outcome.usage, {
			inputTokens: 10,
			outputTokens: 20,
			cacheReadTokens: 3,
			cacheWriteTokens: 4,
			cost: 0.01,
			contextTokens: 37,
			turns: 1,
		});
		assert.equal(outcome.stderr, "");
		assert.equal(outcome.aborted, false);
	});

	it("escalates an aborted stubborn worker and leaves no orphaned child process", async () => {
		const controller = new AbortController();
		let workerPid: number | undefined;
		const outcome = await createTestRunner(25).run(
			request(await createPrompt("stubborn"), {
				signal: controller.signal,
				onProgress: (progress) => {
					workerPid = Number(progress.report);
					if (workerPid > 0) spawnedPids.add(workerPid);
					controller.abort();
				},
			}),
		);

		assert.ok(workerPid && workerPid > 0, "expected the child to report its pid before aborting");
		assert.equal(outcome.aborted, true);
		assert.equal(outcome.exitCode, undefined);
		assert.equal(processExists(workerPid), false, "expected the aborted child to have exited");
		spawnedPids.delete(workerPid);
	});

	it("returns an aborted outcome without spawning when the supplied signal was already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let invocationCount = 0;
		const runner = createChildProcessWorkerRunner({
			getInvocation: (args) => {
				invocationCount += 1;
				return { command: process.execPath, args: [fakeWorkerPath, ...args] };
			},
		});

		const outcome = await runner.run(request(await createPrompt("normal"), { signal: controller.signal }));

		assert.equal(invocationCount, 0);
		assert.deepEqual(outcome, {
			exitCode: undefined,
			report: "",
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			toolResults: [],
			stopReason: undefined,
			errorMessage: undefined,
			stderr: "",
			aborted: true,
		});
	});
});
