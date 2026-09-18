/**
 * Tests for the pure parts of the run and review surfaces.
 *
 * Gate B's summary, the running widget's body, the discard summary, and the usage
 * formatters are all pure, so the decisions they encode are asserted here rather
 * than through an overlay.
 *
 * The discard cases carry the most weight. Discard is not a full undo — a path
 * that was already dirty at checkpoint time keeps the worker's edit — and the only
 * thing standing between that and a user who believes their tree was restored is
 * this text. So the skipped-path warning is asserted on its content and its
 * position, not merely its presence.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDiscardHeadline, formatDiscardSummary, hasSkippedPaths } from "../../src/domain/report/discard.ts";
import {
	formatCost,
	formatElapsed,
	formatTokenCount,
	formatTokenSummary,
	formatUsageLines,
	type UsageTotals,
} from "../../src/domain/report/format.ts";
import type { ModelChoice } from "../../src/domain/types.ts";
import { formatGateBSummary, formatGateBTitle, type GateBView } from "../../src/presentation/gate-b.ts";
import { confirmDiscardMenu, gateBMenu, selectOption } from "../../src/presentation/menus.ts";
import { formatRunningLines } from "../../src/presentation/running-widget.ts";

const CHOICE: ModelChoice = { provider: "bifrost-openai", model: "gpt-5.6-terra", thinking: "high" };

const USAGE: UsageTotals = {
	inputTokens: 12_345,
	outputTokens: 6_789,
	cacheReadTokens: 100,
	cacheWriteTokens: 50,
	cost: 0.4231,
	contextTokens: 20_000,
	turns: 4,
};

const DIFFSTAT = " src/client.ts | 12 +++++--\n 1 file changed, 9 insertions(+), 3 deletions(-)";

const COMPLETED_VIEW: GateBView = {
	slug: "add-retry-logic",
	choice: CHOICE,
	promptPath: "/tmp/pi-handoff-add-retry-logic.md",
	iteration: 1,
	report: "## Summary\nAdded retry logic.",
	diffstat: DIFFSTAT,
	diffstatFailure: undefined,
	usage: USAGE,
	interruptionNote: undefined,
};

const INTERRUPTED_VIEW: GateBView = {
	...COMPLETED_VIEW,
	report: null,
	usage: null,
	interruptionNote: "The worker was stopped before it reported a result.",
};

describe("formatTokenCount", () => {
	it("groups thousands without depending on the host locale", () => {
		assert.equal(formatTokenCount(1234567), "1,234,567");
	});

	it("leaves small counts ungrouped", () => {
		assert.equal(formatTokenCount(42), "42");
	});
});

describe("formatCost", () => {
	it("formats a reported cost to four decimal places", () => {
		assert.equal(formatCost(0.4231), "$0.4231");
	});

	it("reports an absent cost rather than claiming the run was free", () => {
		assert.equal(formatCost(0), "not reported");
	});
});

describe("formatElapsed", () => {
	it("shows seconds alone under a minute", () => {
		assert.equal(formatElapsed(45_000), "45s");
	});

	it("shows minutes and padded seconds", () => {
		assert.equal(formatElapsed(83_000), "1m 23s");
	});

	it("shows hours once a run is long", () => {
		assert.equal(formatElapsed(3_723_000), "1h 02m 03s");
	});

	it("treats a negative reading as zero rather than rendering nonsense", () => {
		assert.equal(formatElapsed(-500), "0s");
	});
});

describe("formatTokenSummary", () => {
	it("always reports input and output", () => {
		const summary = formatTokenSummary({ ...USAGE, cacheReadTokens: 0, cacheWriteTokens: 0 });
		assert.equal(summary, "in 12,345, out 6,789");
	});

	it("includes cache figures only when the provider reported them", () => {
		assert.equal(formatTokenSummary(USAGE), "in 12,345, out 6,789, cache read 100, cache write 50");
	});
});

describe("formatUsageLines", () => {
	it("reports the latest context size rather than a sum", () => {
		const lines = formatUsageLines(USAGE);
		assert.ok(lines.includes("Context:   20,000"));
	});

	it("reports the turn count", () => {
		assert.ok(formatUsageLines(USAGE).includes("Turns:     4"));
	});
});

describe("formatGateBSummary", () => {
	it("shows the worker's report", () => {
		const lines = formatGateBSummary(COMPLETED_VIEW);
		assert.ok(lines.includes("## Summary"));
		assert.ok(lines.includes("Added retry logic."));
	});

	it("shows the diffstat against the checkpoint", () => {
		const lines = formatGateBSummary(COMPLETED_VIEW);
		assert.ok(lines.some((line) => line.includes("1 file changed")));
	});

	it("shows the model and iteration", () => {
		const lines = formatGateBSummary(COMPLETED_VIEW);
		assert.ok(lines.includes("Model:     bifrost-openai/gpt-5.6-terra:high"));
		assert.ok(lines.includes("Iteration: 1"));
	});

	it("shows usage for a completed run", () => {
		const lines = formatGateBSummary(COMPLETED_VIEW);
		assert.ok(lines.includes("Cost:      $0.4231"));
	});

	it("explains a missing report instead of leaving it blank", () => {
		const lines = formatGateBSummary(INTERRUPTED_VIEW);
		assert.ok(lines.includes("Report:    none — the worker did not finish"));
	});

	it("carries the interruption note into the gate", () => {
		const lines = formatGateBSummary(INTERRUPTED_VIEW);
		assert.ok(lines.some((line) => line.includes("stopped before it reported a result")));
	});

	it("says usage is unavailable rather than reporting zeroes", () => {
		const lines = formatGateBSummary(INTERRUPTED_VIEW);
		assert.ok(lines.includes("Usage:     not available for an unfinished run"));
		assert.ok(!lines.some((line) => line.includes("Cost:      $0.0000")));
	});

	it("distinguishes an unreadable diffstat from an empty one", () => {
		const lines = formatGateBSummary({ ...COMPLETED_VIEW, diffstatFailure: "HEAD changed since the checkpoint" });
		assert.ok(lines.includes("Changes:   could not be read"));
	});

	it("says so when the worker changed nothing", () => {
		const lines = formatGateBSummary({ ...COMPLETED_VIEW, diffstat: "" });
		assert.ok(lines.includes("Changes:   none against the checkpoint"));
	});

	it("truncates a long report and points at the option that shows the rest", () => {
		const report = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
		const lines = formatGateBSummary({ ...COMPLETED_VIEW, report });
		assert.ok(lines.includes('… 16 more lines — choose "View full report" to read all of it'));
	});

	it("is unchanged when no review was captured", () => {
		const withoutReview = formatGateBSummary(COMPLETED_VIEW);
		const copiedWithoutReview = formatGateBSummary({ ...COMPLETED_VIEW });
		assert.deepEqual(copiedWithoutReview, withoutReview);
		assert.equal(
			withoutReview.some((line) => line.startsWith("Reviewer verdict:")),
			false,
		);
	});

	it("shows every parsed reviewer verdict and its findings", () => {
		for (const verdict of ["accept", "fix", "discard"] as const) {
			const lines = formatGateBSummary({
				...COMPLETED_VIEW,
				review: { iteration: 1, verdict, text: `Finding for ${verdict}.\nVerdict: ${verdict}` },
			});
			assert.ok(lines.includes(`Reviewer verdict: ${verdict}`));
			assert.ok(lines.includes(`Finding for ${verdict}.`));
		}
	});

	it("shows captured findings when the verdict could not be parsed", () => {
		const lines = formatGateBSummary({
			...COMPLETED_VIEW,
			review: { iteration: 1, text: "The review ended without the required recommendation." },
		});
		assert.ok(lines.includes("Reviewer verdict: none (no Verdict: line found)"));
		assert.ok(lines.includes("The review ended without the required recommendation."));
	});

	it("truncates a long review preview", () => {
		const text = Array.from({ length: 30 }, (_, index) => `finding ${index}`).join("\n");
		const lines = formatGateBSummary({ ...COMPLETED_VIEW, review: { iteration: 1, verdict: "fix", text } });
		assert.ok(lines.includes("… 6 more lines"));
	});
});

describe("formatGateBTitle", () => {
	it("titles a completed run as a result to review", () => {
		assert.equal(formatGateBTitle(COMPLETED_VIEW), "Handoff complete — review the changes");
	});

	it("does not title an unfinished run as a result", () => {
		assert.equal(formatGateBTitle(INTERRUPTED_VIEW), "Handoff did not complete");
	});
});

describe("gateBMenu", () => {
	it("keeps the original order and labels when no review was captured", () => {
		const options = gateBMenu({ interrupted: false, hasReport: true });
		assert.deepEqual(
			options.map((option) => option.id),
			["review", "feedback", "discard", "accept", "view_report", "view_diffstat", "dismiss"],
		);
		assert.equal(options[0]?.label, "Review here");
		assert.equal(options[1]?.label, "Send feedback to worker");
	});

	it("omits the report viewer when there is no report text to show", () => {
		const options = gateBMenu({ interrupted: true });
		assert.equal(
			options.some((option) => option.id === "view_report"),
			false,
		);
		assert.equal(
			options.some((option) => option.id === "view_diffstat"),
			true,
		);
	});

	it("offers the leftovers follow-up only on an accept verdict", () => {
		assert.equal(
			gateBMenu({ interrupted: false, review: { verdict: "accept" } }).some(
				(option) => option.id === "accept_leftovers",
			),
			true,
		);
		assert.equal(
			gateBMenu({ interrupted: false, review: { verdict: "fix" } }).some((option) => option.id === "accept_leftovers"),
			false,
		);
		assert.equal(
			gateBMenu({ interrupted: false }).some((option) => option.id === "accept_leftovers"),
			false,
		);
	});

	it("labels the live options plainly once they are implemented", () => {
		const options = gateBMenu({ interrupted: false });
		const review = options.find((option) => option.id === "review");
		const feedback = options.find((option) => option.id === "feedback");
		assert.equal(review?.label, "Review here");
		assert.equal(feedback?.label, "Send feedback to worker");
	});

	/** Same convention as Gate A's blocked Run: a missing option reads as a broken gate. */
	it("shows feedback as blocked once the iteration bound is reached", () => {
		const options = gateBMenu({
			interrupted: false,
			feedback: { allowed: false, iteration: 3, maxIterations: 3 },
		});
		const feedback = options.find((option) => option.id === "feedback");
		assert.equal(feedback?.label, "Send feedback to worker (blocked: iteration 3 of 3 is the last)");
	});

	it("keeps the blocked feedback option present so the rule is visible", () => {
		const ids = gateBMenu({
			interrupted: false,
			feedback: { allowed: false, iteration: 3, maxIterations: 3 },
		}).map((option) => option.id);
		assert.ok(ids.includes("feedback"));
	});

	it("labels feedback plainly while iterations remain", () => {
		const options = gateBMenu({
			interrupted: false,
			feedback: { allowed: true, iteration: 1, maxIterations: 3 },
		});
		assert.equal(options.find((option) => option.id === "feedback")?.label, "Send feedback to worker");
	});

	it("relabels review actions after a review without a verdict", () => {
		const options = gateBMenu({ interrupted: false, review: {}, hasReport: true });
		assert.equal(options.find((option) => option.id === "review")?.label, "Review again");
		assert.equal(options.find((option) => option.id === "feedback")?.label, "Send review to worker");
		assert.deepEqual(
			options.map((option) => option.id),
			["review", "feedback", "discard", "accept", "view_report", "view_diffstat", "dismiss"],
		);
	});

	it("puts only fix and accept actions first", () => {
		assert.equal(gateBMenu({ interrupted: false, review: { verdict: "fix" } })[0]?.id, "feedback");
		assert.equal(gateBMenu({ interrupted: false, review: { verdict: "accept" } })[0]?.id, "accept");
		assert.equal(gateBMenu({ interrupted: false, review: { verdict: "discard" } })[0]?.id, "review");
	});

	it("explains a discard recommendation without moving the destructive action", () => {
		const options = gateBMenu({ interrupted: false, review: { verdict: "discard" } });
		assert.equal(
			options.find((option) => option.id === "discard")?.label,
			"Discard changes (reviewer recommends discard)",
		);
	});

	/** Re-running after a crash is exactly what a user wants from an interrupted review. */
	it("still offers feedback after an interrupted run", () => {
		const ids = gateBMenu({ interrupted: true }).map((option) => option.id);
		assert.ok(ids.includes("feedback"));
	});

	it("omits Review here when there is no report to review", () => {
		const ids = gateBMenu({ interrupted: true }).map((option) => option.id);
		assert.ok(!ids.includes("review"));
	});

	it("still offers Discard after an interrupted run, since the worker may have edited the tree", () => {
		const ids = gateBMenu({ interrupted: true }).map((option) => option.id);
		assert.ok(ids.includes("discard"));
	});

	it("offers a way to leave the review pending", () => {
		const ids = gateBMenu({ interrupted: false }).map((option) => option.id);
		assert.ok(ids.includes("dismiss"));
	});
});

describe("confirmDiscardMenu", () => {
	it("does not put the destructive option first", () => {
		assert.equal(confirmDiscardMenu()[0]?.id, "keep");
	});

	it("resolves the discard confirmation by id", async () => {
		const chosen = await selectOption(
			async (_title, options) => options[1],
			"Discard the worker's changes?",
			confirmDiscardMenu(),
		);
		assert.equal(chosen, "discard");
	});
});

describe("formatDiscardSummary", () => {
	it("warns first when paths were left unreverted", () => {
		const lines = formatDiscardSummary({
			restoredPaths: ["src/client.ts"],
			removedPaths: [],
			skippedPaths: ["already-dirty.ts"],
		});
		assert.ok(lines[0]?.startsWith("Warning: 1 path was NOT reverted"));
	});

	it("says the worker's change to a skipped path is still present", () => {
		const lines = formatDiscardSummary({
			restoredPaths: [],
			removedPaths: [],
			skippedPaths: ["already-dirty.ts"],
		});
		assert.ok(lines.some((line) => line.includes("is still present")));
	});

	it("names every skipped path", () => {
		const lines = formatDiscardSummary({
			restoredPaths: [],
			removedPaths: [],
			skippedPaths: ["already-dirty.ts", "docs/notes.md"],
		});
		assert.ok(lines.includes("  already-dirty.ts"));
		assert.ok(lines.includes("  docs/notes.md"));
	});

	it("pluralizes the warning for several skipped paths", () => {
		const lines = formatDiscardSummary({
			restoredPaths: [],
			removedPaths: [],
			skippedPaths: ["a.ts", "b.ts"],
		});
		assert.ok(lines[0]?.startsWith("Warning: 2 paths were NOT reverted"));
	});

	it("lists restored and removed paths under distinct headings", () => {
		const lines = formatDiscardSummary({
			restoredPaths: ["src/client.ts"],
			removedPaths: ["src/new.ts"],
			skippedPaths: [],
		});
		assert.ok(lines.includes("Reverted to their checkpoint state:"));
		assert.ok(lines.includes("Deleted, having been created during the run:"));
	});

	it("omits the warning entirely when nothing was skipped", () => {
		const lines = formatDiscardSummary({
			restoredPaths: ["src/client.ts"],
			removedPaths: [],
			skippedPaths: [],
		});
		assert.ok(!lines.some((line) => line.startsWith("Warning:")));
	});

	it("says so when there was nothing to revert", () => {
		const lines = formatDiscardSummary({ restoredPaths: [], removedPaths: [], skippedPaths: [] });
		assert.deepEqual(lines, ["No files needed reverting; the worker left no changes outside the checkpoint."]);
	});

	it("does not end on a blank line", () => {
		const lines = formatDiscardSummary({
			restoredPaths: ["src/client.ts"],
			removedPaths: ["src/new.ts"],
			skippedPaths: ["already-dirty.ts"],
		});
		assert.notEqual(lines[lines.length - 1], "");
	});
});

describe("hasSkippedPaths", () => {
	it("detects a discard that left worker changes in place", () => {
		assert.equal(hasSkippedPaths({ restoredPaths: [], removedPaths: [], skippedPaths: ["a.ts"] }), true);
	});

	it("reports a clean discard", () => {
		assert.equal(hasSkippedPaths({ restoredPaths: ["a.ts"], removedPaths: [], skippedPaths: [] }), false);
	});
});

describe("formatDiscardHeadline", () => {
	it("counts reverted paths", () => {
		const headline = formatDiscardHeadline({
			restoredPaths: ["a.ts"],
			removedPaths: ["b.ts"],
			skippedPaths: [],
		});
		assert.equal(headline, "Discarded 2 paths");
	});

	it("mentions untouched paths in the one-line summary too", () => {
		const headline = formatDiscardHeadline({
			restoredPaths: ["a.ts"],
			removedPaths: [],
			skippedPaths: ["dirty.ts"],
		});
		assert.ok(headline.includes("1 path left untouched"));
	});
});

describe("formatRunningLines", () => {
	it("shows elapsed time", () => {
		const lines = formatRunningLines(
			{ slug: "add-retry-logic", choice: CHOICE, promptPath: "/tmp/p.md" },
			{ elapsedMs: 83_000, progress: undefined, stopping: false },
		);
		assert.ok(lines.includes("Elapsed:   1m 23s"));
	});

	it("reports no metrics before the first worker event", () => {
		const lines = formatRunningLines(
			{ slug: "add-retry-logic", choice: CHOICE, promptPath: "/tmp/p.md" },
			{ elapsedMs: 0, progress: undefined, stopping: false },
		);
		assert.ok(lines.includes("Tokens:    none yet"));
		assert.ok(lines.includes("Turns:     0"));
	});

	it("shows turns, tokens, and cost once the worker reports them", () => {
		const lines = formatRunningLines(
			{ slug: "add-retry-logic", choice: CHOICE, promptPath: "/tmp/p.md" },
			{
				elapsedMs: 1_000,
				progress: {
					report: "",
					usage: USAGE,
					toolResults: [],
					stopReason: undefined,
					errorMessage: undefined,
					elapsedMs: 1_000,
				},
				stopping: false,
			},
		);
		assert.ok(lines.includes("Turns:     4"));
		assert.ok(lines.includes("Cost:      $0.4231"));
	});

	it("lists only the most recent tool calls but reports the total", () => {
		const toolResults = Array.from({ length: 8 }, (_, index) => ({
			toolCallId: `call-${index}`,
			toolName: `tool_${index}`,
			text: "",
			isError: false,
		}));
		const lines = formatRunningLines(
			{ slug: "add-retry-logic", choice: CHOICE, promptPath: "/tmp/p.md" },
			{
				elapsedMs: 1_000,
				progress: {
					report: "",
					usage: USAGE,
					toolResults,
					stopReason: undefined,
					errorMessage: undefined,
					elapsedMs: 1_000,
				},
				stopping: false,
			},
		);
		assert.ok(lines.includes("Recent tool calls (8 total):"));
		assert.ok(lines.includes("  ✓ tool_7"));
		assert.ok(!lines.includes("  ✓ tool_2"));
	});

	it("marks a failed tool call", () => {
		const lines = formatRunningLines(
			{ slug: "add-retry-logic", choice: CHOICE, promptPath: "/tmp/p.md" },
			{
				elapsedMs: 1_000,
				progress: {
					report: "",
					usage: USAGE,
					toolResults: [{ toolCallId: "c", toolName: "bash", text: "", isError: true }],
					stopReason: undefined,
					errorMessage: undefined,
					elapsedMs: 1_000,
				},
				stopping: false,
			},
		);
		assert.ok(lines.includes("  ✗ bash"));
	});

	it("offers the abort key while running", () => {
		const lines = formatRunningLines(
			{ slug: "add-retry-logic", choice: CHOICE, promptPath: "/tmp/p.md" },
			{ elapsedMs: 0, progress: undefined, stopping: false },
		);
		assert.ok(lines.includes("esc  stop the worker"));
	});

	it("reports that a stop is in progress rather than still offering it", () => {
		const lines = formatRunningLines(
			{ slug: "add-retry-logic", choice: CHOICE, promptPath: "/tmp/p.md" },
			{ elapsedMs: 0, progress: undefined, stopping: true },
		);
		assert.ok(lines.includes("Stopping the worker…"));
		assert.ok(!lines.includes("esc  stop the worker"));
	});
});

/**
 * Crash evidence at Gate B.
 *
 * The distinction these pin is the whole of Bug 1's presentation half: `report` is
 * a claim the worker chose to make, `partialReport` is whatever it happened to be
 * saying when it died, and rendering the second as the first is how a mid-task
 * sentence about terminal width reached a reviewer as a finished result beside a
 * 2,816-line diff.
 */
describe("formatGateBSummary crash evidence", () => {
	const CRASHED_VIEW: GateBView = {
		...INTERRUPTED_VIEW,
		interruptionNote: "The worker ended on an error rather than finishing its turn.",
		partialReport: "The pty defaulted to 80 columns… Let me set a larger window size.",
		stderrTail: "pi: fatal: provider returned 503",
	};

	it("states that the worker did not finish", () => {
		const lines = formatGateBSummary(CRASHED_VIEW);
		assert.ok(lines.some((line) => line.includes("Report:    none — the worker did not finish")));
	});

	it("shows the interruption reason", () => {
		const lines = formatGateBSummary(CRASHED_VIEW);
		assert.ok(lines.some((line) => line.includes("ended on an error rather than finishing its turn")));
	});

	/** The heading is the warning: this text looks exactly like a report and is not one. */
	it("labels the pre-crash text as not a report", () => {
		const lines = formatGateBSummary(CRASHED_VIEW);
		assert.ok(lines.includes("Partial output before the worker died (NOT a report — it never finished):"));
	});

	it("never introduces pre-crash text as the worker's report", () => {
		const lines = formatGateBSummary(CRASHED_VIEW);
		assert.equal(lines.includes("Worker report:"), false);
	});

	it("includes the pre-crash text so the user can see what it was doing", () => {
		const lines = formatGateBSummary(CRASHED_VIEW);
		assert.ok(lines.some((line) => line.includes("The pty defaulted to 80 columns")));
	});

	it("shows the stderr tail, which usually names the real failure", () => {
		const lines = formatGateBSummary(CRASHED_VIEW);
		assert.ok(lines.includes("Worker stderr (tail):"));
		assert.ok(lines.some((line) => line.includes("provider returned 503")));
	});

	it("omits both sections when a run was interrupted with no evidence", () => {
		const lines = formatGateBSummary(INTERRUPTED_VIEW);
		assert.equal(
			lines.some((line) => line.includes("Partial output")),
			false,
		);
		assert.equal(lines.includes("Worker stderr (tail):"), false);
	});

	it("still titles the gate as an incomplete handoff", () => {
		assert.equal(formatGateBTitle(CRASHED_VIEW), "Handoff did not complete");
	});

	it("offers the report viewer for pre-crash text, since there is something to read", () => {
		const options = gateBMenu({ interrupted: true, hasReport: true });
		assert.ok(options.some((option) => option.id === "view_report"));
	});
});

describe("formatGateBSummary external runs", () => {
	it("explains absent usage by naming the other terminal, not an unfinished run", () => {
		const lines = formatGateBSummary({ ...COMPLETED_VIEW, usage: null, external: true });
		assert.ok(lines.includes("Usage:     not available — the handoff ran in another terminal"));
	});

	it("still shows the report and diffstat for an external run", () => {
		const lines = formatGateBSummary({ ...COMPLETED_VIEW, usage: null, external: true });
		assert.ok(lines.includes("Worker report:"));
		assert.ok(lines.includes("Changes:"));
	});

	it("distinguishes an unfinished run from an unmeasured one", () => {
		const lines = formatGateBSummary(INTERRUPTED_VIEW);
		assert.ok(lines.includes("Usage:     not available for an unfinished run"));
	});
});
