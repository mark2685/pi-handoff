/**
 * Tests for the drafting prompt's load-bearing instructions.
 *
 * The prompt is data, not logic, so these assert the presence of the rules the
 * rest of the system depends on rather than any behavior. The iteration-numbering
 * rule earns its test the hard way: without it, a drafting model reading a
 * transcript that already contains review rounds keeps counting, and produced a
 * slug of `tg-feedback-command-iteration-1` for a run the extension executed as
 * iteration 2, plus a draft titled "(iteration 3)" for a brand-new handoff at
 * iteration 1. The extension owns the number; the prompt has to say so.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildDraftingUserMessage,
	buildLeftoversUserMessage,
	DRAFTING_SYSTEM_PROMPT,
	NEEDS_INPUT_ANSWERS_HEADING,
	NEEDS_INPUT_MARKER,
} from "../../src/prompts/drafting-prompt.ts";

describe("DRAFTING_SYSTEM_PROMPT iteration numbering", () => {
	it("states that the extension owns iteration numbering", () => {
		assert.match(DRAFTING_SYSTEM_PROMPT, /extension owns iteration and round numbering/);
	});

	it("forbids an iteration number in the slug and the top heading", () => {
		assert.match(DRAFTING_SYSTEM_PROMPT, /Never encode an iteration, round, attempt, or pass number in the "slug"/);
		assert.match(DRAFTING_SYSTEM_PROMPT, /or in the prompt's top heading/);
	});

	it("names the concrete forms it must not emit", () => {
		assert.match(DRAFTING_SYSTEM_PROMPT, /-iteration-2/);
		assert.match(DRAFTING_SYSTEM_PROMPT, /\(iteration 3\)/);
		assert.match(DRAFTING_SYSTEM_PROMPT, /round 2/);
	});

	/** The reason the rule exists: the transcript is not evidence of the next number. */
	it("explains that a number inferred from the transcript is usually wrong", () => {
		assert.match(DRAFTING_SYSTEM_PROMPT, /may already contain earlier handoffs and their review rounds/);
		assert.match(DRAFTING_SYSTEM_PROMPT, /a number you infer from it is almost always wrong/);
	});
});

describe("DRAFTING_SYSTEM_PROMPT contract", () => {
	it("still requires a tier rather than a concrete model", () => {
		assert.match(DRAFTING_SYSTEM_PROMPT, /Never name a concrete model/);
	});

	it("still routes open decisions into structured questions", () => {
		assert.match(DRAFTING_SYSTEM_PROMPT, /Put each remaining decision in the envelope's "questions" array/);
	});

	it("still treats answered question pairs as decided", () => {
		assert.ok(DRAFTING_SYSTEM_PROMPT.includes(NEEDS_INPUT_ANSWERS_HEADING));
		assert.match(DRAFTING_SYSTEM_PROMPT, /already decided and do not re-ask it/);
	});

	it("still describes the prose marker as a fallback only", () => {
		assert.ok(DRAFTING_SYSTEM_PROMPT.includes(`## ${NEEDS_INPUT_MARKER}`));
		assert.match(DRAFTING_SYSTEM_PROMPT, /compatibility fallback only/);
	});

	it("requires one-line BLUF and bounded checkable definition of done metadata", () => {
		assert.match(DRAFTING_SYSTEM_PROMPT, /"bluf": one sentence on one line/);
		assert.match(
			DRAFTING_SYSTEM_PROMPT,
			/"definitionOfDone": at most five short, concrete, checkable completion conditions/,
		);
		assert.match(DRAFTING_SYSTEM_PROMPT, /must contain no more than five short checkable conditions/);
	});
});

describe("buildDraftingUserMessage", () => {
	it("includes the conversation and the supplied scope", () => {
		const message = buildDraftingUserMessage("a transcript", "narrow it to the client");
		assert.match(message, /## Conversation History/);
		assert.match(message, /a transcript/);
		assert.match(message, /narrow it to the client/);
	});

	it("substitutes a default when no scope was supplied", () => {
		assert.match(buildDraftingUserMessage("a transcript", "   "), /None supplied/);
	});
});

/**
 * The leftovers message is defined by an absence, so these assert the absence.
 * Its whole economy is that the accepted prompt and the review text replace the
 * transcript rather than being appended to it.
 */
describe("buildLeftoversUserMessage", () => {
	const SCOPE = "Draft a follow-up covering only the remaining items the review flagged.";

	it("carries the scope", () => {
		assert.match(buildLeftoversUserMessage(SCOPE), /only the remaining items the review flagged/);
	});

	it("emits no conversation history section", () => {
		assert.equal(buildLeftoversUserMessage(SCOPE).includes("## Conversation History"), false);
	});

	/**
	 * Stated rather than merely omitted: a model told it normally receives a
	 * transcript would otherwise read the gap as a defect and hedge, or ask for the
	 * history back as a NEEDS INPUT question.
	 */
	it("tells the model the omission is deliberate and not to ask for the conversation", () => {
		const message = buildLeftoversUserMessage(SCOPE);
		assert.match(message, /deliberately no conversation history/);
		assert.match(message, /do not ask for the conversation/);
	});

	it("gives leftovers drafters a no-leftovers envelope exit without changing the ordinary contract", () => {
		const message = buildLeftoversUserMessage(SCOPE);
		assert.match(message, /"noLeftovers": true/);
		assert.match(message, /do not include `slug`, `prompt`, or `tier`/);
		assert.match(message, /Otherwise use the ordinary drafting envelope contract/);
	});
});
