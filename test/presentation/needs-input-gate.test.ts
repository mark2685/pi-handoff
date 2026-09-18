/**
 * Tests for the NEEDS INPUT gate's pure formatter.
 *
 * Only the summary lines are asserted here; the overlay shell follows the same
 * untestable-key-handling shape as Gate A and Gate B and holds no decisions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatNeedsInputSummary, type NeedsInputView } from "../../src/presentation/needs-input-gate.ts";
import { needsInputMenu, PROCEED_WITH_RECOMMENDED_ROUND } from "../../src/presentation/menus.ts";

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

	/**
	 * Withheld before the third round because it is a blunt instrument: it answers every
	 * open question at once, including the ones the model gave no recommendation for.
	 * Two rounds is a model converging; four rounds and thirty-five minutes is not.
	 */
	it("withholds the proceed escape hatch for the first two rounds", () => {
		for (const round of [1, 2]) {
			assert.equal(
				needsInputMenu({ round }).some((option) => option.id === "proceed"),
				false,
				`round ${round} must not offer proceed`,
			);
		}
	});

	it("offers the proceed escape hatch from the third round on", () => {
		for (const round of [PROCEED_WITH_RECOMMENDED_ROUND, 4, 9]) {
			assert.ok(
				needsInputMenu({ round }).some((option) => option.id === "proceed"),
				`round ${round} must offer proceed`,
			);
		}
	});

	it("keeps Answer first, so proceeding is never the default landing position", () => {
		assert.equal(needsInputMenu({ round: 4 })[0]?.id, "answer");
	});

	it("names the round in the proceed description", () => {
		const proceed = needsInputMenu({ round: 4 }).find((option) => option.id === "proceed");
		assert.match(proceed?.description ?? "", /Round 4/);
	});

	it("keeps every existing option when proceed is added", () => {
		const ids = needsInputMenu({ round: 3 }).map((option) => option.id);
		for (const id of ["answer", "edit", "view", "cancel"]) {
			assert.ok(ids.includes(id as (typeof ids)[number]), `${id} must survive`);
		}
	});
});

describe("formatNeedsInputSummary round", () => {
	/** A user four rounds deep has no other way to see the questioning is not converging. */
	it("states the round from the second round on", () => {
		const lines = formatNeedsInputSummary({ ...VIEW, round: 3 });
		assert.ok(lines.includes("Round:     3 of questions for this handoff"));
	});

	it("stays silent about the round on the first one", () => {
		for (const view of [VIEW, { ...VIEW, round: 1 }]) {
			assert.equal(
				formatNeedsInputSummary(view).some((line) => line.startsWith("Round:")),
				false,
			);
		}
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
