/**
 * Runs an approved handoff in an isolated worker and prepares Gate B.
 *
 * This service owns the ordering that makes a run safe, and the order is the
 * point. The model is re-checked against the live registry, then the checkpoint
 * is taken, and only then is a child spawned. Both checks precede the spawn
 * because a refusal after a worker has started editing the tree is not a
 * refusal — it is a half-finished run with no record of how to undo it.
 *
 * It also owns the abort seam. Pi's command context carries no abort signal for
 * this phase (`ExtensionContext.signal` is undefined when the agent is not
 * streaming, which is exactly the case here, since the command awaits the child
 * directly), so nothing external can stop the worker. This service therefore
 * creates the `AbortController` for each run and exposes `abortActiveRun`, which
 * is the single mechanism that stops a worker: the running widget calls it on
 * Escape, and `session_shutdown` calls it so a child can never outlive the
 * reviewing session. Because a kill is SIGTERM then SIGKILL after a grace period,
 * `abortActiveRun` only requests the death; `whenSettled` is the seam a shutdown
 * hook awaits to know the child is actually gone.
 *
 * The live-registry check is a per-call option rather than a constructor
 * dependency. This service is built once per session so `session_shutdown` and a
 * reopened Gate B can reach it, while the registry must still be read at the
 * moment of a click; passing the check in keeps the session-scoped object from
 * capturing a stale view of which models exist.
 *
 * A run that produces no report never fabricates one. An abort, a spawn failure,
 * and a worker that exits non-zero with nothing to show all reach `reviewing`
 * with `completion: "interrupted"` and a note, keeping the checkpoint available
 * so Discard can still undo whatever the worker managed to write.
 *
 * An abort is interrupted even when the worker had already streamed assistant
 * text. A killed worker's partial output is not a result, and treating it as one
 * would put an abandoned half-report in front of the reviewer as though the run
 * had finished.
 *
 * A restart reuses the checkpoint taken before iteration 1 rather than taking a
 * new one. That is what keeps Discard able to undo every iteration at once and
 * keeps Gate B's diffstat cumulative; a fresh checkpoint per iteration would
 * silently strand earlier iterations' edits outside Discard's reach.
 */

import { err, ok, type Result } from "../domain/result.ts";
import type { Checkpoint, Draft, ModelChoice } from "../domain/types.ts";
import type { Clock } from "../ports/clock.ts";
import type { Git, GitFailure } from "../ports/git.ts";
import type { WorkerRunProgress, WorkerRunner } from "../ports/worker-runner.ts";
import type {
	HandoffCompletedReviewingState,
	HandoffConflict,
	HandoffInterruptedReviewingState,
	HandoffMachine,
} from "./handoff-machine.ts";
import type { HandoffStateRecorder } from "./state-recorder.ts";

/** The worker finished and produced a report for Gate B. */
export interface RunCompleted {
	kind: "completed";
	state: HandoffCompletedReviewingState;
	/** Undefined when the worker was killed by a signal rather than exiting. */
	exitCode: number | undefined;
	/** Present when the diffstat could not be read, so Gate B can say so. */
	diffstatFailure: GitFailure | undefined;
}

/** The worker produced no usable report, so no report is invented. */
export interface RunInterrupted {
	kind: "interrupted";
	state: HandoffInterruptedReviewingState;
	/** Diffstat read after the fact, because the interrupted state stores none. */
	diffstat: string;
	diffstatFailure: GitFailure | undefined;
	exitCode: number | undefined;
	/** True when the run ended because someone aborted it, rather than failing. */
	aborted: boolean;
	stderr: string;
}

/** The chosen model was gone from the live registry at spawn time. */
export interface RunModelUnavailable {
	kind: "model_unavailable";
	choice: ModelChoice;
}

/** The checkpoint could not be taken, so nothing was spawned. */
export interface RunCheckpointFailed {
	kind: "checkpoint_failed";
	failure: GitFailure;
}

/** The machine refused the transition, so nothing was spawned. */
export interface RunRefused {
	kind: "refused";
	conflict: HandoffConflict;
}

export type RunOutcome = RunCompleted | RunInterrupted | RunModelUnavailable | RunCheckpointFailed | RunRefused;

/** Progress forwarded to the running widget, with the elapsed reading it displays. */
export interface RunProgress extends WorkerRunProgress {
	/** Milliseconds since the run started, measured on the injected clock. */
	elapsedMs: number;
}

export interface StartRunOptions {
	/** The approved prompt file, passed in rather than re-derived from the slug. */
	promptPath: string;
	/** Working directory for both the checkpoint and the worker. */
	cwd: string;
	/**
	 * Re-checked immediately before spawning, not when the gate opened.
	 *
	 * Supplied per call because this service outlives any one invocation, and a
	 * captured registry view could approve a provider that has since disappeared.
	 */
	isChoiceRunnable: (choice: ModelChoice | undefined) => boolean;
	/** Receives incremental worker progress for the running widget. */
	onProgress?: (progress: RunProgress) => void;
}

export interface RestartRunOptions extends StartRunOptions {
	/** Which iteration this run is. The caller enforces the rubric's bound. */
	iteration: number;
	/** The draft whose prompt already carries the appended feedback on disk. */
	draft: Draft;
}

/** Outcome of discarding a worker's changes back to the checkpoint. */
export interface DiscardResult {
	restoredPaths: string[];
	removedPaths: string[];
	/**
	 * Paths left untouched because they were already dirty at checkpoint time.
	 *
	 * A worker edit to one of these survives Discard. Callers must show this, or
	 * the user will read "Discard" as "undo everything" and be wrong about it.
	 */
	skippedPaths: string[];
}

export interface RunServiceDeps {
	machine: HandoffMachine;
	runner: WorkerRunner;
	git: Git;
	clock: Clock;
	recorder: HandoffStateRecorder;
}

export interface RunService {
	/** Re-checks the model, checkpoints, spawns the worker, and prepares Gate B. */
	start(options: StartRunOptions): Promise<RunOutcome>;
	/**
	 * Runs another iteration against the review's existing checkpoint.
	 *
	 * No new checkpoint is taken, so Discard still reverts every iteration and the
	 * diffstat stays cumulative across the feedback loop.
	 */
	restart(options: RestartRunOptions): Promise<RunOutcome>;
	/**
	 * Stops the active worker, if any, and reports whether one was stopped.
	 *
	 * This is the kill seam. It is the only way a worker is stopped, and it only
	 * *requests* the death: the adapter sends SIGTERM and then SIGKILL after a grace
	 * period, so a caller that needs the child to be gone must await `whenSettled`.
	 */
	abortActiveRun(): boolean;
	/** True while a child is running, so a shutdown hook can decide to wait. */
	isRunning(): boolean;
	/**
	 * Resolves once no worker is in flight, rejecting never.
	 *
	 * `session_shutdown` awaits this after `abortActiveRun` so Pi does not tear the
	 * session down while a child is still writing to the working tree.
	 */
	whenSettled(): Promise<void>;
	/** Reverts only paths that were clean when the run's checkpoint was taken. */
	discard(cwd: string): Promise<Result<DiscardResult, GitFailure | HandoffConflict>>;
	/** Reads the diffstat for the active review against its checkpoint. */
	diffstat(cwd: string): Promise<Result<string, GitFailure | HandoffConflict>>;
}

/**
 * Builds the note recorded when a run ends without a usable report.
 *
 * A partial report is called out rather than silently dropped, because the user
 * saw text appear in the widget and would otherwise wonder where it went.
 */
function interruptionNote(reason: {
	aborted: boolean;
	hadPartialReport: boolean;
	exitCode: number | undefined;
	errorMessage: string | undefined;
	stopReason: string | undefined;
}): string {
	if (reason.aborted) {
		return reason.hadPartialReport
			? "The worker was stopped mid-run. Its partial output is not treated as a report."
			: "The worker was stopped before it reported a result.";
	}
	if (reason.errorMessage !== undefined) return `The worker failed: ${reason.errorMessage}`;
	if (reason.exitCode !== undefined && reason.exitCode !== 0) {
		return `The worker exited with code ${reason.exitCode} without producing a report.`;
	}
	if (reason.stopReason !== undefined) {
		return `The worker stopped (${reason.stopReason}) without producing a report.`;
	}
	return "The worker produced no report.";
}

/** Wires a worker run to the machine, Git, and the clock behind their ports. */
export function createRunService(deps: RunServiceDeps): RunService {
	const { machine, runner, git, clock, recorder } = deps;

	/** The controller for the run in flight, and the reason a caller can stop it. */
	let activeController: AbortController | undefined;

	/**
	 * The run in flight, so a shutdown hook can await the child's actual death.
	 *
	 * Held separately from the controller because aborting only requests the kill:
	 * the adapter still has to escalate SIGTERM to SIGKILL, and the promise is the
	 * only thing that knows when that finished.
	 */
	let activeRun: Promise<RunOutcome> | undefined;

	/** Persists the machine's current state so a resumed session can recover it. */
	function record(): void {
		recorder.record(machine.current());
	}

	/** Reads the checkpoint of whichever state currently owns one. */
	function activeCheckpoint(): Checkpoint | undefined {
		return machine.running()?.checkpoint ?? machine.reviewing()?.checkpoint;
	}

	/** Reads the diffstat, treating a failure as data so a run still reaches Gate B. */
	async function readDiffstat(
		cwd: string,
		checkpoint: Checkpoint,
	): Promise<{ diffstat: string; failure: GitFailure | undefined }> {
		const result = await git.diffstat(cwd, checkpoint);
		return result.ok ? { diffstat: result.value, failure: undefined } : { diffstat: "", failure: result.error };
	}

	/**
	 * Spawns the worker for an already-running machine state and resolves Gate B's outcome.
	 *
	 * Shared by `start` and `restart` so an iteration reached through feedback gets
	 * exactly the same completion, abort, and failure handling as the first run. It
	 * assumes the machine has already transitioned and been recorded, because the
	 * transition is the part the two entry points legitimately differ on.
	 */
	async function spawnAndSettle(input: {
		choice: ModelChoice;
		promptPath: string;
		cwd: string;
		checkpoint: Checkpoint;
		onProgress: ((progress: RunProgress) => void) | undefined;
	}): Promise<RunOutcome> {
		const startedAtMs = clock.nowMs();
		const controller = new AbortController();
		activeController = controller;

		try {
			const outcome = await runner.run({
				choice: input.choice,
				promptPath: input.promptPath,
				cwd: input.cwd,
				signal: controller.signal,
				onProgress:
					input.onProgress === undefined
						? undefined
						: (progress) => {
								input.onProgress?.({ ...progress, elapsedMs: clock.nowMs() - startedAtMs });
							},
			});

			const report = outcome.report.trim();

			// An aborted run is interrupted even if the worker emitted text first: partial
			// output is not a result, and presenting it as one would let a killed worker
			// reach Gate B as a finished report. An empty report is likewise never dressed
			// up as a completed review.
			if (outcome.aborted || report === "") {
				const note = interruptionNote({
					aborted: outcome.aborted,
					hadPartialReport: report !== "",
					exitCode: outcome.exitCode,
					errorMessage: outcome.errorMessage,
					stopReason: outcome.stopReason,
				});
				const interrupted = machine.interruptRun(note);
				if (!interrupted.ok) return { kind: "refused", conflict: interrupted.error };
				record();
				const { diffstat, failure } = await readDiffstat(input.cwd, input.checkpoint);
				return {
					kind: "interrupted",
					state: interrupted.value,
					diffstat,
					diffstatFailure: failure,
					exitCode: outcome.exitCode,
					aborted: outcome.aborted,
					stderr: outcome.stderr,
				};
			}

			const { diffstat, failure } = await readDiffstat(input.cwd, input.checkpoint);
			const completed = machine.completeRun({
				report: outcome.report,
				diffstat,
				usage: outcome.usage,
			});
			if (!completed.ok) return { kind: "refused", conflict: completed.error };
			record();
			return {
				kind: "completed",
				state: completed.value,
				exitCode: outcome.exitCode,
				diffstatFailure: failure,
			};
		} finally {
			activeController = undefined;
		}
	}

	/** Tracks a run so `whenSettled` can await the child's death, then clears it. */
	async function track(run: Promise<RunOutcome>): Promise<RunOutcome> {
		activeRun = run;
		try {
			return await run;
		} finally {
			activeRun = undefined;
		}
	}

	return {
		async start(options: StartRunOptions): Promise<RunOutcome> {
			const proposed = machine.current();
			if (proposed.kind !== "proposed") {
				return {
					kind: "refused",
					conflict: {
						kind: "conflict",
						current: proposed.kind,
						attempted: "start",
						message: "A worker can start only from an approved handoff proposal",
					},
				};
			}

			// Re-checked here, not at Gate A: a provider can disappear while the gate sits open.
			const choice = proposed.choice;
			if (!options.isChoiceRunnable(choice)) return { kind: "model_unavailable", choice };

			// The checkpoint precedes the spawn so Discard always has a boundary to revert to.
			const checkpoint = await git.checkpoint(options.cwd);
			if (!checkpoint.ok) return { kind: "checkpoint_failed", failure: checkpoint.error };

			const started = machine.startRun({
				iteration: 1,
				startedAt: clock.nowIso(),
				checkpoint: checkpoint.value,
			});
			if (!started.ok) return { kind: "refused", conflict: started.error };
			record();

			return track(
				spawnAndSettle({
					choice,
					promptPath: options.promptPath,
					cwd: options.cwd,
					checkpoint: checkpoint.value,
					onProgress: options.onProgress,
				}),
			);
		},

		async restart(options: RestartRunOptions): Promise<RunOutcome> {
			const reviewing = machine.reviewing();
			if (reviewing === undefined) {
				return {
					kind: "refused",
					conflict: {
						kind: "conflict",
						current: machine.current().kind,
						attempted: "restart",
						message: "Worker feedback can be sent only while a review is pending",
					},
				};
			}

			// Re-checked for the same reason as the first run: the gate may have sat open.
			const choice = reviewing.choice;
			if (!options.isChoiceRunnable(choice)) return { kind: "model_unavailable", choice };

			// Deliberately the review's existing checkpoint: see the module header.
			const checkpoint = reviewing.checkpoint;
			const restarted = machine.restartRun({
				draft: options.draft,
				choice,
				iteration: options.iteration,
				startedAt: clock.nowIso(),
				checkpoint,
			});
			if (!restarted.ok) return { kind: "refused", conflict: restarted.error };
			record();

			return track(
				spawnAndSettle({
					choice,
					promptPath: options.promptPath,
					cwd: options.cwd,
					checkpoint,
					onProgress: options.onProgress,
				}),
			);
		},

		abortActiveRun(): boolean {
			if (activeController === undefined) return false;
			activeController.abort();
			return true;
		},

		isRunning(): boolean {
			return activeController !== undefined;
		},

		async whenSettled(): Promise<void> {
			// A rejection is the caller's problem to observe on its own call, not a reason
			// to fail a shutdown hook that only needs to know the child is gone.
			await activeRun?.catch(() => undefined);
		},

		async discard(cwd: string): Promise<Result<DiscardResult, GitFailure | HandoffConflict>> {
			const checkpoint = activeCheckpoint();
			if (checkpoint === undefined) {
				return err({
					kind: "conflict",
					current: machine.current().kind,
					attempted: "discard",
					message: "No checkpointed handoff is available to discard",
				});
			}

			const discarded = await git.discardSinceCheckpoint(cwd, checkpoint);
			if (!discarded.ok) return err(discarded.error);

			machine.reset();
			record();
			return ok({
				restoredPaths: discarded.value.restoredPaths,
				removedPaths: discarded.value.removedPaths,
				skippedPaths: discarded.value.skippedPaths,
			});
		},

		async diffstat(cwd: string): Promise<Result<string, GitFailure | HandoffConflict>> {
			const checkpoint = activeCheckpoint();
			if (checkpoint === undefined) {
				return err({
					kind: "conflict",
					current: machine.current().kind,
					attempted: "diffstat",
					message: "No checkpointed handoff is available to diff",
				});
			}
			const result = await git.diffstat(cwd, checkpoint);
			return result.ok ? ok(result.value) : err(result.error);
		},
	};
}
