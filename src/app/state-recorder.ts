/**
 * Boundary for persisting handoff state into the session.
 *
 * This interface lives in the app layer rather than `src/ports/` because it
 * speaks in `HandoffState`, which the machine owns; a port importing app types
 * would invert the dependency direction. Recording is deliberately fire-and-
 * forget: a session entry that fails to append must never block a gate the user
 * is looking at, so the concrete adapter swallows nothing but also returns
 * nothing for callers to branch on.
 */

import type { HandoffState } from "./handoff-machine.ts";

/** Namespaced custom-session entry holding an accepted worker report. */
export const HANDOFF_REPORT_ENTRY_TYPE = "handoff-report";

/** Appends one serialized handoff state to the session as a custom entry. */
export interface HandoffStateRecorder {
	record(state: HandoffState): void;
}

/**
 * The accepted result of one handoff, kept for the session transcript.
 *
 * This is separate from `handoff-state` because it is not machine state: it
 * outlives the handoff that produced it and is never rehydrated into a state
 * machine. Recording it under its own entry type keeps rehydration from having
 * to distinguish "the handoff was here" from "the handoff finished here".
 */
export interface HandoffReportEntry {
	/** The draft slug, so a transcript reader can tell handoffs apart. */
	slug: string;
	/** `provider/model:thinking` of the worker that produced the report. */
	model: string;
	iteration: number;
	/** The worker's final text, verbatim. */
	report: string;
	/** Git's diffstat against the checkpoint at the time of acceptance. */
	diffstat: string;
	acceptedAt: string;
}

/** Appends an accepted worker report to the session as a custom entry. */
export interface HandoffReportRecorder {
	record(entry: HandoffReportEntry): void;
}

/** Namespaced custom-session entry holding a decision that changes no handoff state by itself. */
export const HANDOFF_EVENT_ENTRY_TYPE = "handoff-event";

/**
 * A result-gate decision, spelled as the gate's option id: Review here, Send feedback,
 * Discard, Accept, Accept and hand off leftovers, or Leave this for later.
 */
export type ResultGateAction = "review" | "feedback" | "discard" | "accept" | "accept_leftovers" | "dismiss";

/**
 * Which result-gate action the user chose, for a session reader rather than for recovery.
 *
 * A separate entry rather than a field on `handoff-state`, because Leave this for later
 * changes no state at all, and a field on the reviewing state would be carried, stale,
 * into every later transition that spreads it. Rehydration reads only `handoff-state`,
 * so this entry can never change what a resumed session restores.
 *
 * Recorded once the choice is final — after the discard confirmation and after
 * non-empty feedback is entered — and before the transition it causes, so the action
 * precedes the `handoff-state` entry it led to. The action that follows may still fail;
 * this records what was chosen, not what succeeded.
 */
export interface ResultGateActionEvent {
	kind: "result-gate-action";
	action: ResultGateAction;
	/** The iteration the gate was deciding. */
	iteration: number;
}

/** Every handoff event entry; one kind today. */
export type HandoffEvent = ResultGateActionEvent;

/** Appends one handoff event to the session as a custom entry. */
export interface HandoffEventRecorder {
	record(event: HandoffEvent): void;
}

/** A recorder that drops every state, used in non-interactive paths and unit tests. */
export const NULL_HANDOFF_STATE_RECORDER: HandoffStateRecorder = {
	record: () => {},
};

/** A report recorder that drops every entry, used in unit tests. */
export const NULL_HANDOFF_REPORT_RECORDER: HandoffReportRecorder = {
	record: () => {},
};

/** An event recorder that drops every entry, used in unit tests. */
export const NULL_HANDOFF_EVENT_RECORDER: HandoffEventRecorder = {
	record: () => {},
};
