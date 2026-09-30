/**
 * Tests for the drafting side-call adapter's failure mapping.
 *
 * `modelRegistry.complete` resolves for provider failures instead of throwing, so
 * the stop reason is the only place a 402, a rate limit, or a truncation is
 * stated. These cases exist because every one of them used to arrive at the user
 * as "The drafting model returned no text", which names neither the cause nor a
 * way out.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiDraftingModel } from "../../src/adapters/pi-drafting-model.ts";

const MODEL = { provider: "bifrost", id: "claude-sonnet-5" } as unknown as Model<Api>;

/** Builds a context whose only capability is one canned completion response. */
function contextReturning(response: Record<string, unknown>): ExtensionContext {
	return {
		modelRegistry: {
			complete: async () => response,
		},
	} as unknown as ExtensionContext;
}

/** Runs one drafting call with no cancellation signal. */
async function draft(response: Record<string, unknown>) {
	return createPiDraftingModel(contextReturning(response), MODEL).complete({
		systemPrompt: "system",
		userMessage: "user",
		signal: undefined,
	});
}

describe("createPiDraftingModel", () => {
	it("returns the assistant text of a successful completion", async () => {
		const result = await draft({ stopReason: "stop", content: [{ type: "text", text: '{"slug":"x"}' }] });
		assert.ok(result.ok);
		assert.equal(result.value, '{"slug":"x"}');
	});

	it("reports a provider error with the provider's own message", async () => {
		const result = await draft({
			stopReason: "error",
			content: [],
			errorMessage: "402 Budget exceeded",
		});
		assert.equal(result.ok, false);
		assert.deepEqual(result.ok === false ? result.error : undefined, {
			kind: "completion_failed",
			detail: "402 Budget exceeded",
		});
	});

	it("still names a provider error that carried no message", async () => {
		const result = await draft({ stopReason: "error", content: [] });
		assert.equal(result.ok === false && result.error.kind, "completion_failed");
		assert.match(result.ok === false && result.error.kind === "completion_failed" ? result.error.detail : "", /error/);
	});

	it("reports a response truncated before any text as a failure, not an empty answer", async () => {
		const result = await draft({ stopReason: "length", content: [] });
		assert.equal(result.ok === false && result.error.kind, "completion_failed");
		assert.match(
			result.ok === false && result.error.kind === "completion_failed" ? result.error.detail : "",
			/output limit/,
		);
	});

	it("keeps empty_response for a genuinely empty reply", async () => {
		const result = await draft({ stopReason: "stop", content: [{ type: "text", text: "   " }] });
		assert.equal(result.ok === false && result.error.kind, "empty_response");
	});

	it("reports an aborted completion as cancellation rather than failure", async () => {
		const result = await draft({ stopReason: "aborted", content: [] });
		assert.equal(result.ok === false && result.error.kind, "aborted");
	});
});
