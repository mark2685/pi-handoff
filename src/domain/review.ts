/**
 * Pure review-turn data helpers.
 *
 * The Gate B loop stores the final reviewer response verbatim, but it needs a
 * small, deliberately strict parser for the one-line recommendation the review
 * prompt requests. Keeping this here lets the application layer persist a
 * recommendation without depending on Pi message types or presentation code.
 */

/** The recommendations a Review here turn can make. */
export type ReviewVerdict = "accept" | "fix" | "discard";

/** Matches the final recommendation line while tolerating simple Markdown emphasis. */
export const REVIEW_VERDICT_LINE =
	/^\s*(?:[*_`]+)?Verdict:(?:[*_`]+)?\s*(?:[*_`]+)?(accept|fix|discard)(?:[*_`]+)?\.?\s*$/i;

/** A captured reviewer response associated with the worker iteration it inspected. */
export interface CapturedReview {
	iteration: number;
	verdict?: ReviewVerdict;
	text: string;
}

/**
 * Reads the final non-empty line as the review prompt's one-line verdict.
 *
 * A verdict is intentionally not inferred from prose elsewhere in the response:
 * the reviewer may discuss multiple possible outcomes before giving its actual
 * recommendation. The final line may use simple Markdown emphasis around the
 * label or value and may end in a period. Missing and malformed lines are
 * ordinary input, not errors.
 */
export function parseReviewVerdict(text: string): ReviewVerdict | undefined {
	const lines = text.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line === undefined || line.trim() === "") continue;
		const match = REVIEW_VERDICT_LINE.exec(line);
		if (match === null || match[1] === undefined) return undefined;
		return match[1].toLowerCase() as ReviewVerdict;
	}
	return undefined;
}
