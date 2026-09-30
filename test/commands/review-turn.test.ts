import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { classifyReviewTurn, finalAssistantText } from "../../src/commands/review-turn.ts";

function messages(value: unknown): AgentEndEvent["messages"] {
	return value as AgentEndEvent["messages"];
}

describe("finalAssistantText", () => {
	it("returns text from the final assistant message rather than an earlier one", () => {
		assert.equal(
			finalAssistantText(
				messages([
					{ role: "assistant", content: [{ type: "text", text: "Earlier response." }] },
					{ role: "toolResult", content: [{ type: "text", text: "tool output" }] },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "Final finding.\n" },
							{ type: "text", text: "Verdict: fix" },
						],
					},
				]),
			),
			"Final finding.\nVerdict: fix",
		);
	});

	it("returns undefined when the run has no assistant response", () => {
		assert.equal(finalAssistantText(messages([{ role: "user", content: "Review this." }])), undefined);
	});
});

describe("classifyReviewTurn", () => {
	it("reports an ordinary reviewer response as a review", () => {
		assert.deepEqual(
			classifyReviewTurn(
				messages([
					{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Findings.\nVerdict: fix" }] },
				]),
			),
			{ kind: "review", text: "Findings.\nVerdict: fix" },
		);
	});

	/** The 402 shape: an error stop reason with no content, which reads as empty text. */
	it("reports a turn that ended on an error as a failure, with the provider's message", () => {
		assert.deepEqual(
			classifyReviewTurn(
				messages([{ role: "assistant", stopReason: "error", errorMessage: "402 Budget exceeded", content: [] }]),
			),
			{ kind: "failed", errorMessage: "402 Budget exceeded" },
		);
	});

	it("reports a failure even when the error carried text the model had already written", () => {
		assert.deepEqual(
			classifyReviewTurn(
				messages([{ role: "assistant", stopReason: "error", content: [{ type: "text", text: "Reading the diff" }] }]),
			),
			{ kind: "failed", errorMessage: undefined },
		);
	});

	/** Escape keeps what the reviewer had streamed; that is a truncated review, not a review. */
	it("reports a stopped turn as stopped even when it had already written text", () => {
		assert.deepEqual(
			classifyReviewTurn(
				messages([
					{ role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "The diff looks right so f" }] },
				]),
			),
			{ kind: "stopped" },
		);
	});

	it("reports a stopped turn with no text as stopped rather than empty", () => {
		assert.deepEqual(classifyReviewTurn(messages([{ role: "assistant", stopReason: "aborted", content: [] }])), {
			kind: "stopped",
		});
	});

	it("reports a whitespace-only response as no review rather than a review", () => {
		assert.deepEqual(
			classifyReviewTurn(
				messages([{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "  " }] }]),
			),
			{ kind: "empty" },
		);
	});

	it("reports a run with no assistant message as no review", () => {
		assert.deepEqual(classifyReviewTurn(messages([{ role: "user", content: "Review this." }])), { kind: "empty" });
	});

	it("classifies the final assistant message, not an earlier failed one", () => {
		assert.deepEqual(
			classifyReviewTurn(
				messages([
					{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded", content: [] },
					{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Verdict: accept" }] },
				]),
			),
			{ kind: "review", text: "Verdict: accept" },
		);
	});
});
