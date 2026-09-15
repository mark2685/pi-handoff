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

/** A recorder that drops every state, used in non-interactive paths and unit tests. */
export const NULL_HANDOFF_STATE_RECORDER: HandoffStateRecorder = {
	record: () => {},
};

/** A report recorder that drops every entry, used in unit tests. */
export const NULL_HANDOFF_REPORT_RECORDER: HandoffReportRecorder = {
	record: () => {},
};
