/**
 * Prompt text transformations for the bounded Gate B feedback loop.
 *
 * The caller owns iteration limits and file IO; this pure helper only preserves
 * the approved prompt and appends a clearly delimited instruction for the next
 * worker run. Blank feedback is a no-op so an empty editor submission cannot
 * create a misleading iteration section.
 *
 * It also drafts the feedback text itself for the one case where no reviewer text
 * exists to start from: an interrupted iteration. That draft lives here, beside
 * the normalization it will be passed through, so the resume instructions are unit
 * tested without a TUI or a worker.
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

/**
 * Drafts resume instructions for an iteration that was interrupted rather than reviewed.
 *
 * An interrupted run captures no review — auto-review is deliberately reserved for
 * clean endings — so Send feedback would otherwise open an empty editor after the
 * one outcome where the user has the least idea what to type. The template is a
 * draft, not a decision: it is prefilled into the editor and the user can rewrite
 * or delete it, and nothing here treats the dead run's pre-crash text as a report.
 *
 * The note is quoted verbatim because it is the only evidence of what ended the
 * run, and paraphrasing a provider error would cost the worker the detail that
 * tells it whether the work stopped mid-edit or never started.
 *
 * That the iteration did not finish and was not reviewed is stated by the `resume`
 * preamble this text is appended under, so it is not repeated here; the two would
 * otherwise open the same section with the same sentence twice.
 */
export function buildInterruptedResumeFeedback(note: string): string {
	const quotedNote = note.trim();
	const reason = quotedNote === "" ? "" : `What ended the previous iteration: ${quotedNote}\n\n`;
	return `${reason}The working tree still holds whatever that run had already changed; nothing was reverted, and its unfinished output is not a report of what it did.

Pick the work up from there:

- Read the current state of the files involved before assuming any part of the handoff is done or undone.
- Finish the remaining work. Do not start over, and do not revert the existing changes unless they are wrong.
- Write the final report the handoff asks for, covering the whole task rather than only this pass.`;
}

/**
 * Where the appended instructions came from, which decides what the prompt may claim.
 *
 * The worker is told who inspected its work, so this cannot be assumed. `review`
 * follows a captured reviewer response; `user` is a person's own feedback on an
 * iteration no reviewer saw; `resume` is a person's instructions after a run that
 * never finished, where the tree may be mid-edit and the task is still open.
 */
export type FeedbackSource = "review" | "user" | "resume";

/** The heading each source gets, so the section never announces a review that does not exist. */
function sectionHeading(source: FeedbackSource, iteration: number): string {
	return source === "review"
		? `## Review feedback (iteration ${iteration})`
		: `## Instructions from the user (iteration ${iteration})`;
}

/**
 * Builds the context that prevents a fresh worker from treating a fix iteration as a clean checkout.
 *
 * Only the `review` wording says a reviewer inspected the tree and that the worker
 * should address those findings alone. Saying it on the other paths put two
 * contradictory claims in one section — "address only the reviewer findings" above
 * text stating no review was captured and asking for the rest of the task — and a
 * worker that took the narrow reading would stop short of finishing the handoff.
 */
function feedbackPreamble(iteration: number, checkpointHead: string, source: FeedbackSource): string {
	const checkpoint = `\`${checkpointHead.slice(0, 7)}\``;
	if (source === "review") {
		return `This is iteration ${iteration}. The working tree already contains the previous iteration's changes against checkpoint ${checkpoint}; do not start over and do not revert them unless the feedback below says to. A reviewer inspected that tree and reported the findings below. Address only these; do not expand scope.`;
	}
	if (source === "resume") {
		return `This is iteration ${iteration}. The previous iteration did not finish, and no review of it was captured. The working tree already contains whatever that run changed against checkpoint ${checkpoint}; do not start over and do not revert those changes unless the instructions below say to. The instructions below come from the user, not from a reviewer. Address them and finish this handoff's remaining work.`;
	}
	return `This is iteration ${iteration}. The working tree already contains the previous iteration's changes against checkpoint ${checkpoint}; do not start over and do not revert them unless the instructions below say to. The instructions below come from the user, not from a reviewer. Address only these; do not expand scope.`;
}

/**
 * Appends one non-blank, contextualized feedback section without disturbing earlier sections.
 *
 * The empty check is defensive because callers normalize before accepting feedback.
 * `source` defaults to `review`, which is the path that existed first and the only
 * one whose wording may credit a reviewer.
 */
export function appendReviewFeedback(
	prompt: string,
	feedback: string,
	iteration: number,
	checkpointHead: string,
	source: FeedbackSource = "review",
): string {
	const normalizedFeedback = normalizeReviewFeedback(feedback);
	if (!normalizedFeedback) return prompt;

	const separator = prompt.length === 0 ? "" : prompt.endsWith("\n\n") ? "" : prompt.endsWith("\n") ? "\n" : "\n\n";
	return `${prompt}${separator}${sectionHeading(source, iteration)}\n\n${feedbackPreamble(iteration, checkpointHead, source)}\n\n${normalizedFeedback}\n`;
}
