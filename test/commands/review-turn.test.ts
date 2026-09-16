import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { finalAssistantText } from "../../src/commands/review-turn.ts";

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
