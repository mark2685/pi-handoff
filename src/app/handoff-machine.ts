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
	readonly usage: WorkerUsage;
	readonly awaitingReviewTurn: boolean;
}

/**
 * A Pi restart ended a worker before its result could be collected. Null review
 * fields deliberately mean unavailable, never "an empty worker response".
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
}

export interface RestartRunInput extends StartRunInput {
	draft: Draft;
	choice: ModelChoice;
}

export interface CompleteRunInput {
	report: string;
	diffstat: string;
	usage: WorkerUsage;
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
	 */
	interruptRun(note: string): Result<HandoffInterruptedReviewingState, HandoffConflict>;
	/** Arms the one `agent_end` event caused by Review here. */
	beginReviewTurn(): Result<HandoffCompletedReviewingState, HandoffConflict>;
	/** Clears the Review here arm before Gate B is reopened. */
	clearReviewTurn(): Result<HandoffReviewingState, HandoffConflict>;
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
				...input,
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
				awaitingReviewTurn: false,
			};
			state = reviewing;
			return ok(reviewing);
		},

		interruptRun(note: string): Result<HandoffInterruptedReviewingState, HandoffConflict> {
			if (state.kind !== "running") {
				return conflict(state, "interruptRun", "No worker run is active to interrupt");
			}
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
				interruptionNote: note,
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

		clearReviewTurn(): Result<HandoffReviewingState, HandoffConflict> {
			if (state.kind !== "reviewing") {
				return conflict(state, "clearReviewTurn", "No review turn is awaiting completion");
			}
			const reviewing: HandoffReviewingState = { ...state, awaitingReviewTurn: false };
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
			return { kind: "drafting", scope: state.scope };
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
		case "proposed":
			return IDLE;
		case "running":
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
