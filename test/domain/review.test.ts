import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseReviewLeftovers, parseReviewVerdict } from "../../src/domain/review.ts";

describe("parseReviewVerdict", () => {
	it("parses each supported verdict case-insensitively", () => {
		assert.equal(parseReviewVerdict("Everything is correct.\nVerdict: ACCEPT"), "accept");
		assert.equal(parseReviewVerdict("Needs a regression test.\nVerdict: fix"), "fix");
		assert.equal(parseReviewVerdict("This changes unrelated behavior.\nVerdict: Discard"), "discard");
	});

	it("allows tolerated Markdown, case, period, and whitespace forms", () => {
		for (const text of [
			"Verdict: fix",
			"Verdict: fix.",
			"**Verdict:** fix",
			"**Verdict: fix**",
			"_Verdict:_ FIX",
			"`Verdict: fix`",
			"Verdict: **fix**",
		]) {
			assert.equal(parseReviewVerdict(text), "fix", text);
		}
	});

	it("allows the verdict to be the last non-empty line", () => {
		assert.equal(parseReviewVerdict("Finding.\nVerdict: fix   \n\n\t"), "fix");
	});

	it("does not infer a verdict from malformed or non-final prose", () => {
		for (const text of [
			"Verdict: fix\nMore investigation is needed.",
			"Verdict: maybe",
			"Verdict: fix, but see notes",
			"Verdict: fix..",
			"No final recommendation.",
		]) {
			assert.equal(parseReviewVerdict(text), undefined, text);
		}
	});
});

describe("parseReviewLeftovers", () => {
	it("parses an explicit none marker case-insensitively", () => {
		assert.deepEqual(parseReviewLeftovers("Looks good.\nLeftovers: NONE\nVerdict: accept"), { kind: "none" });
	});

	it("parses a single inline item", () => {
		assert.deepEqual(parseReviewLeftovers("Leftovers: Add a timeout regression test\nVerdict: accept"), {
			kind: "items",
			items: ["Add a timeout regression test"],
		});
	});

	it("collects non-empty dash and star bullets through the verdict", () => {
		assert.deepEqual(
			parseReviewLeftovers("Leftovers:\n- Document the timeout\n* Rename the misleading test\n-   \nVerdict: accept"),
			{ kind: "items", items: ["Document the timeout", "Rename the misleading test"] },
		);
	});

	it("uses the final leftovers heading when a review quotes an earlier one", () => {
		assert.deepEqual(
			parseReviewLeftovers("Earlier draft said Leftovers: old item\nLeftovers:\n- Current item\nVerdict: accept"),
			{ kind: "items", items: ["Current item"] },
		);
	});

	it("treats an empty block as none and stops at a blank line", () => {
		assert.deepEqual(parseReviewLeftovers("Leftovers:\n\n- Not part of the block\nVerdict: accept"), { kind: "none" });
	});

	it("reports missing rather than inferring work from arbitrary review prose", () => {
		assert.deepEqual(parseReviewLeftovers("A stale comment remains.\nVerdict: accept"), { kind: "missing" });
	});
});
