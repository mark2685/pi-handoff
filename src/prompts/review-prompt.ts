/**
 * Prompt text for the Review here injection.
 *
 * This is the one place a handoff writes into the reviewing session's own
 * context, so what it does and does not include is deliberate. The handoff prompt
 * is referenced by path and first heading rather than pasted: it is already on
 * disk, it can be tens of kilobytes, and inlining it would spend the reviewing
 * context this extension exists to protect. The worker's report is included
 * verbatim, because it is the thing under review and paraphrasing it would hide
 * exactly the overclaiming a reviewer is looking for.
 *
 * The instructions push the reviewer at the diff rather than the report. A report
 * is a claim; the diff is the evidence. The closing verdict line is required so
 * `agent_end` can capture the recommendation and show it inside the reopened Gate
 * B overlay, which otherwise obscures the transcript.
 *
 * The reviewer is told not to edit files. Fixes belong to the worker through the
 * feedback loop, where they land inside the checkpoint that Discard can undo; a
 * reviewing session that edited the tree itself would put changes outside that
 * boundary and quietly break Discard's guarantee.
 */

/** The verdict line the review turn must end on, restated in the reopened gate. */
export const REVIEW_VERDICT_INSTRUCTION =
	"End your turn with a single line beginning `Verdict:` followed by exactly one of `accept`, `fix`, or `discard`, and nothing else on that line.";

export interface ReviewMessageInput {
	/** The draft slug, so the reviewer can tell one handoff from another. */
	slug: string;
	/** Where the approved prompt lives, since it is referenced rather than inlined. */
	promptPath: string;
	/** The prompt's own text, read only to extract its first heading. */
	prompt: string;
	/** Which iteration produced the report under review. */
	iteration: number;
	/** `provider/model:thinking` of the worker that produced the report. */
	model: string;
	/** The worker's final text, verbatim. Null when the run was interrupted. */
	report: string | null;
	/** Git's diffstat against the checkpoint. */
	diffstat: string;
	/** Present instead of a report when the run did not finish. */
	interruptionNote: string | undefined;
	/**
	 * Text a crashed worker emitted before it died, if any.
	 *
	 * Included so a reviewer can see what the worker thought it was doing, but under
	 * a heading that denies it the status of a report: it is the last thing said, not
	 * a conclusion, and treating the two as equivalent is what let a mid-task
	 * sentence stand in for a finished result.
	 */
	partialReport?: string;
	/** Bounded tail of a failed worker's stderr, which usually names the real failure. */
	stderrTail?: string;
}

/**
 * Extracts the prompt's first Markdown heading for the collapsed reference.
 *
 * Falls back to the first non-blank line, then to a plain notice. A reference that
 * silently rendered as an empty string would read as a missing prompt file rather
 * than as a prompt whose first line is not a heading.
 */
export function extractPromptHeading(prompt: string): string {
	const lines = prompt.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) return trimmed.replace(/^#+\s*/, "");
	}
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed !== "") return trimmed;
	}
	return "(no heading)";
}

/** Renders the diffstat block, distinguishing no changes from an unreadable one. */
function diffstatBlock(diffstat: string): string {
	const trimmed = diffstat.trim();
	if (trimmed === "") return "No changes against the checkpoint.";
	return `\`\`\`\n${trimmed}\n\`\`\``;
}

/** Renders the report block, or says why there is none. */
function reportBlock(input: ReviewMessageInput): string {
	if (input.report === null) {
		const note = input.interruptionNote ?? "The worker did not finish.";
		const sections = [
			`The worker produced no report. ${note}`,
			"",
			"Review whatever it managed to write to the working tree, and treat the absence of a report as a reason for scepticism rather than as a neutral fact.",
		];

		const partial = input.partialReport?.trim();
		if (partial !== undefined && partial !== "") {
			sections.push(
				"",
				"### Partial output before it died",
				"",
				"This is the last thing the worker said, not a report of finished work. Do not read it as a summary of what was done; the changes in the tree may be far ahead of or behind it.",
				"",
				`\`\`\`\n${partial}\n\`\`\``,
			);
		}

		const stderr = input.stderrTail?.trim();
		if (stderr !== undefined && stderr !== "") {
			sections.push("", "### Worker stderr (tail)", "", `\`\`\`\n${stderr}\n\`\`\``);
		}

		return sections.join("\n");
	}
	return input.report.trim();
}

/**
 * Builds the message injected into the reviewing session by Review here.
 *
 * Pure so the wording is unit-testable, and kept in `src/prompts/` because it is
 * data rather than orchestration.
 */
export function buildReviewMessage(input: ReviewMessageInput): string {
	return [
		`A handoff worker finished iteration ${input.iteration} of \`${input.slug}\` on ${input.model}. Review its work.`,
		"",
		"## The handoff it was given",
		"",
		`The approved prompt is on disk at \`${input.promptPath}\` under the heading "${extractPromptHeading(input.prompt)}". Read that file for the acceptance criteria; it is not repeated here.`,
		"",
		"## What the worker reported",
		"",
		reportBlock(input),
		"",
		"## Changes against the checkpoint",
		"",
		diffstatBlock(input.diffstat),
		"",
		"## Your task",
		"",
		"Review the actual changes, not the report. Use the read and bash tools to inspect the diff (`git diff`, `git status`) and the files it touches, and check the work against the acceptance criteria in the handoff prompt. Verify the claims in the report rather than accepting them: a validation command the report says passed is worth running.",
		"",
		"Do not edit, create, or delete any files, and do not commit anything. You are reviewing. If the work needs changes, they go back to the worker as feedback, which keeps them inside the checkpoint that Discard can undo.",
		"",
		"Report what you found: what is correct, what is wrong or missing, and anything the report overclaims.",
		"",
		REVIEW_VERDICT_INSTRUCTION,
	].join("\n");
}
