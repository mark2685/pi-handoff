import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_RUBRIC } from "../../src/domain/rubric/defaults.ts";
import { isModelAvailable, parseModelReference, resolveTier } from "../../src/domain/rubric/resolve.ts";
import type { AvailableModel, ModelCandidate, Rubric, Tier } from "../../src/domain/types.ts";

const AVAILABLE_MODELS: AvailableModel[] = [
	{ provider: "bifrost", id: "claude-3-haiku" },
	{ provider: "bifrost", id: "claude-fable-5-1" },
	{ provider: "bifrost", id: "claude-opus-4-8" },
	{ provider: "bifrost", id: "claude-opus-5" },
	{ provider: "bifrost", id: "claude-sonnet-5" },
	{ provider: "bifrost-openai", id: "gpt-5.6-luna" },
	{ provider: "bifrost-openai", id: "gpt-5.6-terra" },
];

function rubricWithStandardCandidates(
	candidates: ModelCandidate[],
	excludeModels = DEFAULT_RUBRIC.excludeModels,
): Rubric {
	return {
		...DEFAULT_RUBRIC,
		tiers: { ...DEFAULT_RUBRIC.tiers, standard: candidates },
		excludeModels,
	};
}

describe("rubric defaults", () => {
	it("contains every supported tier", () => {
		const tiers: Tier[] = ["routine", "standard", "hard", "frontier"];
		assert.deepEqual(Object.keys(DEFAULT_RUBRIC.tiers).sort(), [...tiers].sort());
	});

	it("assigns at least one candidate to every tier", () => {
		for (const candidates of Object.values(DEFAULT_RUBRIC.tiers)) {
			assert.ok(candidates.length > 0);
		}
	});
});

describe("resolveTier", () => {
	it("uses the first available candidate", () => {
		const resolution = resolveTier(DEFAULT_RUBRIC, "standard", AVAILABLE_MODELS);
		assert.deepEqual(resolution, {
			kind: "resolved",
			choice: { provider: "bifrost-openai", model: "gpt-5.6-terra", thinking: "high" },
		});
	});

	it("falls through to the next candidate when the first is unavailable", () => {
		const resolution = resolveTier(DEFAULT_RUBRIC, "standard", [{ provider: "bifrost", id: "claude-sonnet-5" }]);
		assert.deepEqual(resolution, {
			kind: "resolved",
			choice: { provider: "bifrost", model: "claude-sonnet-5", thinking: "high" },
		});
	});

	it("skips excluded candidates even when they are available", () => {
		const resolution = resolveTier(
			rubricWithStandardCandidates(DEFAULT_RUBRIC.tiers.standard, ["bifrost-openai/gpt-5.6-terra"]),
			"standard",
			AVAILABLE_MODELS,
		);
		assert.deepEqual(resolution, {
			kind: "resolved",
			choice: { provider: "bifrost", model: "claude-sonnet-5", thinking: "high" },
		});
	});

	it("returns none available when each candidate is unavailable or excluded", () => {
		const rubric = rubricWithStandardCandidates(
			[
				{ model: "bifrost-openai/gpt-5.6-terra", thinking: "high" },
				{ model: "bifrost/claude-sonnet-5", thinking: "high" },
			],
			["bifrost/claude-sonnet-5"],
		);
		assert.deepEqual(resolveTier(rubric, "standard", [{ provider: "bifrost", id: "claude-sonnet-5" }]), {
			kind: "none_available",
		});
	});

	it("resolves every shipped tier against the live-catalog-shaped fixture", () => {
		const tiers: Tier[] = ["routine", "standard", "hard", "frontier"];
		for (const tier of tiers) {
			assert.equal(resolveTier(DEFAULT_RUBRIC, tier, AVAILABLE_MODELS).kind, "resolved", tier);
		}
	});

	it("preserves slashes within a model id", () => {
		const rubric = rubricWithStandardCandidates([{ model: "provider/model/with/slashes", thinking: "low" }]);
		assert.deepEqual(resolveTier(rubric, "standard", [{ provider: "provider", id: "model/with/slashes" }]), {
			kind: "resolved",
			choice: { provider: "provider", model: "model/with/slashes", thinking: "low" },
		});
	});
});

describe("model registry helpers", () => {
	it("checks availability using a canonical provider/model identifier", () => {
		assert.equal(
			isModelAvailable("provider/model/with/slashes", [{ provider: "provider", id: "model/with/slashes" }]),
			true,
		);
	});

	it("rejects malformed model identifiers", () => {
		assert.equal(parseModelReference("provider"), undefined);
	});
});
