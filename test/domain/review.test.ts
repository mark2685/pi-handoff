import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseReviewVerdict } from "../../src/domain/review.ts";

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
