/**
 * Tests for the Review here injection text.
 *
 * The message is the only thing this extension writes into the reviewing session's
 * own context, so what it contains is asserted rather than assumed. Two properties
 * matter beyond wording: the report must appear verbatim, because paraphrasing it
 * would hide the overclaiming the reviewer is looking for, and the handoff prompt
 * must *not* appear, because inlining a large prompt would spend the context the
 * whole extension exists to protect.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildReviewMessage,
	extractPromptHeading,
	REVIEW_LEFTOVERS_INSTRUCTION,
	REVIEW_VERDICT_INSTRUCTION,
} from "../../src/prompts/review-prompt.ts";

const INPUT = {
	slug: "add-retry-logic",
	promptPath: "/tmp/pi-handoff-add-retry-logic.md",
	prompt: "# Add retry logic\n\nImplement retries in src/client.ts and run `npm test`.",
	iteration: 2,
	model: "bifrost-openai/gpt-5.6-terra:high",
	report: "## Summary\nAdded retries.\n\n## Files changed\n- src/client.ts",
	diffstat: " src/client.ts | 12 +++++--\n 1 file changed",
	interruptionNote: undefined,
};

describe("extractPromptHeading", () => {
	it("uses the first Markdown heading", () => {
		assert.equal(extractPromptHeading("# Add retry logic\n\nBody."), "Add retry logic");
	});

	it("strips heading markers at any level", () => {
		assert.equal(extractPromptHeading("### Deep heading\n"), "Deep heading");
	});

	it("skips leading blank lines to find the heading", () => {
		assert.equal(extractPromptHeading("\n\n## Later heading\n"), "Later heading");
	});

	it("falls back to the first non-blank line when there is no heading", () => {
		assert.equal(extractPromptHeading("\nJust prose here.\nMore.\n"), "Just prose here.");
	});

	/** An empty reference would read as a missing prompt file rather than a headingless prompt. */
	it("reports the absence of a heading rather than rendering nothing", () => {
		assert.equal(extractPromptHeading("\n\n  \n"), "(no heading)");
	});
});

describe("buildReviewMessage", () => {
	it("includes the worker's report verbatim", () => {
		assert.ok(buildReviewMessage(INPUT).includes(INPUT.report));
	});

	it("includes the diffstat", () => {
		assert.ok(buildReviewMessage(INPUT).includes("src/client.ts | 12 +++++--"));
	});

	it("states which iteration is under review", () => {
		assert.ok(buildReviewMessage(INPUT).includes("iteration 2"));
	});

	it("names the worker's model", () => {
		assert.ok(buildReviewMessage(INPUT).includes("bifrost-openai/gpt-5.6-terra:high"));
	});

	it("references the prompt by path and heading", () => {
		const message = buildReviewMessage(INPUT);
		assert.ok(message.includes("/tmp/pi-handoff-add-retry-logic.md"));
		assert.ok(message.includes("Add retry logic"));
	});

	/** The prompt is already on disk; pasting it would spend the reviewing context. */
	it("does not paste the prompt body", () => {
		assert.ok(!buildReviewMessage(INPUT).includes("Implement retries in src/client.ts"));
	});

	it("points the reviewer at the diff rather than the report", () => {
		const message = buildReviewMessage(INPUT);
		assert.ok(message.includes("git diff"));
		assert.ok(message.includes("acceptance criteria"));
	});

	it("forbids editing files, which would escape the checkpoint", () => {
		assert.ok(buildReviewMessage(INPUT).includes("Do not edit"));
	});

	it("requires the structured leftovers block immediately before the final verdict", () => {
		const message = buildReviewMessage(INPUT);
		assert.ok(message.includes(REVIEW_LEFTOVERS_INSTRUCTION));
		assert.match(message, /`Leftovers: none`/);
		assert.match(message, /`Leftovers:` followed by one `- <concrete worker item>` bullet/);
		assert.match(
			message,
			/no action needed, notes for the human operator, praise, and work already accepted as correct/,
		);
		assert.ok(message.indexOf(REVIEW_LEFTOVERS_INSTRUCTION) < message.indexOf(REVIEW_VERDICT_INSTRUCTION));
	});

	it("requires the one-line verdict to be the last line", () => {
		const message = buildReviewMessage(INPUT);
		assert.ok(message.includes("Verdict:"));
		assert.ok(message.trimEnd().endsWith("`Verdict:` must be the last line."));
	});

	it("says there were no changes rather than rendering an empty block", () => {
		assert.ok(buildReviewMessage({ ...INPUT, diffstat: "   \n" }).includes("No changes against the checkpoint."));
	});

	it("explains a missing report instead of leaving the section blank", () => {
		const message = buildReviewMessage({
			...INPUT,
			report: null,
			interruptionNote: "The worker was stopped before it reported a result.",
		});
		assert.ok(message.includes("produced no report"));
		assert.ok(message.includes("The worker was stopped before it reported a result."));
	});

	it("still asks for a verdict when the worker produced no report", () => {
		assert.ok(buildReviewMessage({ ...INPUT, report: null, interruptionNote: undefined }).includes("Verdict:"));
	});
});

/**
 * A crashed worker's evidence in the review turn.
 *
 * The reviewer is the one person who can catch a handoff that died mid-task, so
 * the message has to hand over what actually happened rather than a bare "no
 * report" line — and it has to deny the pre-crash text the status of a report,
 * because it reads exactly like one.
 */
describe("buildReviewMessage crash evidence", () => {
	const CRASHED = {
		...INPUT,
		report: null,
		interruptionNote: "The worker ended on an error rather than finishing its turn.",
		partialReport: "The pty defaulted to 80 columns… Let me set a larger window size.",
		stderrTail: "pi: fatal: provider returned 503",
	};

	it("states the interruption reason", () => {
		assert.ok(buildReviewMessage(CRASHED).includes("ended on an error rather than finishing its turn"));
	});

	it("includes the pre-crash text under a heading that denies it is a report", () => {
		const message = buildReviewMessage(CRASHED);
		assert.ok(message.includes("### Partial output before it died"));
		assert.ok(message.includes("The pty defaulted to 80 columns"));
	});

	it("tells the reviewer not to read the pre-crash text as a summary of the work", () => {
		const message = buildReviewMessage(CRASHED);
		assert.ok(message.includes("not a report of finished work"));
		assert.ok(message.includes("may be far ahead of or behind it"));
	});

	it("includes the stderr tail", () => {
		const message = buildReviewMessage(CRASHED);
		assert.ok(message.includes("### Worker stderr (tail)"));
		assert.ok(message.includes("provider returned 503"));
	});

	it("keeps asking for scepticism about a missing report", () => {
		assert.ok(buildReviewMessage(CRASHED).includes("reason for scepticism"));
	});

	it("still requires the leftovers block and final verdict after a crash", () => {
		const message = buildReviewMessage(CRASHED);
		assert.ok(message.includes(REVIEW_LEFTOVERS_INSTRUCTION));
		assert.ok(message.trimEnd().endsWith("`Verdict:` must be the last line."));
	});

	it("omits both sections when a crash left no evidence", () => {
		const message = buildReviewMessage({ ...INPUT, report: null, interruptionNote: "The worker was stopped." });
		assert.equal(message.includes("### Partial output before it died"), false);
		assert.equal(message.includes("### Worker stderr (tail)"), false);
	});

	it("does not add crash sections to a completed run", () => {
		const message = buildReviewMessage(INPUT);
		assert.equal(message.includes("### Partial output before it died"), false);
	});
});
