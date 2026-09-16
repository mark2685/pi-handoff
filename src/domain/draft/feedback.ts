/**
 * Prompt text transformations for the bounded Gate B feedback loop.
 *
 * The caller owns iteration limits and file IO; this pure helper only preserves
 * the approved prompt and appends a clearly delimited instruction for the next
 * worker run. Blank feedback is a no-op so an empty editor submission cannot
 * create a misleading iteration section.
 */

import { REVIEW_VERDICT_LINE } from "../review.ts";

/**
 * Removes the review prompt's trailing recommendation before the text becomes
 * worker instructions. The rest is intentionally left alone: reviewer formatting
 * is evidence, and the editor remains the place for a person to refine it.
 */
export function normalizeReviewFeedback(feedback: string): string {
	const lines = feedback.trim().split(/\r?\n/);
	if (lines.length > 0 && REVIEW_VERDICT_LINE.test(lines[lines.length - 1] ?? "")) lines.pop();
	return lines.join("\n").trim();
}

/** Builds the context that prevents a fresh worker from treating a fix iteration as a clean checkout. */
function feedbackPreamble(iteration: number, checkpointHead: string): string {
	return `This is iteration ${iteration}. The working tree already contains the previous iteration's changes against checkpoint \`${checkpointHead.slice(0, 7)}\`; do not start over and do not revert them unless the feedback below says to. A reviewer inspected that tree and reported the findings below. Address only these; do not expand scope.`;
}

/** Appends one non-blank, contextualized review-feedback section without disturbing earlier sections. The empty check is defensive because callers normalize before accepting feedback. */
export function appendReviewFeedback(
	prompt: string,
	feedback: string,
	iteration: number,
	checkpointHead: string,
): string {
	const normalizedFeedback = normalizeReviewFeedback(feedback);
	if (!normalizedFeedback) return prompt;

	const separator = prompt.length === 0 ? "" : prompt.endsWith("\n\n") ? "" : prompt.endsWith("\n") ? "\n" : "\n\n";
	return `${prompt}${separator}## Review feedback (iteration ${iteration})\n\n${feedbackPreamble(iteration, checkpointHead)}\n\n${normalizedFeedback}\n`;
}
