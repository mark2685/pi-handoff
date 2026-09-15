/**
 * Prompt text transformations for the bounded Gate B feedback loop.
 *
 * The caller owns iteration limits and file IO; this pure helper only preserves
 * the approved prompt and appends a clearly delimited instruction for the next
 * worker run. Blank feedback is a no-op so an empty editor submission cannot
 * create a misleading iteration section.
 */

/** Appends one non-blank review-feedback section without disturbing earlier sections. */
export function appendReviewFeedback(prompt: string, feedback: string, iteration: number): string {
	const trimmedFeedback = feedback.trim();
	if (!trimmedFeedback) return prompt;

	const separator = prompt.length === 0 ? "" : prompt.endsWith("\n\n") ? "" : prompt.endsWith("\n") ? "\n" : "\n\n";
	return `${prompt}${separator}## Review feedback (iteration ${iteration})\n\n${trimmedFeedback}\n`;
}
