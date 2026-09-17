import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_RUBRIC } from "../../src/domain/rubric/defaults.ts";
import { createHandoffMachine, serializeHandoffState } from "../../src/app/handoff-machine.ts";
import type { Checkpoint, Draft, ModelChoice } from "../../src/domain/types.ts";
import type { WorkerUsage } from "../../src/ports/worker-runner.ts";
import {
	MAX_DRAFT_QUESTIONS,
	MAX_RUBRIC_ITERATIONS,
	validateDraft,
	validateHandoffState,
	validateRubric,
} from "../../src/persistence/schemas.ts";

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

const validDraft = {
	slug: "add-retry-logic",
	prompt: "Implement the retry logic and run the focused tests.",
	tier: "standard",
	rationale: "The change spans two files but has narrow verification.",
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

const validCheckpoint: Checkpoint = {
	repositoryRoot: "/repo",
	head: "abc123",
	statuses: [{ indexStatus: "M", worktreeStatus: " ", path: "src/file.ts" }],
};

const validChoice: ModelChoice = { provider: "provider", model: "worker", thinking: "high" };

const validUsage: WorkerUsage = {
	inputTokens: 1,
	outputTokens: 2,
	cacheReadTokens: 3,
	cacheWriteTokens: 4,
	cost: 0.01,
	contextTokens: 5,
	turns: 1,
};

const validHandoffDraft: Draft = { ...validDraft, tier: "standard" };

const validCompletedState = {
	kind: "reviewing",
	completion: "completed",
	draft: validHandoffDraft,
	choice: validChoice,
	iteration: 0,
	checkpoint: validCheckpoint,
	report: "Implemented it.",
	diffstat: " 1 file changed",
	usage: validUsage,
	awaitingReviewTurn: false,
};

describe("validateDraft", () => {
	it("accepts a valid drafting envelope", () => {
		assert.deepEqual(validateDraft(validDraft), { ok: true, value: validDraft });
	});

	it("accepts structured questions and normalizes unusable recommendations away", () => {
		const result = validateDraft({
			...validDraft,
			questions: [
				{ question: "Choose a mode", choices: ["Fast", "Safe"], recommended: 1 },
				{ question: "No choices", recommended: 0 },
				{ question: "Bad index", choices: ["Only"], recommended: -1 },
			],
		});
		assert.deepEqual(result, {
			ok: true,
			value: {
				...validDraft,
				questions: [
					{ question: "Choose a mode", choices: ["Fast", "Safe"], recommended: 1 },
					{ question: "No choices" },
					{ question: "Bad index", choices: ["Only"] },
				],
			},
		});
	});

	it("rejects more than the bounded number of questions", () => {
		assert.equal(
			validateDraft({
				...validDraft,
				questions: Array.from({ length: MAX_DRAFT_QUESTIONS + 1 }, (_value, index) => ({
					question: `Question ${index}`,
				})),
			}).ok,
			false,
		);
	});

	it("accepts every supported tier", () => {
		for (const tier of ["routine", "standard", "hard", "frontier"]) {
			assert.deepEqual(validateDraft({ ...validDraft, tier }), { ok: true, value: { ...validDraft, tier } });
		}
	});

	it("rejects an unknown tier", () => {
		assert.equal(validateDraft({ ...validDraft, tier: "experimental" }).ok, false);
	});

	it("rejects a missing prompt", () => {
		const { prompt, ...withoutPrompt } = validDraft;
		assert.equal(validateDraft(withoutPrompt).ok, false);
	});

	it("rejects an empty prompt", () => {
		assert.equal(validateDraft({ ...validDraft, prompt: "" }).ok, false);
	});

	it("rejects an unknown envelope property", () => {
		assert.equal(validateDraft({ ...validDraft, unexpected: true }).ok, false);
	});

	it("rejects wrong field types", () => {
		assert.equal(validateDraft({ slug: 1, prompt: [], tier: true, rationale: {} }).ok, false);
	});
});

describe("validateHandoffState", () => {
	it("accepts a valid persisted completed review", () => {
		assert.deepEqual(validateHandoffState(validCompletedState), { ok: true, value: validCompletedState });
	});

	it("rejects unknown persisted-state properties", () => {
		assert.equal(validateHandoffState({ ...validCompletedState, unexpected: true }).ok, false);
	});

	it("rejects a malformed idle variant", () => {
		assert.equal(validateHandoffState({ kind: "idle", scope: "not idle" }).ok, false);
	});

	it("rejects a malformed drafting variant", () => {
		assert.equal(validateHandoffState({ kind: "drafting" }).ok, false);
	});

	it("accepts an older drafting entry with no pending draft", () => {
		assert.deepEqual(validateHandoffState({ kind: "drafting", scope: "old session" }), {
			ok: true,
			value: { kind: "drafting", scope: "old session" },
		});
	});

	it("rejects a malformed proposed variant", () => {
		assert.equal(validateHandoffState({ kind: "proposed", draft: validHandoffDraft }).ok, false);
	});

	it("rejects a malformed running variant", () => {
		assert.equal(
			validateHandoffState({
				kind: "running",
				draft: validHandoffDraft,
				choice: validChoice,
				iteration: 0,
				startedAt: "2026-03-16T12:00:00.000Z",
			}).ok,
			false,
		);
	});

	it("rejects a malformed completed-review variant", () => {
		const { usage: _usage, ...withoutUsage } = validCompletedState;
		assert.equal(validateHandoffState(withoutUsage).ok, false);
	});

	it("rejects a malformed interrupted-review variant", () => {
		assert.equal(
			validateHandoffState({
				...validCompletedState,
				completion: "interrupted",
				report: "not unavailable",
				diffstat: null,
				usage: null,
				interruptionNote: "The worker was interrupted.",
			}).ok,
			false,
		);
	});

	it("accepts a real serialized state from the machine", () => {
		const machine = createHandoffMachine();
		machine.beginDraft("schema test");
		machine.propose(validHandoffDraft, validChoice);
		machine.startRun({ iteration: 0, startedAt: "2026-03-16T12:00:00.000Z", checkpoint: validCheckpoint });
		const completed = machine.completeRun({
			report: validCompletedState.report,
			diffstat: validCompletedState.diffstat,
			usage: validUsage,
		});
		if (!completed.ok) throw new Error(completed.error.message);
		assert.deepEqual(validateHandoffState(serializeHandoffState(completed.value)), {
			ok: true,
			value: completed.value,
		});
	});
});
