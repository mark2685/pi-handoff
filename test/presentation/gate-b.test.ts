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
import {
	GATE_B_COMMON_COMPLETED_FIXED_ROWS,
	GATE_B_LARGEST_INTERRUPTED_FIXED_ROWS,
	buildFeedbackEditorRequest,
	diffstatPreviewLimit,
	feedbackDraftAdvice,
	gateBOptions,
	formatGateBSummary,
	formatGateBTitle,
	partialReportPreviewLimit,
	reportPreviewLimit,
	stderrPreviewLimit,
	type GateBView,
} from "../../src/presentation/gate-b.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { confirmDiscardMenu, gateBMenu, selectOption } from "../../src/presentation/menus.ts";
import {
	definitionOfDoneLimit,
	formatRunningHeaderLines,
	formatRunningLines,
	formatWorkerStatusLine,
	isAbortKey,
} from "../../src/presentation/running-widget.ts";

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
		const view = { ...COMPLETED_VIEW, report };
		const lines = formatGateBSummary(view);
		assert.ok(lines.includes('… 16 more lines — choose "View full report" to read all of it'));
		assert.equal(gateBOptions(view).find((option) => option.id === "view_report")?.label, "View full report");
	});

	it("shares a 40-row completed-review budget between the report, diffstat, and findings", () => {
		const report = Array.from({ length: 40 }, (_, index) => `report ${index}`).join("\n");
		const diffstat = Array.from({ length: 30 }, (_, index) => `diff ${index}`).join("\n");
		const review = Array.from({ length: 30 }, (_, index) => `finding ${index}`).join("\n");
		const view: GateBView = {
			...COMPLETED_VIEW,
			report,
			diffstat,
			review: { iteration: 1, verdict: "fix", text: review },
		};
		const lines = formatGateBSummary(view, 40);
		assert.equal(
			lines.length +
				gateBMenu({ interrupted: false, hasReport: true, review: { verdict: "fix", leftovers: "missing" } }).length +
				5,
			40,
		);
		assert.ok(lines.includes('… 34 more lines — choose "View full report" to read all of it'));
		assert.ok(lines.includes("… 28 more lines"));
	});

	it("keeps the three-row preview floor and gives the report the spare rows first", () => {
		const completed = ["report", "review", "diffstat"] as const;
		assert.deepEqual(
			[24, 30, 40].map((rows) => reportPreviewLimit(rows, GATE_B_COMMON_COMPLETED_FIXED_ROWS, completed)),
			[3, 3, 7],
		);
		assert.deepEqual(
			[24, 30, 40].map((rows) => diffstatPreviewLimit(rows, GATE_B_COMMON_COMPLETED_FIXED_ROWS, completed)),
			[3, 3, 3],
		);

		const interrupted = ["diffstat", "partialReport", "stderr"] as const;
		assert.deepEqual(
			[24, 30, 40].map((rows) => partialReportPreviewLimit(rows, GATE_B_LARGEST_INTERRUPTED_FIXED_ROWS, interrupted)),
			[3, 3, 3],
		);
		assert.deepEqual(
			[24, 30, 40].map((rows) => stderrPreviewLimit(rows, GATE_B_LARGEST_INTERRUPTED_FIXED_ROWS, interrupted)),
			[3, 3, 3],
		);
	});

	it("preserves the historical formatter output when terminal rows are omitted", () => {
		const report = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
		assert.deepEqual(
			formatGateBSummary({ ...COMPLETED_VIEW, report }),
			formatGateBSummary({ ...COMPLETED_VIEW, report }, undefined),
		);
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

describe("buildFeedbackEditorRequest", () => {
	it("prefills reviewer findings without their verdict line", () => {
		const request = buildFeedbackEditorRequest({
			...COMPLETED_VIEW,
			review: { iteration: 1, verdict: "fix", text: "Cover the timeout path.\nVerdict: fix" },
		});

		assert.deepEqual(request, { kind: "review", title: "Review feedback", prefill: "Cover the timeout path." });
	});

	/** The buffer is blank, so the title is the only place left to say why. */
	it("says in the title that no review was captured for a finished iteration", () => {
		const request = buildFeedbackEditorRequest(COMPLETED_VIEW);

		assert.equal(request.kind, "none");
		assert.equal(request.prefill, "");
		assert.match(request.title, /no review captured for iteration 1/);
	});

	/** A verdict-only review is a review, so the title must not deny one was captured. */
	it("distinguishes a verdict-only review from no review", () => {
		const request = buildFeedbackEditorRequest({
			...COMPLETED_VIEW,
			review: { iteration: 1, verdict: "fix", text: "Verdict: fix" },
		});

		assert.equal(request.kind, "verdict_only");
		assert.equal(request.prefill, "");
		assert.match(request.title, /only its verdict/);
		assert.doesNotMatch(request.title, /no review captured/);
	});

	it("drafts resume instructions quoting the note for an interrupted iteration", () => {
		const request = buildFeedbackEditorRequest(INTERRUPTED_VIEW);

		assert.equal(request.kind, "interrupted");
		assert.match(request.prefill, /The worker was stopped before it reported a result\./);
		assert.match(request.title, /interrupted iteration 1/);
	});
});

describe("feedbackDraftAdvice", () => {
	/**
	 * The advice names an option the user has to be able to find. The menu renders
	 * Review here only until a review exists, then Review again, and drops it entirely
	 * for an interrupted run.
	 */
	it("matches the label the menu renders for each state", () => {
		assert.match(feedbackDraftAdvice("none"), /choose Review here first/);
		assert.equal(gateBMenu({ interrupted: false }).find((option) => option.id === "review")?.label, "Review here");

		assert.match(feedbackDraftAdvice("verdict_only"), /choose Review again first/);
		assert.equal(
			gateBMenu({ interrupted: false, review: { verdict: "fix" } }).find((option) => option.id === "review")?.label,
			"Review again",
		);
	});

	it("offers no review option where the gate has none to offer", () => {
		assert.equal(feedbackDraftAdvice("interrupted"), "");
		assert.equal(
			gateBMenu({ interrupted: true }).find((option) => option.id === "review"),
			undefined,
		);
	});

	/** The review text was already there and the user cleared it, so there is nothing to draft. */
	it("says nothing when the findings were already prefilled", () => {
		assert.equal(feedbackDraftAdvice("review"), "");
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

	it("labels pre-crash output separately from a completed report", () => {
		const options = gateBMenu({ interrupted: true, hasPartialReport: true });
		assert.equal(options.find((option) => option.id === "view_report")?.label, "View partial output");
		assert.equal(
			options.some((option) => option.label === "View full report"),
			false,
		);
	});

	it("offers leftovers only for an accept review with items or a missing legacy block", () => {
		for (const leftovers of ["items", "missing"] as const) {
			assert.equal(
				gateBMenu({ interrupted: false, review: { verdict: "accept", leftovers } }).some(
					(option) => option.id === "accept_leftovers",
				),
				true,
			);
		}
		assert.equal(
			gateBMenu({ interrupted: false, review: { verdict: "accept", leftovers: "none" } }).some(
				(option) => option.id === "accept_leftovers",
			),
			false,
		);
		assert.equal(
			gateBMenu({ interrupted: false, review: { verdict: "fix", leftovers: "items" } }).some(
				(option) => option.id === "accept_leftovers",
			),
			false,
		);
	});

	it("places leftovers after both view options and before leaving the gate", () => {
		const ids = gateBMenu({
			interrupted: false,
			hasReport: true,
			review: { verdict: "accept", leftovers: "items" },
		}).map((option) => option.id);
		assert.deepEqual(ids.slice(-4), ["view_report", "view_diffstat", "accept_leftovers", "dismiss"]);
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

describe("formatRunningHeaderLines", () => {
	const view = {
		slug: "add-retry-logic",
		choice: CHOICE,
		promptPath: "/tmp/pi-handoff-add-retry-logic.md",
		noProgressThresholdMs: 600_000,
		bluf: "Add bounded retries so transient failures recover.",
		definitionOfDone: ["Retries are bounded", "Focused tests pass", "Docs explain the behavior"],
	};

	it("shows bounded static goal and definition-of-done lines", () => {
		assert.deepEqual(formatRunningHeaderLines(view), [
			"Handoff:   add-retry-logic",
			"Model:     bifrost-openai/gpt-5.6-terra:high",
			"Prompt:    /tmp/pi-handoff-add-retry-logic.md",
			"Goal: Add bounded retries so transient failures recover.",
			"Definition of done: (first conditions)",
			"  - Retries are bounded",
			"  - Focused tests pass",
		]);
	});

	it("omits the metadata block when the drafting model omitted it", () => {
		const { bluf: _bluf, definitionOfDone: _definitionOfDone, ...withoutMetadata } = view;
		assert.equal(formatRunningHeaderLines(withoutMetadata).length, 3);
	});

	it("truncates every header line to Text's content width, excluding its horizontal padding", () => {
		// A 20-column terminal leaves 18 columns inside Text's one-cell left/right margins.
		for (const line of formatRunningHeaderLines(view, 18)) assert.ok(visibleWidth(line) <= 18);
	});

	it("shows more completion conditions when the terminal has room", () => {
		assert.equal(definitionOfDoneLimit(24), 2);
		assert.equal(definitionOfDoneLimit(40), 5);
		assert.deepEqual(formatRunningHeaderLines(view, Number.POSITIVE_INFINITY, definitionOfDoneLimit(40)).slice(-3), [
			"  - Retries are bounded",
			"  - Focused tests pass",
			"  - Docs explain the behavior",
		]);
	});
});

describe("isAbortKey", () => {
	it("accepts both legacy and Kitty Escape encodings", () => {
		assert.equal(isAbortKey("\x1b"), true);
		assert.equal(isAbortKey("\x1b[27u"), true);
	});

	it("does not mistake other keys for Escape", () => {
		assert.equal(isAbortKey("q"), false);
		assert.equal(isAbortKey("\x1b[A"), false);
	});
});

describe("formatRunningLines", () => {
	it("shows elapsed time", () => {
		const lines = formatRunningLines(
			{ slug: "add-retry-logic", choice: CHOICE, promptPath: "/tmp/p.md", noProgressThresholdMs: 600_000 },
			{ elapsedMs: 83_000, progress: undefined, stopping: false },
		);
		assert.ok(lines.includes("Elapsed:   1m 23s"));
	});

	it("reports no metrics before the first worker event", () => {
		const lines = formatRunningLines(
			{ slug: "add-retry-logic", choice: CHOICE, promptPath: "/tmp/p.md", noProgressThresholdMs: 600_000 },
			{ elapsedMs: 0, progress: undefined, stopping: false },
		);
		assert.ok(lines.includes("Tokens:    none yet"));
		assert.ok(lines.includes("Turns:     0"));
	});

	it("makes a silent worker explicit instead of implying that it is progressing", () => {
		assert.equal(
			formatWorkerStatusLine({
				elapsedMs: 83_000,
				progress: undefined,
				stopping: false,
				noProgressThresholdMs: 600_000,
			}),
			"Status:    ◌ Starting worker — no events yet (1m 23s)",
		);
	});

	it("makes a no-progress watchdog prompt explicit without claiming the worker stopped", () => {
		const lines = formatRunningLines(
			{
				slug: "add-retry-logic",
				choice: CHOICE,
				promptPath: "/tmp/p.md",
				noProgressThresholdMs: 600_000,
			},
			{
				elapsedMs: 600_000,
				progress: {
					report: "",
					usage: USAGE,
					toolResults: [],
					stopReason: undefined,
					errorMessage: undefined,
					activity: { kind: "stalled" },
					activeTools: [{ toolCallId: "stalled-bash", toolName: "bash" }],
					elapsedMs: 0,
				},
				stopping: false,
			},
		);

		assert.ok(
			lines.includes(
				"Status:    ⚠ No worker event for 10m 00s while running 1 tool: bash · last event 10m 00s ago — it may still be working; press esc to stop or wait",
			),
		);
		assert.ok(lines.includes("esc  stop the worker · or keep waiting"));
	});

	it("names active tools and the age of the last worker event", () => {
		assert.equal(
			formatWorkerStatusLine({
				elapsedMs: 67_000,
				progress: {
					report: "",
					usage: USAGE,
					toolResults: [],
					stopReason: undefined,
					errorMessage: undefined,
					activity: { kind: "running_tools" },
					activeTools: [
						{ toolCallId: "one", toolName: "bash" },
						{ toolCallId: "two", toolName: "read" },
					],
					elapsedMs: 5_000,
				},
				stopping: false,
				noProgressThresholdMs: 600_000,
			}),
			"Status:    ↻ Running 2 tools: bash, read · last event 1m 02s ago",
		);
	});

	it("keeps the current phase and update age visible after a worker event", () => {
		assert.equal(
			formatWorkerStatusLine({
				elapsedMs: 5_900,
				progress: {
					report: "",
					usage: USAGE,
					toolResults: [],
					stopReason: undefined,
					errorMessage: undefined,
					activity: { kind: "thinking" },
					activeTools: [],
					elapsedMs: 5_000,
				},
				stopping: false,
				noProgressThresholdMs: 600_000,
			}),
			"Status:    ● Thinking · last event just now",
		);
	});

	it("shows turns, tokens, and cost once the worker reports them", () => {
		const lines = formatRunningLines(
			{ slug: "add-retry-logic", choice: CHOICE, promptPath: "/tmp/p.md", noProgressThresholdMs: 600_000 },
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
			{ slug: "add-retry-logic", choice: CHOICE, promptPath: "/tmp/p.md", noProgressThresholdMs: 600_000 },
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

	it("keeps the abort hint on a 24-row terminal with metadata and five tool calls", () => {
		const toolResults = Array.from({ length: 5 }, (_, index) => ({
			toolCallId: `call-${index}`,
			toolName: `tool_${index}`,
			text: "",
			isError: false,
		}));
		const lines = formatRunningLines(
			{
				slug: "add-retry-logic",
				choice: CHOICE,
				promptPath: "/tmp/pi-handoff-add-retry-logic.md",
				noProgressThresholdMs: 600_000,
				bluf: "A deliberately long bottom line that must not wrap past the available widget body width.",
				definitionOfDone: ["Retries are bounded", "Focused tests pass", "Docs explain the behavior"],
			},
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
			78,
			definitionOfDoneLimit(24),
		);

		// Title and spacer consume the other two rows in the overlay.
		assert.equal(lines.length + 2, 24);
		assert.equal(lines.at(-1), "esc  stop the worker");
		for (const line of lines) assert.ok(visibleWidth(line) <= 78);
	});

	it("truncates untrusted long tool names to the widget content width", () => {
		const lines = formatRunningLines(
			{ slug: "handoff", choice: CHOICE, promptPath: "/tmp/p.md", noProgressThresholdMs: 600_000 },
			{
				elapsedMs: 0,
				progress: {
					report: "",
					usage: USAGE,
					toolResults: [
						{
							toolCallId: "c",
							toolName: "工具-".repeat(20),
							text: "",
							isError: true,
						},
					],
					stopReason: undefined,
					errorMessage: undefined,
					elapsedMs: 0,
				},
				stopping: false,
			},
			18,
		);

		for (const line of lines) assert.ok(visibleWidth(line) <= 18, line);
		assert.ok(lines.some((line) => line.includes("…")));
	});

	it("marks a failed tool call", () => {
		const lines = formatRunningLines(
			{ slug: "add-retry-logic", choice: CHOICE, promptPath: "/tmp/p.md", noProgressThresholdMs: 600_000 },
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
			{ slug: "add-retry-logic", choice: CHOICE, promptPath: "/tmp/p.md", noProgressThresholdMs: 600_000 },
			{ elapsedMs: 0, progress: undefined, stopping: false },
		);
		assert.ok(lines.includes("esc  stop the worker"));
	});

	it("reports that a stop is in progress rather than still offering it", () => {
		const lines = formatRunningLines(
			{ slug: "add-retry-logic", choice: CHOICE, promptPath: "/tmp/p.md", noProgressThresholdMs: 600_000 },
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

	it("keeps correctly counted signposts for every shortened crash-evidence preview", () => {
		const lines = formatGateBSummary(
			{
				...CRASHED_VIEW,
				diffstat: Array.from({ length: 12 }, (_, index) => `diff ${index}`).join("\n"),
				partialReport: Array.from({ length: 10 }, (_, index) => `partial ${index}`).join("\n"),
				stderrTail: Array.from({ length: 9 }, (_, index) => `stderr ${index}`).join("\n"),
			},
			24,
		);
		assert.ok(lines.includes('… 10 more lines — choose "View full diffstat" to read all of it'));
		assert.ok(lines.includes('… 8 more lines — choose "View partial output" to read all of it'));
		assert.ok(lines.includes('… 7 more lines — choose "View full diffstat" to read all of it'));
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

	it("offers a partial-output viewer only when the height-budgeted preview hides text", () => {
		const truncated: GateBView = {
			...CRASHED_VIEW,
			partialReport: Array.from({ length: 10 }, (_, index) => `partial ${index}`).join("\n"),
		};
		assert.equal(
			gateBOptions(truncated, 24).find((option) => option.id === "view_report")?.label,
			"View partial output",
		);
		assert.equal(
			gateBOptions(CRASHED_VIEW, 24).some((option) => option.id === "view_report"),
			false,
		);
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
