/**
 * The words this extension says to a person, in one place.
 *
 * [`CONTEXT.md`](../../CONTEXT.md) is the glossary; this module is where the terms in
 * it are spelled. Before it existed the gates were named by order — Gate A, Gate B —
 * in code and docs while their titles said something else on screen, the surface shown
 * during a run was an "overlay" in one file and a "widget" in the next, and a crashed
 * worker's text was "pre-crash output", "partial output", or a "partial report"
 * depending on which module rendered it. A reader had to learn that each set was one
 * thing, and a change to the wording could not be made in one place.
 *
 * Two rules keep it honest:
 *
 *  - **Plain strings only.** Styling belongs to the presentation layer, because
 *    `domain/` may not import Pi and because a string from here may reach a
 *    notification, a prompt, or `/handoff status` output in a headless run.
 *  - **Nothing here does IO or knows a surface.** A phrase lives here when two surfaces
 *    must agree on it — a menu label that a notification later names, a gate's title that the
 *    README describes — not merely because it is user-facing.
 *
 * Wire values are deliberately absent: the persisted state kinds (`proposed`,
 * `reviewing`), the envelope key `bluf`, the field `partialReport`, and the drafting
 * model's `NEEDS INPUT` marker are read contracts, not vocabulary, and are spelled
 * where they are parsed.
 */

/** The three gates, named by the decision each one guards. */
export const LAUNCH_GATE = "launch gate";
export const RESULT_GATE = "result gate";
export const QUESTIONS_GATE = "questions gate";

/** The surface shown while a worker runs; neither a pi overlay nor a pi widget. */
export const RUN_MONITOR = "run monitor";

/** Title of the launch gate, which approves a draft before any worker is spawned. */
export const LAUNCH_GATE_TITLE = "Handoff ready for approval";

/** Title of the questions gate, shown instead of the launch gate when a draft left decisions open. */
export const QUESTIONS_GATE_TITLE = "Handoff needs input";

/** Title of the run monitor. */
export const RUN_MONITOR_TITLE = "Worker running";

/**
 * Title of the result gate, which must never call an unfinished run a result.
 *
 * The two titles are the one place a person learns, before reading any detail,
 * whether the worker ended cleanly.
 */
export function resultGateTitle(completed: boolean): string {
	return completed ? "Handoff complete — review the changes" : "Handoff did not complete";
}

/**
 * What a crashed worker's text is called, everywhere a person reads it.
 *
 * Deliberately not "report": a report is a claim the worker chose to make, while this
 * is whatever it happened to be saying when it died. Labelling the second as the first
 * is how a mid-task sentence once reached a reviewer as a finished result.
 */
export const PARTIAL_OUTPUT = "Partial output";

/** The parenthetical every partial-output heading carries, so no surface softens it. */
export const NOT_A_REPORT = "NOT a report";

export type ReviewOptionLabel = "Review here" | "Review again";

/**
 * The label the result gate gives its review option.
 *
 * Shared so that text pointing the user at the option, such as a failed review turn's
 * notification, names exactly what the menu renders.
 */
export function reviewOptionLabel(reviewed: boolean): ReviewOptionLabel {
	return reviewed ? "Review again" : "Review here";
}

/**
 * Where a handoff is waiting, for `/handoff status` and the notifications that quote it.
 *
 * Spelled as a gate rather than as the persisted state kind, because "proposed" and
 * "reviewing" are wire values a person never otherwise meets, while the gate is the
 * screen `/handoff` will reopen.
 */
export function waitingAt(gate: typeof LAUNCH_GATE | typeof RESULT_GATE | typeof QUESTIONS_GATE): string {
	return `waiting at the ${gate}`;
}
