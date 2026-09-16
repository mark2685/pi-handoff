/**
 * Prompt text transformations for the NEEDS INPUT gate's Answer flow.
 *
 * Kept beside `feedback.ts` because it is the same shape of problem: append a
 * clearly delimited, heading-labelled section to accumulating text, so an
 * earlier round's content is never disturbed by a later one. This module
 * operates on handoff *scope* (the text that seeds the next drafting call)
 * rather than the approved *prompt*, because Answer re-drafts instead of
 * patching an already-approved prompt file.
 */

/**
 * Appends the user's answered editor text as a heading-labelled section under
 * the accumulated scope.
 *
 * `answeredText` is expected to already contain both the questions and the
 * user's answers, since the caller prefills the editor with the extracted
 * questions before the user types answers beneath them: the drafting model
 * receives only the scope text and the session transcript, and the original
 * questions are not part of either unless restated here. A blank result is a
 * no-op, matching `appendReviewFeedback`'s convention, so a user who dismisses
 * the editor with nothing left cannot create a misleading empty section.
 */
export function appendNeedsInputAnswers(scope: string, heading: string, answeredText: string): string {
	const trimmedAnswered = answeredText.trim();
	if (!trimmedAnswered) return scope;

	const trimmedScope = scope.trim();
	const section = `## ${heading}\n\n${trimmedAnswered}\n`;
	return trimmedScope ? `${trimmedScope}\n\n${section}` : section;
}
