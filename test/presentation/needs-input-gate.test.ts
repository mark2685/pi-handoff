/**
 * Tests for the NEEDS INPUT gate's pure formatter.
 *
 * Only the summary lines are asserted here; the overlay shell follows the same
 * untestable-key-handling shape as Gate A and Gate B and holds no decisions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatNeedsInputSummary, type NeedsInputView } from "../../src/presentation/needs-input-gate.ts";

const VIEW: NeedsInputView = {
	slug: "add-retry-logic",
	promptPath: "/tmp/pi-handoff-add-retry-logic.md",
	questions: "1. Which retry policy applies to streaming calls?\n2. Should the timeout be configurable?",
};

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
});
