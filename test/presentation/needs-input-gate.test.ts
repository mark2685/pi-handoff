/**
 * Tests for the NEEDS INPUT gate's pure formatter.
 *
 * Only the summary lines are asserted here; the overlay shell follows the same
 * untestable-key-handling shape as Gate A and Gate B and holds no decisions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatNeedsInputSummary, type NeedsInputView } from "../../src/presentation/needs-input-gate.ts";
import { needsInputMenu } from "../../src/presentation/menus.ts";

const VIEW: NeedsInputView = {
	slug: "add-retry-logic",
	promptPath: "/tmp/pi-handoff-add-retry-logic.md",
	questions: [
		{ question: "Which retry policy applies to streaming calls?" },
		{ question: "Should the timeout be configurable?" },
	],
};

describe("needsInputMenu", () => {
	it("keeps Cancel out of the default landing position and offers a read-only draft view", () => {
		assert.deepEqual(
			needsInputMenu().map((option) => option.id),
			["answer", "edit", "view", "cancel"],
		);
	});
});

describe("formatNeedsInputSummary", () => {
	it("explains that the draft could not run because decisions are open", () => {
		const lines = formatNeedsInputSummary(VIEW);
		assert.equal(
			lines[0],
			'The draft for "add-retry-logic" left decisions open and cannot run until they are answered.',
		);
	});

	it("shows the prompt path", () => {
		const lines = formatNeedsInputSummary(VIEW);
		assert.ok(lines.includes("Prompt:    /tmp/pi-handoff-add-retry-logic.md"));
	});

	it("shows the extracted questions, one line each", () => {
		const lines = formatNeedsInputSummary(VIEW);
		assert.ok(lines.includes("1. Which retry policy applies to streaming calls?"));
		assert.ok(lines.includes("2. Should the timeout be configurable?"));
	});

	it("renders context, lettered choices, and the recommendation", () => {
		const lines = formatNeedsInputSummary({
			...VIEW,
			questions: [
				{ question: "Choose a mode", context: "The worker uses this mode.", choices: ["Fast", "Safe"], recommended: 1 },
			],
		});
		assert.deepEqual(lines.slice(3), [
			"1. Choose a mode",
			"   The worker uses this mode.",
			"   A. Fast",
			"   B. Safe (recommended)",
		]);
	});

	it("separates the header fields from the questions with a blank line", () => {
		const lines = formatNeedsInputSummary(VIEW);
		const promptIndex = lines.indexOf("Prompt:    /tmp/pi-handoff-add-retry-logic.md");
		assert.equal(lines[promptIndex + 1], "");
	});

	it("does not include the full prompt, only the extracted questions", () => {
		const lines = formatNeedsInputSummary(VIEW);
		assert.equal(
			lines.some((line) => line.includes("Implement")),
			false,
		);
	});

	it("is unchanged when the extracted questions fit within the cap", () => {
		const questions = Array.from({ length: 40 }, (_value, index) => ({ question: `Question ${index + 1}?` }));
		const lines = formatNeedsInputSummary({ ...VIEW, questions });
		assert.deepEqual(
			lines.slice(3),
			questions.map((question, index) => `${index + 1}. ${question.question}`),
		);
	});

	it("caps question lines and points to the full prompt when extraction is over-broad", () => {
		const questions = Array.from({ length: 41 }, (_value, index) => ({ question: `Question ${index + 1}?` }));
		const lines = formatNeedsInputSummary({ ...VIEW, questions });
		assert.deepEqual(lines.slice(3), [
			...questions.slice(0, 40).map((question, index) => `${index + 1}. ${question.question}`),
			"Questions truncated after 40 lines; see /tmp/pi-handoff-add-retry-logic.md.",
		]);
	});
});
