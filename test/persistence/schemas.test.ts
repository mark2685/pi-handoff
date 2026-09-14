import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_RUBRIC } from "../../src/domain/rubric/defaults.ts";
import { MAX_RUBRIC_ITERATIONS, validateRubric } from "../../src/persistence/schemas.ts";

const validRubric = {
	tiers: {
		routine: [{ model: "provider/routine", thinking: "off" }],
		standard: [{ model: "provider/standard", thinking: "minimal" }],
		hard: [{ model: "provider/hard", thinking: "max" }],
		frontier: [{ model: "provider/frontier", thinking: "xhigh" }],
	},
	maxIterations: 1,
	excludeModels: ["provider/legacy"],
};

describe("validateRubric", () => {
	it("accepts a valid config", () => {
		assert.equal(validateRubric(validRubric).ok, true);
	});

	it("rejects an unknown tier", () => {
		const result = validateRubric({
			...validRubric,
			tiers: { ...validRubric.tiers, experimental: [{ model: "provider/model", thinking: "high" }] },
		});
		assert.equal(result.ok, false);
	});

	it("rejects a missing tiers field", () => {
		const { tiers, ...withoutTiers } = validRubric;
		assert.equal(validateRubric(withoutTiers).ok, false);
	});

	it("rejects an unknown thinking level", () => {
		const result = validateRubric({
			...validRubric,
			tiers: {
				...validRubric.tiers,
				routine: [{ model: "provider/routine", thinking: "extreme" }],
			},
		});
		assert.equal(result.ok, false);
	});

	it("rejects maxIterations below one", () => {
		assert.equal(validateRubric({ ...validRubric, maxIterations: 0 }).ok, false);
	});

	it("rejects maxIterations above the bounded feedback-loop limit", () => {
		assert.equal(validateRubric({ ...validRubric, maxIterations: MAX_RUBRIC_ITERATIONS + 1 }).ok, false);
	});

	it("rejects a malformed candidate model identifier", () => {
		const result = validateRubric({
			...validRubric,
			tiers: {
				...validRubric.tiers,
				routine: [{ model: "missing-separator", thinking: "medium" }],
			},
		});
		assert.equal(result.ok, false);
	});

	it("accepts the shipped defaults", () => {
		assert.equal(validateRubric(DEFAULT_RUBRIC).ok, true);
	});
});
