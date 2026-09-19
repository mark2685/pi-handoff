/**
 * Boundary for executing an approved handoff in an isolated worker process.
 *
 * App services depend on this small protocol instead of child-process details,
 * so Gate B can render ordinary outcomes (including worker failures) as values
 * and adapter tests can exercise real pipes without starting the Pi CLI.
 */

import type { ModelChoice } from "../domain/types.ts";

/**
 * The longest a worker may be quiet before the reviewing user is prompted.
 *
 * A quiet Pi can be waiting on a model request or a slow tool, so this is not a
 * kill timeout. The child remains alive until the user presses Escape; the
 * watchdog only reports the stall through the ordinary progress channel.
 */
export const DEFAULT_NO_PROGRESS_THRESHOLD_MS = 10 * 60 * 1_000;

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

/** A tool Pi has begun but not yet reported as finished. */
export interface WorkerActiveTool {
	toolCallId: string;
	toolName: string;
}

/** The worker phase inferred from Pi's live JSON event stream. */
export type WorkerActivityKind =
	"starting" | "thinking" | "writing" | "preparing_tool" | "running_tools" | "finalizing" | "stalled";

/**
 * A human-readable activity category, deliberately separate from the final report.
 *
 * Pi can be silent for a long time during a model request or tool call. The running
 * overlay uses this value together with its last-update age to distinguish a known
 * phase from an absent worker event, without claiming that a silent process is
 * making progress.
 */
export interface WorkerActivity {
	kind: WorkerActivityKind;
	/** Present when Pi named a tool before its execution event arrived. */
	toolName?: string;
}

/** Incremental state sent after a meaningful worker lifecycle event. */
export interface WorkerRunProgress {
	report: string;
	usage: WorkerUsage;
	toolResults: readonly WorkerToolResult[];
	stopReason: string | undefined;
	errorMessage: string | undefined;
	/** Omitted by older runners; the process adapter always supplies it. */
	activity?: WorkerActivity;
	/** Omitted by older runners; populated from tool_execution_start/end events. */
	activeTools?: readonly WorkerActiveTool[];
}

/** Input needed to run one already-approved handoff prompt. */
export interface WorkerRunRequest {
	choice: ModelChoice;
	/** Full prompt-file path, constructed upstream with `buildPromptPath`. */
	promptPath: string;
	cwd: string;
	/**
	 * The quiet interval after which the adapter reports a stalled activity.
	 *
	 * Explicit rather than an adapter-hidden default so the run service and
	 * running overlay describe the same policy, and tests can use a short interval.
	 */
	noProgressThresholdMs: number;
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
