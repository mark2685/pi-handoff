import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendReviewFeedback } from "../../src/domain/draft/feedback.ts";
import { hasNeedsInputMarker, parseDraft } from "../../src/domain/draft/parse.ts";
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

describe("appendReviewFeedback", () => {
	it("appends the first review-feedback section", () => {
		assert.equal(
			appendReviewFeedback("# Worker prompt", "Handle the retry edge case.", 1),
			"# Worker prompt\n\n## Review feedback (iteration 1)\n\nHandle the retry edge case.\n",
		);
	});

	it("preserves an earlier feedback section when appending the next iteration", () => {
		const first = appendReviewFeedback("# Worker prompt", "Handle the retry edge case.", 1);
		assert.equal(
			appendReviewFeedback(first, "Add a regression test.", 2),
			"# Worker prompt\n\n## Review feedback (iteration 1)\n\nHandle the retry edge case.\n\n## Review feedback (iteration 2)\n\nAdd a regression test.\n",
		);
	});

	it("leaves the prompt unchanged for empty feedback", () => {
		assert.equal(appendReviewFeedback("# Worker prompt\n", " \n\t", 1), "# Worker prompt\n");
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
