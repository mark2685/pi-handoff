import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendReviewFeedback, normalizeReviewFeedback } from "../../src/domain/draft/feedback.ts";
import { extractNeedsInput, hasNeedsInputMarker, parseDraft } from "../../src/domain/draft/parse.ts";
import { appendNeedsInputAnswers } from "../../src/domain/draft/scope.ts";
import {
	FALLBACK_SLUG,
	HANDOFF_PROMPT_EXTENSION,
	HANDOFF_PROMPT_PREFIX,
	HANDOFF_TEMP_DIR,
	MAX_SLUG_LENGTH,
	buildPromptPath,
	slugify,
} from "../../src/domain/draft/slug.ts";
import type { Draft } from "../../src/domain/types.ts";
import { validateDraft } from "../../src/persistence/schemas.ts";

const DRAFT: Draft = {
	slug: "add-retry-logic",
	prompt: "Implement the retry logic and run the focused tests.",
	tier: "standard",
	rationale: "The change spans two files but has narrow verification.",
};

function fencedJson(value: unknown): string {
	return `Draft response:\n\n\`\`\`json\n${JSON.stringify(value, null, "\t")}\n\`\`\``;
}

describe("parseDraft", () => {
	it("accepts a bare JSON envelope", () => {
		assert.deepEqual(parseDraft(JSON.stringify(DRAFT), validateDraft), { ok: true, value: DRAFT });
	});

	it("accepts a fenced JSON envelope", () => {
		assert.deepEqual(parseDraft(fencedJson(DRAFT), validateDraft), { ok: true, value: DRAFT });
	});

	it("accepts a fenced envelope whose prompt contains a nested fence marker", () => {
		const draft: Draft = {
			...DRAFT,
			prompt: "Run the full suite:\n```sh\nnpm run check\n```\nReport the result.",
		};
		const response = fencedJson(draft);
		const naiveFence = response.match(/```(?:json)?\s*\n([\s\S]*?)```/i)?.[1];
		assert.ok(response.includes("```sh"), "fixture must contain a literal nested fence marker");
		assert.throws(() => JSON.parse(naiveFence ?? ""), SyntaxError, "a lazy fence match must truncate this fixture");
		assert.deepEqual(parseDraft(response, validateDraft), { ok: true, value: draft });
	});

	it("tolerates trailing prose after the fenced envelope", () => {
		const response = `${fencedJson(DRAFT)}\n\nUse this draft for Gate A.\n\n\`\`\`text\nignored fence\n\`\`\``;
		assert.deepEqual(parseDraft(response, validateDraft), { ok: true, value: DRAFT });
	});

	it("returns no_json_object for prose without JSON", () => {
		assert.deepEqual(parseDraft("I cannot produce a draft yet.", validateDraft), {
			ok: false,
			error: { kind: "no_json_object" },
		});
	});

	it("returns no_json_object for an empty response", () => {
		assert.deepEqual(parseDraft("", validateDraft), { ok: false, error: { kind: "no_json_object" } });
	});

	it("returns no_json_object for a whitespace-only response", () => {
		assert.deepEqual(parseDraft(" \n\t ", validateDraft), { ok: false, error: { kind: "no_json_object" } });
	});

	it("returns invalid_draft with the schema violation for an unsupported tier", () => {
		const invalidDraft = { ...DRAFT, tier: "experimental" };
		const validation = validateDraft(invalidDraft);
		if (validation.ok) assert.fail("expected unsupported tier to fail schema validation");

		assert.deepEqual(parseDraft(JSON.stringify(invalidDraft), validateDraft), {
			ok: false,
			error: { kind: "invalid_draft", error: validation.error },
		});
	});

	it("does not throw for malformed arbitrary text", () => {
		assert.doesNotThrow(() => parseDraft('unclosed response { "prompt": [', validateDraft));
	});
});

describe("slugify", () => {
	it("lowercases a model-provided slug", () => {
		assert.equal(slugify("Add Retry Logic"), "add-retry-logic");
	});

	it("collapses non-alphanumeric separators", () => {
		assert.equal(slugify("add --- retry___logic"), "add-retry-logic");
	});

	it("strips quotes and trims edge separators", () => {
		assert.equal(slugify("!!! 'Add retry' !!!"), "add-retry");
	});

	it("caps generated slugs at the configured maximum length", () => {
		const slug = slugify("a".repeat(MAX_SLUG_LENGTH + 1));
		assert.equal(slug, "a".repeat(MAX_SLUG_LENGTH));
	});

	it("uses the fallback when no safe characters survive", () => {
		assert.equal(slugify("..."), FALLBACK_SLUG);
	});

	it("normalizes path-traversal-like input into a basename-safe slug", () => {
		assert.equal(slugify("../../etc/passwd"), "etc-passwd");
	});

	it("normalizes path separators instead of retaining them", () => {
		assert.equal(slugify("a/b"), "a-b");
	});

	it("builds the fixed temporary prompt path from an untrusted slug", () => {
		assert.equal(
			buildPromptPath("../../etc/passwd"),
			`${HANDOFF_TEMP_DIR}/${HANDOFF_PROMPT_PREFIX}etc-passwd${HANDOFF_PROMPT_EXTENSION}`,
		);
	});
});

describe("normalizeReviewFeedback", () => {
	it("strips every tolerated trailing Verdict form", () => {
		for (const verdictLine of [
			"Verdict: fix",
			"Verdict: fix.",
			"**Verdict:** fix",
			"**Verdict: fix**",
			"_Verdict:_ FIX",
			"`Verdict: fix`",
			"Verdict: **fix**",
		]) {
			assert.equal(
				normalizeReviewFeedback(`Fix the timeout handling.\n\n${verdictLine}  \n\t`),
				"Fix the timeout handling.",
				verdictLine,
			);
		}
	});

	it("preserves a Verdict line that is not trailing", () => {
		assert.equal(
			normalizeReviewFeedback("Verdict: fix\nThe final recommendation follows elsewhere."),
			"Verdict: fix\nThe final recommendation follows elsewhere.",
		);
	});

	it("preserves malformed or non-trailing Verdict lines", () => {
		for (const feedback of [
			"Verdict: fix\nThe final recommendation follows elsewhere.",
			"Fix it.\nVerdict: fix, but see notes",
			"Fix it.\nVerdict: fix..",
		]) {
			assert.equal(normalizeReviewFeedback(feedback), feedback, feedback);
		}
	});

	it("does not remove other feedback formatting", () => {
		assert.equal(normalizeReviewFeedback("\n- Add a test\n  - cover timeout\n"), "- Add a test\n  - cover timeout");
	});
});

describe("appendReviewFeedback", () => {
	const CHECKPOINT_HEAD = "abc1234def5678";
	const PREAMBLE =
		"This is iteration 1. The working tree already contains the previous iteration's changes against checkpoint `abc1234`; do not start over and do not revert them unless the feedback below says to. A reviewer inspected that tree and reported the findings below. Address only these; do not expand scope.";

	it("appends the first review-feedback section with worker context", () => {
		assert.equal(
			appendReviewFeedback("# Worker prompt", "Handle the retry edge case.", 1, CHECKPOINT_HEAD),
			`# Worker prompt\n\n## Review feedback (iteration 1)\n\n${PREAMBLE}\n\nHandle the retry edge case.\n`,
		);
	});

	it("preserves an earlier feedback section when appending the next iteration", () => {
		const first = appendReviewFeedback("# Worker prompt", "Handle the retry edge case.", 1, CHECKPOINT_HEAD);
		assert.match(
			appendReviewFeedback(first, "Add a regression test.", 2, CHECKPOINT_HEAD),
			/## Review feedback \(iteration 1\)[\s\S]*## Review feedback \(iteration 2\)/,
		);
	});

	it("leaves the prompt unchanged for empty or verdict-only feedback", () => {
		assert.equal(appendReviewFeedback("# Worker prompt\n", " \n\t", 1, CHECKPOINT_HEAD), "# Worker prompt\n");
		assert.equal(
			appendReviewFeedback("# Worker prompt\n", "**Verdict:** fix", 1, CHECKPOINT_HEAD),
			"# Worker prompt\n",
		);
	});
});

describe("appendNeedsInputAnswers", () => {
	const HEADING = "Answers to the previous draft's NEEDS INPUT questions";
	const ANSWERED_TEXT =
		"1. Which retry policy?\n\nExponential backoff.\n\n2. Configurable timeout?\n\nYes, default 30s.";

	it("appends a heading-labelled section under existing scope", () => {
		assert.equal(
			appendNeedsInputAnswers("Also update the docs.", HEADING, ANSWERED_TEXT),
			`Also update the docs.\n\n## ${HEADING}\n\n${ANSWERED_TEXT}\n`,
		);
	});

	it("builds the section alone when there was no prior scope", () => {
		assert.equal(appendNeedsInputAnswers("", HEADING, ANSWERED_TEXT), `## ${HEADING}\n\n${ANSWERED_TEXT}\n`);
	});

	it("includes both the restated questions and the answers", () => {
		const result = appendNeedsInputAnswers("", HEADING, ANSWERED_TEXT);
		assert.match(result, /Which retry policy\?/);
		assert.match(result, /Exponential backoff\./);
	});

	it("leaves the scope unchanged when the answered text is blank", () => {
		assert.equal(appendNeedsInputAnswers("Also update the docs.", HEADING, "   \n\t"), "Also update the docs.");
	});
});

describe("hasNeedsInputMarker", () => {
	it("detects the explicit uppercase marker", () => {
		assert.equal(hasNeedsInputMarker("Clarify the API contract. NEEDS INPUT before implementation."), true);
	});

	it("does not match ordinary lowercase prose", () => {
		assert.equal(hasNeedsInputMarker("The implementation needs input validation before writing code."), false);
	});
});

describe("extractNeedsInput", () => {
	it("returns a heading section's body, stopping before the next heading", () => {
		const prompt = [
			"# Handoff: add retries",
			"",
			"## NEEDS INPUT",
			"",
			"1. Which retry policy applies to streaming calls?",
			"2. Should the timeout be configurable?",
			"",
			"## Background",
			"",
			"Verified context goes here.",
		].join("\n");
		assert.equal(
			extractNeedsInput(prompt),
			"1. Which retry policy applies to streaming calls?\n2. Should the timeout be configurable?",
		);
	});

	it("returns the marker's paragraph up to the next blank line when there is no heading", () => {
		const prompt = [
			"# Handoff: add retries",
			"",
			"Note: NEEDS INPUT — which retry policy applies to streaming calls?",
			"Also confirm the timeout default.",
			"",
			"## Next section",
			"",
			"More text.",
		].join("\n");
		assert.equal(
			extractNeedsInput(prompt),
			"NEEDS INPUT — which retry policy applies to streaming calls?\nAlso confirm the timeout default.",
		);
	});

	it("falls back to the bare marker line when neither a heading nor a blank line applies", () => {
		const prompt = "NEEDS INPUT: which retry policy applies to streaming calls?";
		assert.equal(extractNeedsInput(prompt), prompt);
	});

	it("returns the first heading section when the marker appears twice", () => {
		const prompt = [
			"## NEEDS INPUT",
			"",
			"Question A?",
			"",
			"## Background",
			"",
			"Some verified context.",
			"",
			"## NEEDS INPUT",
			"",
			"Question B?",
		].join("\n");
		assert.equal(extractNeedsInput(prompt), "Question A?");
	});
});
