/**
 * Ownership of the one handoff that may be active in a reviewing session.
 *
 * This is a discriminated union rather than independent drafting, running, and
 * review flags. Independent flags make it possible for stale drafting behavior
 * to coexist with a live worker, the same class of conflict that previously
 * let Phase Runner inject read-only planner behavior into an implementation
 * session. Named transitions keep those phases mutually exclusive.
 *
 * The app layer owns this state because a completed review includes WorkerUsage,
 * which is a process-boundary protocol type from the worker port. The pure
 * machine never performs IO or retains a child-process handle.
 */

import { err, ok, type Result } from "../domain/result.ts";
import type { Checkpoint, Draft, ModelChoice } from "../domain/types.ts";
import type { CapturedReview } from "../domain/review.ts";
import { validateHandoffState } from "../persistence/schemas.ts";
import type { WorkerUsage } from "../ports/worker-runner.ts";

/** Namespaced custom-session entry used to persist the active handoff state. */
export const HANDOFF_STATE_ENTRY_TYPE = "handoff-state";

export interface HandoffIdleState {
	readonly kind: "idle";
}

export interface HandoffDraftingState {
	readonly kind: "drafting";
	readonly scope: string;
	/** Retained only while user decisions are open, so a resumed session can reopen their gate. */
	readonly pendingDraft?: { draft: Draft; promptPath: string };
	/**
	 * Which NEEDS INPUT round this is, counted from 1.
	 *
	 * Persisted so the count survives a restart, and optional so entries written
	 * before it existed still decode as the first round. It exists to make repeated
	 * questioning visible: the gate offers to take the model's own recommendations
	 * once this reaches `PROCEED_WITH_RECOMMENDED_ROUND`.
	 */
	readonly needsInputRound?: number;
}

export interface HandoffProposedState {
	readonly kind: "proposed";
	readonly draft: Draft;
	readonly choice: ModelChoice;
}

export interface HandoffRunningState {
	readonly kind: "running";
	readonly draft: Draft;
	readonly choice: ModelChoice;
	readonly iteration: number;
	readonly startedAt: string;
	readonly checkpoint: Checkpoint;
	/**
	 * True when the worker is running in another terminal rather than as a child.
	 *
	 * Modelled as a discriminator on `running` rather than as a fourth state kind,
	 * because everything that makes `running` what it is — a draft, a chosen model, an
	 * iteration, and above all a checkpoint Discard can return to — is equally true of
	 * an external run. A separate kind would have to restate all of it and would
	 * double every transition that reads a checkpoint. What differs is only that no
	 * child process exists, which matters in exactly two places: `session_shutdown`
	 * has nothing to kill, and a restart must not downgrade the run to an interrupted
	 * review, because the terminal running it is unaffected by this session dying.
	 *
	 * Optional so entries written before external runs were recorded still decode.
	 */
	readonly external?: boolean;
	/**
	 * True when the user chose "Run and review", so a completed run injects the
	 * review turn without a second click.
	 *
	 * Persisted on the run rather than held in the command handler so the intent
	 * survives a session restart mid-run, and optional for backward compatibility.
	 */
	readonly autoReview?: boolean;
}

/** A worker completed normally, so Gate B may render its report and metrics. */
export interface HandoffCompletedReviewingState {
	readonly kind: "reviewing";
	readonly completion: "completed";
	readonly draft: Draft;
	readonly choice: ModelChoice;
	readonly iteration: number;
	readonly checkpoint: Checkpoint;
	readonly report: string;
	readonly diffstat: string;
	/**
	 * Null when the run had no child process to measure — an external run.
	 *
	 * Distinct from zeroed usage, which would claim a worker ran for free. Gate B and
	 * the usage formatter both render the absence as a sentence instead.
	 */
	readonly usage: WorkerUsage | null;
	/** True when the report was pasted in after an external run rather than captured. */
	readonly external?: boolean;
	/** Carried from the run so a restart mid-run does not lose Run and review's intent. */
	readonly autoReview?: boolean;
	/** The final response captured from Review here, when this iteration was reviewed. */
	readonly review?: CapturedReview;
	readonly awaitingReviewTurn: boolean;
}

/**
 * A Pi restart, an abort, or a worker failure ended a run before its result could
 * be collected. Null review fields deliberately mean unavailable, never "an empty
 * worker response".
 *
 * `partialReport` and `stderrTail` are the crash evidence. A worker that dies
 * mid-task has usually already streamed assistant text, and that text is not a
 * report: showing it as one is how a mid-task sentence once reached a reviewer as
 * though it were a finished result. It is retained here so Gate B and the review
 * turn can show it *labelled as pre-crash output*, which is a different claim from
 * `report`. Both fields are optional so older entries still decode.
 */
export interface HandoffInterruptedReviewingState {
	readonly kind: "reviewing";
	readonly completion: "interrupted";
	readonly draft: Draft;
	readonly choice: ModelChoice;
	readonly iteration: number;
	readonly checkpoint: Checkpoint;
	readonly report: null;
	readonly diffstat: null;
	readonly usage: null;
	readonly interruptionNote: string;
	/** Assistant text the worker emitted before it died. Never a report. */
	readonly partialReport?: string;
	/** Bounded tail of the worker's stderr, which usually names the real failure. */
	readonly stderrTail?: string;
	/** Present only if a reviewer response was captured before the interrupted review was reopened. */
	readonly review?: CapturedReview;
	readonly awaitingReviewTurn: boolean;
}

export type HandoffReviewingState = HandoffCompletedReviewingState | HandoffInterruptedReviewingState;

export type HandoffState =
	HandoffIdleState | HandoffDraftingState | HandoffProposedState | HandoffRunningState | HandoffReviewingState;

/** Why a requested handoff transition was refused. */
export interface HandoffConflict {
	kind: "conflict";
	/** The handoff state that is currently active. */
	current: HandoffState["kind"];
	/** The named transition that was attempted. */
	attempted: string;
	/** Message suitable for showing directly to the user. */
	message: string;
}

export interface StartRunInput {
	iteration: number;
	startedAt: string;
	checkpoint: Checkpoint;
	/** True for a run the user launched in another terminal. */
	external?: boolean;
	/** True when a completed run should inject the review turn without another click. */
	autoReview?: boolean;
}

export interface RestartRunInput extends StartRunInput {
	draft: Draft;
	choice: ModelChoice;
}

export interface CompleteRunInput {
	report: string;
	diffstat: string;
	/** Null for an external run, which has no child process to measure. */
	usage: WorkerUsage | null;
}

/** Why a run ended without a usable report, plus whatever evidence it left behind. */
export interface InterruptRunInput {
	/** Human-readable reason, shown at Gate B and in the review turn. */
	note: string;
	/** Assistant text emitted before the worker died, if any. Never treated as a report. */
	partialReport?: string;
	/** Bounded tail of the worker's stderr, if any. */
	stderrTail?: string;
}

/** A structurally compatible view of Pi's persisted custom session entries. */
export interface HandoffSessionEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

const IDLE: HandoffIdleState = { kind: "idle" };
const INTERRUPTED_WORKER_NOTE = "The worker was interrupted because this Pi session restarted.";

export interface HandoffMachine {
	/** The only active handoff state. */
	current(): HandoffState;
	/** The active draft, or undefined while idle or only drafting. */
	draft(): Draft | undefined;
	/** The selected model, or undefined before Gate A has proposed one. */
	choice(): ModelChoice | undefined;
	/** The active worker run, or undefined unless the worker is running. */
	running(): HandoffRunningState | undefined;
	/** The pending Gate B state, or undefined outside review. */
	reviewing(): HandoffReviewingState | undefined;
	/** Begins drafting from an idle session. */
	beginDraft(scope: string): Result<HandoffDraftingState, HandoffConflict>;
	/** Replaces the scope while a retry remains in the drafting phase. */
	replaceDraftScope(scope: string): Result<HandoffDraftingState, HandoffConflict>;
	/** Persists a NEEDS INPUT draft while the user decides how to resolve it. */
	setPendingDraft(pendingDraft: { draft: Draft; promptPath: string }): Result<HandoffDraftingState, HandoffConflict>;
	/** Records that another NEEDS INPUT round has opened, so the gate can offer to end it. */
	beginNeedsInputRound(): Result<HandoffDraftingState, HandoffConflict>;
	/** The current NEEDS INPUT round, counted from 1. */
	needsInputRound(): number;
	/** Clears a prior needs-input round before a re-draft resolves it. */
	clearPendingDraft(): Result<HandoffDraftingState, HandoffConflict>;
	/** Records Gate A's draft and chosen worker model. */
	propose(draft: Draft, choice: ModelChoice): Result<HandoffProposedState, HandoffConflict>;
	/** Replaces the editable draft before Gate A runs it. */
	updateProposal(draft: Draft, choice: ModelChoice): Result<HandoffProposedState, HandoffConflict>;
	/** Captures a checkpoint and begins the first approved worker run. */
	startRun(input: StartRunInput): Result<HandoffRunningState, HandoffConflict>;
	/** Returns from Gate B to a worker run after feedback changed the prompt. */
	restartRun(input: RestartRunInput): Result<HandoffRunningState, HandoffConflict>;
	/** Records the completed worker result for Gate B. */
	completeRun(input: CompleteRunInput): Result<HandoffCompletedReviewingState, HandoffConflict>;
	/**
	 * Ends a run that produced no usable report, preserving the checkpoint.
	 *
	 * This is the abort and worker-failure path. It reaches `reviewing` rather than
	 * `idle` because the worker may already have edited the tree, and Discard needs
	 * the checkpoint to undo that; returning to `idle` would strand those edits with
	 * no safe way to revert them.
	 *
	 * Accepts a plain note for callers that have only a reason, or an input object
	 * when crash evidence (pre-crash text, stderr) is available to retain.
	 */
	interruptRun(input: string | InterruptRunInput): Result<HandoffInterruptedReviewingState, HandoffConflict>;
	/** Arms the one `agent_end` event caused by Review here. */
	beginReviewTurn(): Result<HandoffCompletedReviewingState, HandoffConflict>;
	/** Clears the Review here arm and records the response that caused Gate B to reopen. */
	clearReviewTurn(review?: CapturedReview): Result<HandoffReviewingState, HandoffConflict>;
	/** Replaces in-memory state with decoded, rehydrated persisted state. */
	restore(state: HandoffState): void;
	/** Returns to idle after Cancel, Accept, Discard, or a terminal failure. */
	reset(): void;
}

function conflict(state: HandoffState, attempted: string, message: string): Result<never, HandoffConflict> {
	return err({ kind: "conflict", current: state.kind, attempted, message });
}

/** Makes a mutable controller around an immutable discriminated handoff state. */
export function createHandoffMachine(): HandoffMachine {
	let state: HandoffState = IDLE;

	return {
		current: () => state,

		draft: () => {
			switch (state.kind) {
				case "idle":
				case "drafting":
					return undefined;
				case "proposed":
				case "running":
				case "reviewing":
					return state.draft;
				default:
					return assertNever(state);
			}
		},

		choice: () => {
			switch (state.kind) {
				case "idle":
				case "drafting":
					return undefined;
				case "proposed":
				case "running":
				case "reviewing":
					return state.choice;
				default:
					return assertNever(state);
			}
		},

		running: () => (state.kind === "running" ? state : undefined),

		reviewing: () => (state.kind === "reviewing" ? state : undefined),

		beginDraft(scope: string): Result<HandoffDraftingState, HandoffConflict> {
			if (state.kind !== "idle") {
				const message =
					state.kind === "reviewing"
						? "Discard or accept the pending review before starting a new handoff"
						: `Cannot start a handoff while it is ${state.kind}`;
				return conflict(state, "beginDraft", message);
			}
			const drafting: HandoffDraftingState = { kind: "drafting", scope };
			state = drafting;
			return ok(drafting);
		},

		replaceDraftScope(scope: string): Result<HandoffDraftingState, HandoffConflict> {
			if (state.kind !== "drafting") {
				return conflict(state, "replaceDraftScope", "A draft scope can be replaced only while drafting");
			}
			const drafting: HandoffDraftingState = { ...state, scope };
			state = drafting;
			return ok(drafting);
		},

		setPendingDraft(pendingDraft: { draft: Draft; promptPath: string }): Result<HandoffDraftingState, HandoffConflict> {
			if (state.kind !== "drafting") {
				return conflict(state, "setPendingDraft", "A pending draft can be retained only while drafting");
			}
			const drafting: HandoffDraftingState = { ...state, pendingDraft };
			state = drafting;
			return ok(drafting);
		},

		beginNeedsInputRound(): Result<HandoffDraftingState, HandoffConflict> {
			if (state.kind !== "drafting") {
				return conflict(state, "beginNeedsInputRound", "A needs-input round can open only while drafting");
			}
			// An older entry carries no counter, but a retained envelope is itself evidence that
			// a round was already asked, so resuming one continues the count instead of
			// restarting it and under-reporting how long the questioning has gone on.
			const asked = state.needsInputRound ?? (state.pendingDraft === undefined ? 0 : 1);
			const drafting: HandoffDraftingState = { ...state, needsInputRound: asked + 1 };
			state = drafting;
			return ok(drafting);
		},

		needsInputRound(): number {
			return state.kind === "drafting" ? (state.needsInputRound ?? 1) : 1;
		},

		clearPendingDraft(): Result<HandoffDraftingState, HandoffConflict> {
			if (state.kind !== "drafting") {
				return conflict(state, "clearPendingDraft", "A pending draft can be cleared only while drafting");
			}
			// The round counter deliberately survives: it counts rounds asked in this
			// drafting phase, and clearing the envelope is how each round ends.
			const drafting: HandoffDraftingState = {
				kind: "drafting",
				scope: state.scope,
				...(state.needsInputRound === undefined ? {} : { needsInputRound: state.needsInputRound }),
			};
			state = drafting;
			return ok(drafting);
		},

		propose(draft: Draft, choice: ModelChoice): Result<HandoffProposedState, HandoffConflict> {
			if (state.kind !== "drafting") {
				return conflict(state, "propose", "A handoff must be drafting before it can be proposed");
			}
			const proposed: HandoffProposedState = { kind: "proposed", draft, choice };
			state = proposed;
			return ok(proposed);
		},

		updateProposal(draft: Draft, choice: ModelChoice): Result<HandoffProposedState, HandoffConflict> {
			if (state.kind !== "proposed") {
				return conflict(state, "updateProposal", "No proposed handoff is available to update");
			}
			const proposed: HandoffProposedState = { kind: "proposed", draft, choice };
			state = proposed;
			return ok(proposed);
		},

		startRun(input: StartRunInput): Result<HandoffRunningState, HandoffConflict> {
			if (state.kind !== "proposed") {
				return conflict(state, "startRun", "A worker can start only from an approved handoff proposal");
			}
			const running: HandoffRunningState = {
				kind: "running",
				draft: state.draft,
				choice: state.choice,
				iteration: input.iteration,
				startedAt: input.startedAt,
				checkpoint: input.checkpoint,
				// Omitted unless true, so an ordinary run's entry is unchanged from before.
				...(input.external === true ? { external: true } : {}),
				...(input.autoReview === true ? { autoReview: true } : {}),
			};
			state = running;
			return ok(running);
		},

		restartRun(input: RestartRunInput): Result<HandoffRunningState, HandoffConflict> {
			if (state.kind !== "reviewing") {
				return conflict(state, "restartRun", "Worker feedback can be sent only while a review is pending");
			}
			const running: HandoffRunningState = {
				kind: "running",
				draft: input.draft,
				choice: input.choice,
				iteration: input.iteration,
				startedAt: input.startedAt,
				checkpoint: input.checkpoint,
			};
			state = running;
			return ok(running);
		},

		completeRun(input: CompleteRunInput): Result<HandoffCompletedReviewingState, HandoffConflict> {
			if (state.kind !== "running") {
				return conflict(state, "completeRun", "No worker run is active to complete");
			}
			const reviewing: HandoffCompletedReviewingState = {
				kind: "reviewing",
				completion: "completed",
				draft: state.draft,
				choice: state.choice,
				iteration: state.iteration,
				checkpoint: state.checkpoint,
				...input,
				// Carried across the transition: Gate B needs to know the report was pasted in,
				// and Run and review's intent has to outlive the run it was chosen on.
				...(state.external === true ? { external: true } : {}),
				...(state.autoReview === true ? { autoReview: true } : {}),
				awaitingReviewTurn: false,
			};
			state = reviewing;
			return ok(reviewing);
		},

		interruptRun(input: string | InterruptRunInput): Result<HandoffInterruptedReviewingState, HandoffConflict> {
			if (state.kind !== "running") {
				return conflict(state, "interruptRun", "No worker run is active to interrupt");
			}
			const details: InterruptRunInput = typeof input === "string" ? { note: input } : input;
			const partialReport = details.partialReport?.trim();
			const stderrTail = details.stderrTail?.trim();
			const reviewing: HandoffInterruptedReviewingState = {
				kind: "reviewing",
				completion: "interrupted",
				draft: state.draft,
				choice: state.choice,
				iteration: state.iteration,
				checkpoint: state.checkpoint,
				report: null,
				diffstat: null,
				usage: null,
				interruptionNote: details.note,
				// Omitted rather than stored empty, so "absent" and "the worker said nothing" stay distinct.
				...(partialReport === undefined || partialReport === "" ? {} : { partialReport }),
				...(stderrTail === undefined || stderrTail === "" ? {} : { stderrTail }),
				awaitingReviewTurn: false,
			};
			state = reviewing;
			return ok(reviewing);
		},

		beginReviewTurn(): Result<HandoffCompletedReviewingState, HandoffConflict> {
			if (state.kind !== "reviewing" || state.completion !== "completed") {
				return conflict(state, "beginReviewTurn", "Review here requires a completed worker report");
			}
			const reviewing: HandoffCompletedReviewingState = { ...state, awaitingReviewTurn: true };
			state = reviewing;
			return ok(reviewing);
		},

		clearReviewTurn(review?: CapturedReview): Result<HandoffReviewingState, HandoffConflict> {
			if (state.kind !== "reviewing") {
				return conflict(state, "clearReviewTurn", "No review turn is awaiting completion");
			}
			const reviewing: HandoffReviewingState = {
				...state,
				...(review === undefined ? {} : { review }),
				awaitingReviewTurn: false,
			};
			state = reviewing;
			return ok(reviewing);
		},

		restore(next: HandoffState): void {
			state = next;
		},

		reset(): void {
			state = IDLE;
		},
	};
}

/** Returns session-entry data with no live process capability or handle attached. */
export function serializeHandoffState(state: HandoffState): HandoffState {
	switch (state.kind) {
		case "idle":
			return { kind: "idle" };
		case "drafting":
			return { ...state };
		case "proposed":
			return { kind: "proposed", draft: state.draft, choice: state.choice };
		case "running":
			return {
				kind: "running",
				draft: state.draft,
				choice: state.choice,
				iteration: state.iteration,
				startedAt: state.startedAt,
				checkpoint: state.checkpoint,
				...(state.external === true ? { external: true } : {}),
				...(state.autoReview === true ? { autoReview: true } : {}),
			};
		case "reviewing":
			switch (state.completion) {
				case "completed":
					return { ...state };
				case "interrupted":
					return { ...state };
				default:
					return assertNever(state);
			}
		default:
			return assertNever(state);
	}
}

/** Applies restart-only recovery rules to a validated persisted handoff state. */
export function rehydrateHandoffState(state: HandoffState): HandoffState {
	switch (state.kind) {
		case "idle":
			return IDLE;
		case "drafting":
			// Older drafting entries had no retained envelope and still downgrade to idle.
			return state.pendingDraft === undefined ? IDLE : state;
		case "proposed":
			return IDLE;
		case "running":
			// An external run is not downgraded. Its worker lives in another terminal, which
			// this session's death did not touch, so the run may well still be in flight and
			// its "I ran it — review now" path must survive a restart. A child-process run is
			// downgraded because the child cannot outlive its parent: reporting it as
			// interrupted is what keeps the checkpoint reachable for Discard.
			if (state.external === true) return state;
			return {
				kind: "reviewing",
				completion: "interrupted",
				draft: state.draft,
				choice: state.choice,
				iteration: state.iteration,
				checkpoint: state.checkpoint,
				report: null,
				diffstat: null,
				usage: null,
				interruptionNote: INTERRUPTED_WORKER_NOTE,
				awaitingReviewTurn: false,
			};
		case "reviewing":
			switch (state.completion) {
				case "completed":
				case "interrupted":
					return { ...state, awaitingReviewTurn: false };
				default:
					return assertNever(state);
			}
		default:
			return assertNever(state);
	}
}

/**
 * Finds the last valid handoff entry on a session branch and applies recovery.
 * Invalid or data-less entries are skipped, matching Pi's extension recovery
 * convention; a branch containing no valid handoff entry is not resumable.
 *
 * A null or undefined element is skipped rather than dereferenced. Session data
 * is decoded from disk, so a sparse or truncated branch is a possible input, and
 * a rehydration path that throws would fail the session restore it exists to
 * perform.
 */
export function rehydrateLatestHandoffState(entries: readonly HandoffSessionEntry[]): HandoffState | undefined {
	let restored: HandoffState | undefined;
	for (const entry of entries) {
		if (!entry || entry.type !== "custom" || entry.customType !== HANDOFF_STATE_ENTRY_TYPE) continue;
		const decoded = validateHandoffState(entry.data);
		if (!decoded.ok) continue;
		restored = rehydrateHandoffState(decoded.value);
	}
	return restored;
}

function assertNever(value: never): never {
	throw new Error(`Unexpected handoff state: ${JSON.stringify(value)}`);
}
