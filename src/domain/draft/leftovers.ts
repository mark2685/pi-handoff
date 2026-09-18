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
 * structured leftover items**, never the transcript. When an older review lacks a
 * `Leftovers:` block, it falls back to the complete review text and labels that
 * compatibility path explicitly. That is the whole economy of it: the documents
 * that define the leftovers are already in hand, and re-serializing a long
 * reviewing session would spend the drafting call's context on history that has
 * just been superseded by the accepted work. It also keeps the follow-up honest —
 * a drafting model given the transcript tends to re-propose work the review just
 * accepted.
 *
 * Pure, so the assembly is testable without a drafting model or a TUI.
 */

/** Heading under which the accepted handoff is restated for the follow-up draft. */
export const LEFTOVERS_PROMPT_HEADING = "The handoff that was just accepted";

/** Heading under which the review's structured leftovers are restated for the follow-up draft. */
export const LEFTOVERS_REVIEW_HEADING = "The leftover items listed by the review";

export interface LeftoversScopeInput {
	/** The accepted prompt, so the follow-up inherits its conventions and constraints. */
	prompt: string;
	/** The accepted handoff's slug, named so the follow-up can refer to it. */
	slug: string;
	/** Structured worker work parsed from the review's `Leftovers:` block. */
	items?: string[];
	/** Full review text used only when an older review has no structured block. */
	reviewText?: string;
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
	const structuredItems = input.items?.map((item) => item.trim()).filter((item) => item !== "");
	const usesStructuredItems = structuredItems !== undefined;
	const reviewText = input.reviewText?.trim() ?? "";
	const leftovers = usesStructuredItems
		? structuredItems.map((item) => `- ${item}`).join("\n") || "The structured list contained no actionable items."
		: reviewText === ""
			? "The review captured no text, so no leftover items are recorded."
			: reviewText;
	const scopeInstruction = usesStructuredItems
		? "Draft a follow-up handoff covering **only the remaining items the review flagged**. Take its scope solely from the structured items below."
		: "Draft a follow-up handoff covering **only the remaining items the review flagged**. This older review has no structured list, so use its full text below as the compatibility fallback.";

	return [
		`A handoff named \`${input.slug}\` was implemented and its review returned a verdict of accept. The work is done and already in the working tree; it must not be redone.`,
		"",
		scopeInstruction,
		"",
		"Rules for this follow-up:",
		"",
		"- Do not restate or re-implement anything the review accepted as correct.",
		'- If the structured list contains no work for a fresh worker, reply with exactly `{ "noLeftovers": true, "rationale": "<one sentence>" }` and do not include `slug`, `prompt`, or `tier`.',
		"- Inherit the conventions, constraints, and validation commands from the accepted prompt below; the follow-up runs against the same repository.",
		"- The working tree already contains the accepted changes. Tell the new agent that, so it does not expect a clean tree or try to recreate the prior work.",
		...(usesStructuredItems
			? []
			: [
					"- No structured `Leftovers:` list was found. This is an older captured review, so use the full review text below only as a compatibility fallback.",
				]),
		"",
		`## ${LEFTOVERS_REVIEW_HEADING}`,
		"",
		leftovers,
		"",
		`## ${LEFTOVERS_PROMPT_HEADING}`,
		"",
		prompt === "" ? "The accepted prompt is unavailable." : prompt,
	].join("\n");
}
