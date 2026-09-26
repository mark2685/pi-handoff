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
 * Whether a captured review actually says something about the iteration it names.
 *
 * A review turn that fails — a provider error, a final message with no text — still
 * stores a record, with empty text. Presence alone therefore cannot stand for "the
 * work was reviewed": treating it that way offered a reviewer-findings block with
 * nothing in it, relabelled the gate's actions as though a review existed, and told
 * the worker a reviewer had inspected its tree.
 */
export function hasReviewEvidence(review: CapturedReview | undefined): boolean {
	return review !== undefined && review.text.trim() !== "";
}

/** The structured follow-up work, if any, named by a review. */
export type ReviewLeftovers = { kind: "none" } | { kind: "items"; items: string[] } | { kind: "missing" };

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

/** A case-insensitive structured-leftovers heading at the start of a review line. */
const LEFTOVERS_LINE = /^\s*Leftovers:\s*(.*)$/i;

/** A bullet under a structured leftovers heading. */
const LEFTOVERS_ITEM_LINE = /^\s*[-*]\s*(.*)$/;

/** A Verdict line closes a leftovers block even when it is not the final line. */
const VERDICT_LINE = /^\s*Verdict:/i;

/**
 * Reads the last structured `Leftovers:` block from a captured review.
 *
 * The review prompt requires this block immediately before its final verdict, but
 * captured reviews from older extension versions have no such contract. Those are
 * deliberately `missing`, not guessed from arbitrary review prose. A bare heading
 * or an explicit `none` both mean there is no worker work left to hand off.
 */
export function parseReviewLeftovers(text: string): ReviewLeftovers {
	const lines = text.split(/\r?\n/);
	let headingIndex = -1;
	let remainder = "";

	for (let index = 0; index < lines.length; index += 1) {
		const match = LEFTOVERS_LINE.exec(lines[index] ?? "");
		if (match === null) continue;
		headingIndex = index;
		remainder = (match[1] ?? "").trim();
	}

	if (headingIndex === -1) return { kind: "missing" };
	if (remainder.toLowerCase() === "none") return { kind: "none" };
	if (remainder !== "") return { kind: "items", items: [remainder] };

	const items: string[] = [];
	for (let index = headingIndex + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim() === "" || VERDICT_LINE.test(line)) break;
		const match = LEFTOVERS_ITEM_LINE.exec(line);
		if (match === null) continue;
		const item = (match[1] ?? "").trim();
		if (item !== "") items.push(item);
	}

	return items.length === 0 ? { kind: "none" } : { kind: "items", items };
}
