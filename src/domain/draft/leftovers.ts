/**
 * Builds the drafting scope for a follow-up handoff from an accepted review.
 *
 * This exists because of a repeated, expensive pattern: a review returns `accept`
 * with a list of minor items ("fix the nits", "the remaining weaknesses", "fold
 * the four deferred nits in"), the user accepts, and then starts a fresh
 * `/handoff` for those items — paying a full drafting call over the entire
 * session transcript, plus another trip through Gate A, to restate findings that
 * were already written down.
 *
 * The scope here is deliberately built from **only the accepted prompt and the
 * captured review text**, never the transcript. That is the whole economy of it:
 * the two documents that define the leftovers are already in hand, and
 * re-serializing a long reviewing session would spend the drafting call's context
 * on history that has just been superseded by the accepted work. It also keeps
 * the follow-up honest — a drafting model given the transcript tends to re-propose
 * work the review just accepted.
 *
 * Pure, so the assembly is testable without a drafting model or a TUI.
 */

/** Heading under which the accepted handoff is restated for the follow-up draft. */
export const LEFTOVERS_PROMPT_HEADING = "The handoff that was just accepted";

/** Heading under which the review's findings are restated for the follow-up draft. */
export const LEFTOVERS_REVIEW_HEADING = "The review that accepted it";

export interface LeftoversScopeInput {
	/** The accepted prompt, so the follow-up inherits its conventions and constraints. */
	prompt: string;
	/** The reviewer's captured text, which is where the leftover items are named. */
	reviewText: string;
	/** The accepted handoff's slug, named so the follow-up can refer to it. */
	slug: string;
}

/**
 * Renders the scope for a leftovers follow-up draft.
 *
 * The instruction block leads, before either document, because the drafting model
 * reads this as scope and the one thing it must not do is redo the accepted work.
 * Both documents are fenced and labelled, since they are long, and an unlabelled
 * concatenation of a prompt and a review reads as one contradictory document.
 */
export function buildLeftoversScope(input: LeftoversScopeInput): string {
	const prompt = input.prompt.trim();
	const reviewText = input.reviewText.trim();

	return [
		`A handoff named \`${input.slug}\` was implemented and its review returned a verdict of accept. The work is done and already in the working tree; it must not be redone.`,
		"",
		"Draft a follow-up handoff covering **only the remaining items the review flagged** — the nits, deferred points, minor weaknesses, and follow-ups it listed while still accepting the work. Read the review below and take your scope from it.",
		"",
		"Rules for this follow-up:",
		"",
		"- Do not restate or re-implement anything the review accepted as correct.",
		"- If the review flagged nothing beyond the accepted work, say so in the rationale and keep the prompt minimal rather than inventing tasks.",
		"- Inherit the conventions, constraints, and validation commands from the accepted prompt below; the follow-up runs against the same repository.",
		"- The working tree already contains the accepted changes. Tell the new agent that, so it does not expect a clean tree or try to recreate the prior work.",
		"",
		`## ${LEFTOVERS_REVIEW_HEADING}`,
		"",
		reviewText === "" ? "The review captured no text, so no leftover items are recorded." : reviewText,
		"",
		`## ${LEFTOVERS_PROMPT_HEADING}`,
		"",
		prompt === "" ? "The accepted prompt is unavailable." : prompt,
	].join("\n");
}
