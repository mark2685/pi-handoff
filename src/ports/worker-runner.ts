/**
 * Boundary for executing an approved handoff in an isolated worker process.
 *
 * App services depend on this small protocol instead of child-process details,
 * so Gate B can render ordinary outcomes (including worker failures) as values
 * and adapter tests can exercise real pipes without starting the Pi CLI.
 */

import type { ModelChoice } from "../domain/types.ts";

/** Aggregate usage reported by completed assistant messages from one worker run. */
export interface WorkerUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
	/** The latest context size reported by the worker, rather than a sum across turns. */
	contextTokens: number;
	turns: number;
}

/** A normalized tool result retained for the running widget's recent-activity display. */
export interface WorkerToolResult {
	toolCallId: string;
	toolName: string;
	text: string;
	isError: boolean;
}

/** Incremental state sent synchronously after a worker message or tool result is accumulated. */
export interface WorkerRunProgress {
	report: string;
	usage: WorkerUsage;
	toolResults: readonly WorkerToolResult[];
	stopReason: string | undefined;
	errorMessage: string | undefined;
}

/** Input needed to run one already-approved handoff prompt. */
export interface WorkerRunRequest {
	choice: ModelChoice;
	/** Full prompt-file path, constructed upstream with `buildPromptPath`. */
	promptPath: string;
	cwd: string;
	/** Optional because command-level Ctrl+C routing is owned by the later run service. */
	signal: AbortSignal | undefined;
	onProgress: ((progress: WorkerRunProgress) => void) | undefined;
}

/** Terminal state of a worker process, including expected process failures as ordinary data. */
export interface WorkerRunOutcome {
	/**
	 * Undefined in two cases: an already-aborted request intentionally never
	 * spawned a child, and a spawned child was killed by a signal rather than
	 * exiting on its own. The second case is the ordinary abort path, where
	 * SIGTERM or SIGKILL leaves no exit code to report.
	 */
	exitCode: number | undefined;
	/** The final assistant text, passed through verbatim for Gate B. */
	report: string;
	usage: WorkerUsage;
	toolResults: readonly WorkerToolResult[];
	stopReason: string | undefined;
	errorMessage: string | undefined;
	stderr: string;
	aborted: boolean;
}

/** Runs one isolated worker while leaving the reviewing Pi session untouched. */
export interface WorkerRunner {
	run(request: WorkerRunRequest): Promise<WorkerRunOutcome>;
}
