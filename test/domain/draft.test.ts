import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	appendReviewFeedback,
	buildInterruptedResumeFeedback,
	normalizeReviewFeedback,
} from "../../src/domain/draft/feedback.ts";
import { extractNeedsInput, hasNeedsInputMarker, parseDraft } from "../../src/domain/draft/parse.ts";
import {
	buildRecommendedAnswers,
	formatNeedsInputAnswers,
	USE_BEST_JUDGEMENT_ANSWER,
} from "../../src/domain/draft/questions.ts";
import { appendNeedsInputAnswers } from "../../src/domain/draft/scope.ts";
import {
	FALLBACK_SLUG,
	HANDOFF_PROMPT_EXTENSION,
	HANDOFF_PROMPT_PREFIX,
	HANDOFF_TEMP_DIR,
	MAX_SLUG_LENGTH,
	buildPromptPath,
	slugify,
	stripIterationSuffix,
} from "../../src/domain/draft/slug.ts";
import type { Draft } from "../../src/domain/types.ts";
import { validateDraft, validateOrdinaryDraft } from "../../src/persistence/schemas.ts";

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

	it("carries BLUF and definition-of-done metadata through parsing", () => {
		const draft: Draft = {
			...DRAFT,
			bluf: "Add retries so transient failures recover.",
			definitionOfDone: ["Retries are bounded", "Focused tests pass"],
		};
		assert.deepEqual(parseDraft(fencedJson(draft), validateDraft), { ok: true, value: draft });
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

	it("accepts the distinct noLeftovers envelope", () => {
		const noLeftovers = { noLeftovers: true as const, rationale: "The structured list contains no worker work." };
		assert.deepEqual(parseDraft(JSON.stringify(noLeftovers), validateDraft), { ok: true, value: noLeftovers });
	});

	it("treats noLeftovers as unparseable for an ordinary draft", () => {
		const noLeftovers = { noLeftovers: true, rationale: "No worker work remains." };
		assert.equal(parseDraft(JSON.stringify(noLeftovers), validateOrdinaryDraft).ok, false);
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

/**
 * The drafting prompt forbids these outright; this is the belt to that braces.
 * A model reading a transcript that already contains review rounds keeps counting,
 * and a wrong number on the prompt filename is worse than none, because the
 * filename is what a reviewer greps for.
 */
describe("stripIterationSuffix", () => {
	it("strips a trailing iteration counter a model appended", () => {
		assert.equal(stripIterationSuffix("tg-feedback-command-iteration-1"), "tg-feedback-command");
	});

	it("strips the other counter words a model reaches for", () => {
		assert.equal(stripIterationSuffix("fix-nits-round-2"), "fix-nits");
		assert.equal(stripIterationSuffix("fix-nits-attempt-3"), "fix-nits");
		assert.equal(stripIterationSuffix("fix-nits-iter-2"), "fix-nits");
	});

	/**
	 * A version number is part of the task's name, not a counter. Stripping `-v\d+`
	 * turned `upgrade-next-v16` into `upgrade-next` and `migrate-api-v2` into
	 * `migrate-api`, which loses the one detail identifying the work; `pass` did the
	 * same to `first-pass-3`. Both are worse than leaving a stray counter, which the
	 * prompt rule already prevents in the normal case.
	 */
	it("leaves version and pass numbers alone, because those name the work", () => {
		assert.equal(stripIterationSuffix("upgrade-next-v16"), "upgrade-next-v16");
		assert.equal(stripIterationSuffix("migrate-api-v2"), "migrate-api-v2");
		assert.equal(stripIterationSuffix("fix-nits-pass-4"), "fix-nits-pass-4");
		assert.equal(stripIterationSuffix("first-pass-3"), "first-pass-3");
	});

	it("strips a doubled counter, since a model that adds one sometimes adds two", () => {
		assert.equal(stripIterationSuffix("fix-nits-round-2-iteration-1"), "fix-nits");
	});

	it("leaves a counter that is not trailing alone", () => {
		assert.equal(stripIterationSuffix("iteration-cache-fix"), "iteration-cache-fix");
	});

	it("keeps a slug that is only a counter rather than emptying it", () => {
		assert.equal(stripIterationSuffix("iteration-2"), "iteration-2");
	});

	it("leaves an ordinary slug untouched", () => {
		assert.equal(stripIterationSuffix("add-retry-logic"), "add-retry-logic");
	});

	it("does not strip a trailing number that is part of the name", () => {
		assert.equal(stripIterationSuffix("migrate-to-http2"), "migrate-to-http2");
	});

	it("is applied by slugify, so a prompt path never carries a false iteration", () => {
		assert.equal(slugify("TG feedback command (iteration 1)"), "tg-feedback-command");
		assert.equal(
			buildPromptPath("fix review nits (iteration 3)"),
			`${HANDOFF_TEMP_DIR}/${HANDOFF_PROMPT_PREFIX}fix-review-nits${HANDOFF_PROMPT_EXTENSION}`,
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

describe("buildInterruptedResumeFeedback", () => {
	const NOTE =
		"The worker failed: Internal server error. The text it had already produced is kept as pre-crash output.";

	/**
	 * That the iteration did not finish and was not reviewed belongs to the `resume`
	 * preamble; repeating it here opened one prompt section with the same sentence twice.
	 */
	it("leads with what ended the previous iteration", () => {
		const draft = buildInterruptedResumeFeedback(NOTE);

		assert.match(draft, /^What ended the previous iteration: /);
		assert.doesNotMatch(draft, /no review of it was captured/);
	});

	/** The note is the only account of what ended the run, so it is quoted rather than summarized. */
	it("quotes the interruption note verbatim", () => {
		assert.ok(buildInterruptedResumeFeedback(`  ${NOTE}  `).includes(NOTE));
	});

	it("tells the worker the changes are still there and must not be restarted", () => {
		const draft = buildInterruptedResumeFeedback(NOTE);

		assert.match(draft, /nothing was reverted/);
		assert.match(draft, /Do not start over/);
	});

	/** The unfinished text is evidence, not a result; the draft must not promote it either. */
	it("denies the unfinished output the status of a report and asks for a real one", () => {
		const draft = buildInterruptedResumeFeedback(NOTE);

		assert.match(draft, /is not a report/);
		assert.match(draft, /Write the final report/);
	});

	it("omits the reason line when no note was recorded", () => {
		const draft = buildInterruptedResumeFeedback("   ");

		assert.doesNotMatch(draft, /What ended the previous iteration/);
		assert.match(draft, /^The working tree still holds/);
		assert.match(draft, /Write the final report/);
	});

	/** The draft is sent through normalization, which must leave all of it intact. */
	it("survives feedback normalization unchanged", () => {
		const draft = buildInterruptedResumeFeedback(NOTE);

		assert.equal(normalizeReviewFeedback(draft), draft);
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

	/**
	 * The preamble tells the worker who inspected its tree, and only one of these paths
	 * had a reviewer. Crediting one on the others contradicted the instructions directly
	 * below it, which is how a resume draft arrived under "address only these".
	 */
	describe("unreviewed sources", () => {
		it("names the user rather than a reviewer for an unreviewed iteration", () => {
			const appended = appendReviewFeedback(
				"# Worker prompt",
				"Handle the retry edge case.",
				2,
				CHECKPOINT_HEAD,
				"user",
			);

			assert.match(appended, /## Instructions from the user \(iteration 2\)/);
			assert.match(appended, /The instructions below come from the user, not from a reviewer\./);
			assert.doesNotMatch(appended, /A reviewer inspected that tree/);
		});

		it("keeps the no-restart rule on every source", () => {
			for (const source of ["review", "user", "resume"] as const) {
				const appended = appendReviewFeedback("# Worker prompt", "Carry on.", 2, CHECKPOINT_HEAD, source);
				assert.match(appended, /do not start over/, source);
				assert.match(appended, /checkpoint `abc1234`/, source);
			}
		});

		it("says an interrupted iteration left work unfinished", () => {
			const appended = appendReviewFeedback("# Worker prompt", "Carry on.", 2, CHECKPOINT_HEAD, "resume");

			assert.match(appended, /The previous iteration did not finish, and no review of it was captured\./);
			assert.match(appended, /finish this handoff's remaining work/);
			assert.doesNotMatch(appended, /Address only these/);
		});

		/** The reviewed path is the default so existing callers keep their exact wording. */
		it("defaults to the reviewed wording", () => {
			assert.equal(
				appendReviewFeedback("# Worker prompt", "Carry on.", 1, CHECKPOINT_HEAD),
				appendReviewFeedback("# Worker prompt", "Carry on.", 1, CHECKPOINT_HEAD, "review"),
			);
		});
	});
});

describe("formatNeedsInputAnswers", () => {
	it("renders deterministic question and answer pairs", () => {
		assert.equal(
			formatNeedsInputAnswers([
				{ question: { question: "Which mode?" }, answer: "Safe" },
				{ question: { question: "Which timeout?" }, answer: "30 seconds" },
			]),
			"Q: Which mode?\nA: Safe\n\nQ: Which timeout?\nA: 30 seconds",
		);
	});
});

/**
 * Backs "Proceed with recommended answers", the escape hatch from a drafting model
 * that keeps asking rather than converging — four rounds and thirty-five minutes
 * before Gate A, in the case that motivated it.
 */
describe("buildRecommendedAnswers", () => {
	it("takes the recommended choice as the answer", () => {
		assert.deepEqual(
			buildRecommendedAnswers([{ question: "Which policy?", choices: ["Fixed", "Exponential"], recommended: 1 }]).map(
				(entry) => entry.answer,
			),
			["Exponential"],
		);
	});

	it("delegates judgement for a free-text question", () => {
		assert.deepEqual(
			buildRecommendedAnswers([{ question: "What timeout?" }]).map((entry) => entry.answer),
			[USE_BEST_JUDGEMENT_ANSWER],
		);
	});

	it("delegates judgement for choices the model would not rank", () => {
		assert.deepEqual(
			buildRecommendedAnswers([{ question: "Which policy?", choices: ["Fixed", "Exponential"] }]).map(
				(entry) => entry.answer,
			),
			[USE_BEST_JUDGEMENT_ANSWER],
		);
	});

	/** Normalization drops an unusable index, so it can never be read as an answer. */
	it("delegates judgement when the recommendation does not select a real choice", () => {
		assert.deepEqual(
			buildRecommendedAnswers([{ question: "Which policy?", choices: ["Fixed"], recommended: 7 }]).map(
				(entry) => entry.answer,
			),
			[USE_BEST_JUDGEMENT_ANSWER],
		);
	});

	it("closes the question explicitly, so the next draft cannot re-ask it", () => {
		assert.match(USE_BEST_JUDGEMENT_ANSWER, /do not ask again/);
	});

	it("answers every question, since a partial set would reopen the gate", () => {
		const answers = buildRecommendedAnswers([
			{ question: "A?", choices: ["x", "y"], recommended: 0 },
			{ question: "B?" },
			{ question: "C?", choices: ["p"] },
		]);
		assert.equal(answers.length, 3);
		assert.ok(answers.every((entry) => entry.answer !== ""));
	});

	it("renders through the ordinary answer transcript", () => {
		const answered = formatNeedsInputAnswers(
			buildRecommendedAnswers([{ question: "Which policy?", choices: ["Fixed", "Exponential"], recommended: 1 }]),
		);
		assert.equal(answered, "Q: Which policy?\nA: Exponential");
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
	it("detects an explicit uppercase marker at the start of a line", () => {
		for (const prompt of [
			"## NEEDS INPUT",
			"NEEDS INPUT: which retry policy applies to streaming calls?",
			"  NEEDS INPUT: which retry policy applies to streaming calls?",
			"*NEEDS INPUT*: which retry policy applies to streaming calls?",
			"_NEEDS INPUT: which retry policy applies to streaming calls.",
			"`NEEDS INPUT`: which retry policy applies to streaming calls?",
		]) {
			assert.equal(hasNeedsInputMarker(prompt), true, prompt);
		}
	});

	it("does not mistake task titles and mid-sentence references for a marker", () => {
		for (const prompt of [
			"# Task: Replace the NEEDS INPUT editor flow with structured questions and per-question answering in `pi-handoff`",
			"# Task: Restructure the NEEDS INPUT flow in `pi-handoff` (structured questions, per-question answering, persistence)",
			"Clarify the API contract. NEEDS INPUT before implementation.",
		]) {
			assert.equal(hasNeedsInputMarker(prompt), false, prompt);
		}
	});

	it("preserves negative near-matches and lowercase prose", () => {
		for (const prompt of [
			"NEEDS INPUTS: clarify the retry policy.",
			"NEEDS-INPUT: clarify the retry policy.",
			"NEEDS_INPUT: clarify the retry policy.",
			"NEEDS  INPUT: clarify the retry policy.",
			"needs input: clarify the retry policy.",
		]) {
			assert.equal(hasNeedsInputMarker(prompt), false, prompt);
		}
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
			"NEEDS INPUT — which retry policy applies to streaming calls?",
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

	it("skips mid-sentence references before the marker heading", () => {
		const prompt = [
			"## In scope",
			"",
			"This work is subject to the NEEDS INPUT decision below.",
			"",
			"## NEEDS INPUT",
			"",
			"1. Confirm the completion command should be unhidden.",
			"2. Decide where it should appear in help output.",
			"",
			"## Implementation guidance",
			"",
			"Do not include this guidance in the questions.",
		].join("\n");
		assert.equal(
			extractNeedsInput(prompt),
			"1. Confirm the completion command should be unhidden.\n2. Decide where it should appear in help output.",
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
