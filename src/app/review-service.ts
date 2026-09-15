/**
 * Owns what happens at Gate B: accept, the review turn, and the bounded fix loop.
 *
 * These three live together because they are the decisions Gate B offers, and all
 * three have to be testable without a TUI. The command handler above this only
 * renders the gate and reports outcomes.
 *
 * Two behaviors here are correctness requirements rather than conveniences.
 *
 * Accept records the idle state after resetting the machine, exactly as Discard
 * does. Resetting without recording would leave the last persisted entry showing
 * a pending review, so a resumed session would rehydrate an *accepted* handoff
 * back into `reviewing` — and its Discard would then revert work the user had
 * already accepted. The reset and the record are one operation, not two.
 *
 * The iteration bound is enforced here rather than only in the menu. A blocked
 * label is a hint; a service that refuses is the guarantee. `maxIterations` is
 * compared before the prompt file is rewritten and before the machine moves, so a
 * refused iteration leaves no trace on disk or in state.
 *
 * The prompt file is rewritten before the machine transitions, so a write failure
 * leaves the review pending and retryable instead of stranding the machine in
 * `running` with a prompt the worker never received.
 */

import { appendReviewFeedback } from "../domain/draft/feedback.ts";
import { formatModelChoice } from "../domain/draft/launch.ts";
import { buildPromptPath } from "../domain/draft/slug.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Draft, ModelChoice } from "../domain/types.ts";
import type { Clock } from "../ports/clock.ts";
import type { PromptFileWriter, PromptWriteFailure } from "../ports/prompt-file-writer.ts";
import { buildReviewMessage } from "../prompts/review-prompt.ts";
import type { HandoffConflict, HandoffMachine, HandoffReviewingState } from "./handoff-machine.ts";
import type { RunOutcome, RunProgress, RunService } from "./run-service.ts";
import type { HandoffReportRecorder, HandoffStateRecorder } from "./state-recorder.ts";

/** The result of accepting a review, including whether a report was recorded. */
export interface AcceptOutcome {
	/** False for an interrupted run, which has no report to put in the transcript. */
	reportRecorded: boolean;
}

/** Why sending feedback to the worker was refused before anything changed. */
export type FeedbackRefusal =
	/** The rubric's iteration bound is reached, so no further worker run is allowed. */
	| { kind: "bound_reached"; iteration: number; maxIterations: number }
	/** The editor came back empty, so there is nothing to send. */
	| { kind: "empty_feedback" }
	/** The prompt file could not be rewritten, so the machine did not move. */
	| { kind: "write_failed"; failure: PromptWriteFailure }
	/** No pending review exists to iterate on. */
	| { kind: "conflict"; conflict: HandoffConflict };

/** Whether another worker iteration is allowed, and the numbers to explain it. */
export interface FeedbackAllowance {
	allowed: boolean;
	/** The iteration currently under review. */
	iteration: number;
	maxIterations: number;
}

export interface SendFeedbackOptions {
	/** Raw editor text. Blank text is refused before any write. */
	feedback: string;
	cwd: string;
	/** Receives incremental worker progress for the running widget. */
	onProgress?: (progress: RunProgress) => void;
	/** Re-checked immediately before spawning, as on a first run. */
	isChoiceRunnable: (choice: ModelChoice | undefined) => boolean;
}

export interface ReviewServiceDeps {
	machine: HandoffMachine;
	runService: RunService;
	promptWriter: PromptFileWriter;
	reportRecorder: HandoffReportRecorder;
	recorder: HandoffStateRecorder;
	clock: Clock;
	/** The rubric's bound on worker iterations, enforced in `sendFeedback`. */
	maxIterations: number;
}

export interface ReviewService {
	/** Records the accepted report, returns to idle, and persists the reset. */
	accept(): Result<AcceptOutcome, HandoffConflict>;
	/** Arms the one `agent_end` that Review here is allowed to act on. */
	beginReview(): Result<HandoffReviewingState, HandoffConflict>;
	/** Disarms the review turn, which `agent_end` must do before opening a gate. */
	clearReview(): Result<HandoffReviewingState, HandoffConflict>;
	/** Builds the text Review here injects into the reviewing session. */
	buildReviewMessage(state: HandoffReviewingState): string;
	/** Reports whether another iteration is allowed, for the menu's label. */
	feedbackAllowance(): FeedbackAllowance | undefined;
	/** Appends feedback, rewrites the prompt, and runs the next iteration. */
	sendFeedback(options: SendFeedbackOptions): Promise<Result<RunOutcome, FeedbackRefusal>>;
}

/** Wires Gate B's decisions to the machine, the run service, and their ports. */
export function createReviewService(deps: ReviewServiceDeps): ReviewService {
	const { machine, runService, promptWriter, reportRecorder, recorder, clock, maxIterations } = deps;

	/** Persists the machine's current state so a resumed session can recover it. */
	function record(): void {
		recorder.record(machine.current());
	}

	/** Builds the conflict returned when an operation needs a pending review and has none. */
	function noReview(attempted: string): HandoffConflict {
		return {
			kind: "conflict",
			current: machine.current().kind,
			attempted,
			message: "No pending review is available",
		};
	}

	return {
		accept(): Result<AcceptOutcome, HandoffConflict> {
			const reviewing = machine.reviewing();
			if (reviewing === undefined) return err(noReview("accept"));

			// An interrupted run has no report; recording a null one would put an empty
			// accepted result in the transcript as though the worker had reported nothing.
			const reportRecorded = reviewing.report !== null;
			if (reviewing.report !== null) {
				reportRecorder.record({
					slug: reviewing.draft.slug,
					model: formatModelChoice(reviewing.choice),
					iteration: reviewing.iteration,
					report: reviewing.report,
					diffstat: reviewing.diffstat,
					acceptedAt: clock.nowIso(),
				});
			}

			// The record is not optional: see the module header on why an unrecorded
			// reset would let a resumed session discard accepted work.
			machine.reset();
			record();
			return ok({ reportRecorded });
		},

		beginReview(): Result<HandoffReviewingState, HandoffConflict> {
			const armed = machine.beginReviewTurn();
			if (!armed.ok) return err(armed.error);
			record();
			return ok(armed.value);
		},

		clearReview(): Result<HandoffReviewingState, HandoffConflict> {
			const cleared = machine.clearReviewTurn();
			if (!cleared.ok) return err(cleared.error);
			record();
			return ok(cleared.value);
		},

		buildReviewMessage(state: HandoffReviewingState): string {
			return buildReviewMessage({
				slug: state.draft.slug,
				promptPath: buildPromptPath(state.draft.slug),
				prompt: state.draft.prompt,
				iteration: state.iteration,
				model: formatModelChoice(state.choice),
				report: state.report,
				diffstat: state.diffstat ?? "",
				interruptionNote: state.completion === "interrupted" ? state.interruptionNote : undefined,
			});
		},

		feedbackAllowance(): FeedbackAllowance | undefined {
			const reviewing = machine.reviewing();
			if (reviewing === undefined) return undefined;
			return {
				allowed: reviewing.iteration < maxIterations,
				iteration: reviewing.iteration,
				maxIterations,
			};
		},

		async sendFeedback(options: SendFeedbackOptions): Promise<Result<RunOutcome, FeedbackRefusal>> {
			const reviewing = machine.reviewing();
			if (reviewing === undefined) return err({ kind: "conflict", conflict: noReview("sendFeedback") });

			// Checked before the write and before the transition, so a refusal changes nothing.
			if (reviewing.iteration >= maxIterations) {
				return err({ kind: "bound_reached", iteration: reviewing.iteration, maxIterations });
			}

			const feedback = options.feedback.trim();
			if (feedback === "") return err({ kind: "empty_feedback" });

			const iteration = reviewing.iteration + 1;
			const prompt = appendReviewFeedback(reviewing.draft.prompt, feedback, iteration);
			const promptPath = buildPromptPath(reviewing.draft.slug);

			// The worker reads the file, so the file is the source of truth: it is rewritten
			// before the machine moves, and a failure leaves the review pending.
			const written = await promptWriter.write(promptPath, prompt);
			if (!written.ok) return err({ kind: "write_failed", failure: written.error });

			const draft: Draft = { ...reviewing.draft, prompt };
			const outcome = await runService.restart({
				promptPath,
				cwd: options.cwd,
				iteration,
				draft,
				isChoiceRunnable: options.isChoiceRunnable,
				...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
			});
			return ok(outcome);
		},
	};
}
