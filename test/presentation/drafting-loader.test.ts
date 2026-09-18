import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { formatDraftingLoaderMessage } from "../../src/presentation/drafting-loader.ts";

describe("formatDraftingLoaderMessage", () => {
	it("shows the existing message and zero elapsed time", () => {
		assert.equal(
			formatDraftingLoaderMessage({ message: "Drafting handoff…", elapsedMs: 0 }),
			"Drafting handoff… · Elapsed: 0s",
		);
	});

	it("uses the running widget's elapsed-time format for minutes", () => {
		assert.equal(
			formatDraftingLoaderMessage({ message: "Drafting handoff…", elapsedMs: 125_000 }),
			"Drafting handoff… · Elapsed: 2m 05s",
		);
	});

	it("names the model when the drafting call has one", () => {
		assert.equal(
			formatDraftingLoaderMessage({
				message: "Drafting handoff…",
				elapsedMs: 1_000,
				model: "bifrost/claude-opus-5",
			}),
			"Drafting handoff… · Elapsed: 1s · Model: bifrost/claude-opus-5",
		);
	});

	it("truncates the whole live message to the loader width", () => {
		assert.equal(
			stripTerminalSequences(
				formatDraftingLoaderMessage(
					{ message: "Drafting handoff…", elapsedMs: 1_000, model: "bifrost/claude-opus-5" },
					30,
				),
			),
			"Drafting handoff… · Elapsed: …",
		);
	});
});
