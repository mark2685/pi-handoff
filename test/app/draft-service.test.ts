/**
 * Behavioral tests for the drafting flow that precedes Gate A.
 *
 * Every dependency is a fake, so these assert the decisions T7 owns: that a
 * malformed response never reaches a gate, that a `NEEDS INPUT` draft diverts to
 * the user, that an unresolved tier still produces a gate with Run blocked, and
 * that the prompt file is on disk before any of that is reported.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createDraftService, type DraftOutcome, type DraftService } from "../../src/app/draft-service.ts";
import { createHandoffMachine, type HandoffMachine, type HandoffState } from "../../src/app/handoff-machine.ts";
import type { HandoffStateRecorder } from "../../src/app/state-recorder.ts";
import { ok, type Result } from "../../src/domain/result.ts";
import { DEFAULT_RUBRIC } from "../../src/domain/rubric/defaults.ts";
import type { AvailableModel, Draft, ModelChoice, Rubric } from "../../src/domain/types.ts";
import type { DraftingModel, DraftingRequest, SessionTranscriptSource } from "../../src/ports/drafting-model.ts";
import type { PromptFileWriter, PromptWriteFailure } from "../../src/ports/prompt-file-writer.ts";
import { err } from "../../src/domain/result.ts";

const DRAFT: Draft = {
	slug: "add-retry-logic",
	prompt: "Implement the retry logic in src/client.ts and run `npm test`.",
	tier: "standard",
	rationale: "Two files, fully specified, one decisive validation command.",
};

/** The `standard` tier's first default candidate, so resolution has a deterministic winner. */
const STANDARD_MODELS: AvailableModel[] = [{ provider: "bifrost-openai", id: "gpt-5.6-terra" }];

const EXPECTED_CHOICE: ModelChoice = { provider: "bifrost-openai", model: "gpt-5.6-terra", thinking: "high" };

const PROMPT_PATH = "/tmp/pi-handoff-add-retry-logic.md";

interface Harness {
	service: DraftService;
	machine: HandoffMachine;
	writes: { path: string; contents: string }[];
	requests: DraftingRequest[];
	recorded: HandoffState[];
	/** Ordered log proving the prompt file is written before an outcome is returned. */
	events: string[];
}

interface HarnessOptions {
	response?: Result<string, { kind: "completion_failed"; detail: string }>;
	/** Consumed in order across calls; the last entry repeats once exhausted. Overrides `response`. */
	responses?: Result<string, { kind: "completion_failed"; detail: string }>[];
	transcript?: SessionTranscriptSource;
	models?: AvailableModel[];
	rubric?: Rubric;
	writeFailure?: PromptWriteFailure;
}

function createHarness(options: HarnessOptions = {}): Harness {
	const writes: { path: string; contents: string }[] = [];
	const requests: DraftingRequest[] = [];
	const recorded: HandoffState[] = [];
	const events: string[] = [];

	let callIndex = 0;
	const draftingModel: DraftingModel = {
		complete: async (request) => {
			requests.push(request);
			events.push("complete");
			if (options.responses !== undefined) {
				const response = options.responses[Math.min(callIndex, options.responses.length - 1)];
				callIndex += 1;
				return response ?? ok(JSON.stringify(DRAFT));
			}
			return options.response ?? ok(JSON.stringify(DRAFT));
		},
	};

	const promptWriter: PromptFileWriter = {
		write: async (path, contents) => {
			if (options.writeFailure !== undefined) return err(options.writeFailure);
			writes.push({ path, contents });
			events.push(`write:${path}`);
			return ok(undefined);
		},
	};

	const recorder: HandoffStateRecorder = {
		record: (state) => {
			recorded.push(state);
		},
	};

	const machine = createHandoffMachine();
	const service = createDraftService({
		machine,
		draftingModel,
		transcript: options.transcript ?? { read: () => ({ kind: "text", text: "user: add retries" }) },
		promptWriter,
		recorder,
		rubric: options.rubric ?? DEFAULT_RUBRIC,
		availableModels: () => options.models ?? STANDARD_MODELS,
	});

	return { service, machine, writes, requests, recorded, events };
}

/** Unwraps an outcome, failing loudly if the machine refused the transition instead. */
async function draftOutcome(harness: Harness, scope = "add retries"): Promise<DraftOutcome> {
	const result = await harness.service.draft(scope, undefined);
	assert.ok(result.ok, "expected drafting to produce an outcome rather than a conflict");
	return result.value;
}

describe("DraftService.draft", () => {
	let harness: Harness;

	beforeEach(() => {
		harness = createHarness();
	});

	it("proposes a resolved model for a well-formed envelope", async () => {
		const outcome = await draftOutcome(harness);
		assert.deepEqual(outcome, { kind: "ready", draft: DRAFT, choice: EXPECTED_CHOICE, promptPath: PROMPT_PATH });
	});

	it("leaves the machine proposed with the resolved draft and choice", async () => {
		await draftOutcome(harness);
		assert.deepEqual(harness.machine.current(), { kind: "proposed", draft: DRAFT, choice: EXPECTED_CHOICE });
	});

	it("writes the prompt file to the slug-derived path", async () => {
		await draftOutcome(harness);
		assert.deepEqual(harness.writes, [{ path: PROMPT_PATH, contents: DRAFT.prompt }]);
	});

	it("writes the prompt file before reporting an outcome that opens Gate A", async () => {
		await draftOutcome(harness);
		assert.deepEqual(harness.events, ["complete", `write:${PROMPT_PATH}`]);
	});

	it("sends the drafting system prompt and the serialized session", async () => {
		await draftOutcome(harness);
		const request = harness.requests[0];
		assert.ok(request);
		assert.match(request.systemPrompt, /handoff drafting assistant/);
		assert.match(request.systemPrompt, /envelope's "questions" array/);
		assert.match(request.userMessage, /user: add retries/);
		assert.match(request.userMessage, /add retries/);
	});

	it("appends a handoff-state entry for each transition", async () => {
		await draftOutcome(harness);
		assert.deepEqual(
			harness.recorded.map((state) => state.kind),
			["drafting", "proposed"],
		);
	});
});

describe("DraftService.draft when the response is malformed", () => {
	it("surfaces the raw text instead of a draft", async () => {
		const harness = createHarness({ response: ok("I cannot produce JSON for this.") });
		const outcome = await draftOutcome(harness);
		assert.equal(outcome.kind, "unparseable");
		assert.equal(outcome.kind === "unparseable" ? outcome.rawResponse : undefined, "I cannot produce JSON for this.");
	});

	it("reports no_json_object when nothing parses", async () => {
		const harness = createHarness({ response: ok("no json here") });
		const outcome = await draftOutcome(harness);
		assert.deepEqual(outcome.kind === "unparseable" ? outcome.error : undefined, { kind: "no_json_object" });
	});

	it("distinguishes a parsed object that fails the draft schema", async () => {
		const harness = createHarness({ response: ok(JSON.stringify({ slug: "x", prompt: "y", tier: "nope" })) });
		const outcome = await draftOutcome(harness);
		assert.equal(outcome.kind === "unparseable" ? outcome.error.kind : undefined, "invalid_draft");
	});

	it("writes no prompt file", async () => {
		const harness = createHarness({ response: ok("not json") });
		await draftOutcome(harness);
		assert.deepEqual(harness.writes, []);
	});

	it("stays drafting so the user can retry without re-entering", async () => {
		const harness = createHarness({ response: ok("not json") });
		await draftOutcome(harness);
		assert.equal(harness.machine.current().kind, "drafting");
	});

	it("retries in place rather than reporting a conflict", async () => {
		const harness = createHarness({ response: ok("not json") });
		await draftOutcome(harness);
		const retry = await harness.service.draft("add retries", undefined);
		assert.ok(retry.ok);
		assert.equal(harness.requests.length, 2);
	});
});

describe("DraftService.draft when the draft asks for context", () => {
	const needsInput: Draft = { ...DRAFT, prompt: "NEEDS INPUT: which retry policy applies to streaming calls?" };

	it("diverts to the user instead of opening Gate A", async () => {
		const harness = createHarness({ response: ok(JSON.stringify(needsInput)) });
		const outcome = await draftOutcome(harness);
		assert.deepEqual(outcome, { kind: "needs_input", draft: needsInput, promptPath: PROMPT_PATH });
	});

	it("uses non-empty structured questions as the primary signal even without prose", async () => {
		const structured: Draft = {
			...DRAFT,
			questions: [
				{ question: "Which retry policy should streaming use?", choices: ["Fixed", "Exponential"], recommended: 1 },
			],
		};
		const harness = createHarness({ response: ok(JSON.stringify(structured)) });
		const outcome = await draftOutcome(harness);
		assert.equal(outcome.kind, "needs_input");
		assert.deepEqual(outcome.kind === "needs_input" ? outcome.draft.questions : undefined, structured.questions);
	});

	it("keeps structured questions when prose also contains the fallback marker", async () => {
		const structured: Draft = {
			...needsInput,
			questions: [{ question: "Which retry policy should streaming use?" }],
		};
		const harness = createHarness({ response: ok(JSON.stringify(structured)) });
		const outcome = await draftOutcome(harness);
		assert.deepEqual(outcome.kind === "needs_input" ? outcome.draft.questions : undefined, structured.questions);
	});

	it("still writes the prompt file for inspection", async () => {
		const harness = createHarness({ response: ok(JSON.stringify(needsInput)) });
		await draftOutcome(harness);
		assert.deepEqual(harness.writes, [{ path: PROMPT_PATH, contents: needsInput.prompt }]);
	});

	it("keeps the machine drafting and records the retained round", async () => {
		const harness = createHarness({ response: ok(JSON.stringify(needsInput)) });
		await draftOutcome(harness);
		const expected = {
			kind: "drafting" as const,
			scope: "add retries",
			pendingDraft: { draft: needsInput, promptPath: PROMPT_PATH },
		};
		assert.deepEqual(harness.machine.current(), expected);
		assert.deepEqual(harness.recorded.at(-1), expected);
	});

	it("carries answered scope into a later pending round and its recorded state", async () => {
		const first: Draft = {
			...DRAFT,
			questions: [{ question: "Which retry policy?" }],
		};
		const second: Draft = {
			...DRAFT,
			questions: [{ question: "Which timeout?" }],
		};
		const answeredScope =
			"add retries\n\n## Answers to the previous draft's NEEDS INPUT questions\n\nQ: Which retry policy?\nA: Exponential";
		const harness = createHarness({ responses: [ok(JSON.stringify(first)), ok(JSON.stringify(second))] });

		const firstOutcome = await draftOutcome(harness);
		assert.equal(firstOutcome.kind, "needs_input");
		const secondOutcome = await harness.service.draft(answeredScope, undefined);

		assert.equal(secondOutcome.ok, true);
		assert.deepEqual(harness.machine.current(), {
			kind: "drafting",
			scope: answeredScope,
			pendingDraft: { draft: second, promptPath: PROMPT_PATH },
		});
		assert.deepEqual(harness.recorded.at(-1), harness.machine.current());

		const rehydrated = createHandoffMachine();
		rehydrated.restore(harness.machine.current());
		const restoredState = rehydrated.current();
		assert.equal(restoredState.kind, "drafting");
		assert.equal(restoredState.kind === "drafting" ? restoredState.scope : undefined, answeredScope);
	});

	it("refuses chooseModel while the marker is still present", async () => {
		const harness = createHarness({ response: ok(JSON.stringify(needsInput)) });
		await draftOutcome(harness);
		const chosen = harness.service.chooseModel(EXPECTED_CHOICE);
		assert.equal(chosen.ok, false);
	});

	it("refuses revisePrompt while the marker is still present", async () => {
		const harness = createHarness({ response: ok(JSON.stringify(needsInput)) });
		await draftOutcome(harness);
		const revised = await harness.service.revisePrompt("NEEDS INPUT: same question.");
		assert.equal(revised.ok, false);
	});

	it("allows a prompt that discusses NEEDS INPUT without raising it to reach Gate A", async () => {
		const completeDraft: Draft = {
			...DRAFT,
			prompt:
				"# Task: Replace the NEEDS INPUT editor flow with structured questions and per-question answering in `pi-handoff`",
		};
		const harness = createHarness({ response: ok(JSON.stringify(completeDraft)) });

		const outcome = await draftOutcome(harness);

		assert.deepEqual(outcome, {
			kind: "ready",
			draft: completeDraft,
			choice: EXPECTED_CHOICE,
			promptPath: PROMPT_PATH,
		});
		assert.ok(harness.service.chooseModel(EXPECTED_CHOICE).ok);
	});

	it("replaces the drafting scope and records it when a second draft starts", async () => {
		const secondDraft: Draft = { ...DRAFT, slug: "add-timeout-config", prompt: "Add a configurable timeout." };
		const harness = createHarness({
			responses: [ok(JSON.stringify(needsInput)), ok(JSON.stringify(secondDraft))],
		});

		await draftOutcome(harness);
		const recordedBeforeSecond = harness.recorded.length;
		const secondScope = "add a configurable timeout instead";
		const secondOutcome = await draftOutcome(harness, secondScope);

		const secondDraftingState = harness.recorded
			.slice(recordedBeforeSecond)
			.filter((state): state is Extract<HandoffState, { kind: "drafting" }> => state.kind === "drafting")
			.at(-1);
		assert.deepEqual(secondDraftingState, { kind: "drafting", scope: secondScope });
		assert.deepEqual(harness.recorded.at(-1), harness.machine.current());

		// The retained draft is now the second draft's, resolved against the live models,
		// so choosing a model must apply to it and not the first draft's marker-carrying prompt.
		assert.deepEqual(secondOutcome, {
			kind: "ready",
			draft: secondDraft,
			choice: EXPECTED_CHOICE,
			promptPath: "/tmp/pi-handoff-add-timeout-config.md",
		});
		const chosen = harness.service.chooseModel(EXPECTED_CHOICE);
		assert.ok(chosen.ok);
		assert.deepEqual(chosen.value.draft, secondDraft);
	});
});

describe("DraftService.continueWithPrompt", () => {
	const needsInput: Draft = { ...DRAFT, prompt: "NEEDS INPUT: which retry policy applies to streaming calls?" };

	it("reports a conflict when no draft is retained", async () => {
		const harness = createHarness();
		const outcome = await harness.service.continueWithPrompt("Use exponential backoff.");
		assert.equal(outcome.ok, false);
		assert.equal(outcome.ok === false ? outcome.error.attempted : undefined, "continueWithPrompt");
	});

	it("resolves to ready with a resolved choice once the marker is removed", async () => {
		const harness = createHarness({ response: ok(JSON.stringify(needsInput)) });
		await draftOutcome(harness);
		const outcome = await harness.service.continueWithPrompt("Use exponential backoff on all retries.");
		assert.ok(outcome.ok);
		assert.deepEqual(outcome.value, {
			kind: "ready",
			draft: { ...needsInput, prompt: "Use exponential backoff on all retries." },
			choice: EXPECTED_CHOICE,
			promptPath: PROMPT_PATH,
		});
	});

	it("uses Edit as an escape hatch for structured questions", async () => {
		const structuredNeedsInput: Draft = {
			...DRAFT,
			questions: [{ question: "Which retry policy should streaming use?" }],
		};
		// The prose deliberately has no marker, so only dropping questions can resolve the gate.
		const harness = createHarness({ response: ok(JSON.stringify(structuredNeedsInput)) });
		const initial = await draftOutcome(harness);
		assert.equal(initial.kind, "needs_input");

		const outcome = await harness.service.continueWithPrompt("Use exponential backoff on all retries.");

		assert.ok(outcome.ok);
		assert.equal(outcome.value.kind, "ready");
		assert.equal(outcome.value.kind === "ready" ? "questions" in outcome.value.draft : false, false);
	});

	it("moves the machine to proposed once the marker is removed", async () => {
		const harness = createHarness({ response: ok(JSON.stringify(needsInput)) });
		await draftOutcome(harness);
		await harness.service.continueWithPrompt("Use exponential backoff on all retries.");
		assert.equal(harness.machine.current().kind, "proposed");
	});

	it("returns needs_input again when the marker is still present", async () => {
		const harness = createHarness({ response: ok(JSON.stringify(needsInput)) });
		await draftOutcome(harness);
		const outcome = await harness.service.continueWithPrompt("NEEDS INPUT: same question, reworded.");
		assert.ok(outcome.ok);
		assert.equal(outcome.value.kind, "needs_input");
		assert.equal(harness.machine.current().kind, "drafting");
	});

	it("writes the replacement prompt to the same slug-derived path", async () => {
		const harness = createHarness({ response: ok(JSON.stringify(needsInput)) });
		await draftOutcome(harness);
		await harness.service.continueWithPrompt("Use exponential backoff on all retries.");
		assert.deepEqual(harness.writes.at(-1), {
			path: PROMPT_PATH,
			contents: "Use exponential backoff on all retries.",
		});
	});
});

describe("DraftService.draft when the tier resolves to no model", () => {
	it("still reports a ready draft so Gate A can open", async () => {
		const harness = createHarness({ models: [] });
		const outcome = await draftOutcome(harness);
		assert.deepEqual(outcome, { kind: "ready", draft: DRAFT, choice: undefined, promptPath: PROMPT_PATH });
	});

	it("writes the prompt file so Run externally stays available", async () => {
		const harness = createHarness({ models: [] });
		await draftOutcome(harness);
		assert.deepEqual(harness.writes, [{ path: PROMPT_PATH, contents: DRAFT.prompt }]);
	});

	it("does not fabricate a proposed state without a model", async () => {
		const harness = createHarness({ models: [] });
		await draftOutcome(harness);
		assert.equal(harness.machine.current().kind, "drafting");
	});

	it("blocks Run because no choice exists", async () => {
		const harness = createHarness({ models: [] });
		const outcome = await draftOutcome(harness);
		const choice = outcome.kind === "ready" ? outcome.choice : undefined;
		assert.equal(harness.service.isChoiceRunnable(choice), false);
	});
});

describe("DraftService.draft failure paths", () => {
	it("reports an empty session without calling the model", async () => {
		const harness = createHarness({ transcript: { read: () => ({ kind: "empty" }) } });
		const outcome = await draftOutcome(harness);
		assert.deepEqual(outcome, { kind: "empty_session" });
		assert.equal(harness.requests.length, 0);
	});

	it("returns to idle after an empty session", async () => {
		const harness = createHarness({ transcript: { read: () => ({ kind: "empty" }) } });
		await draftOutcome(harness);
		assert.deepEqual(harness.machine.current(), { kind: "idle" });
	});

	it("reports a failed completion as a value", async () => {
		const harness = createHarness({ response: err({ kind: "completion_failed", detail: "upstream 500" }) });
		const outcome = await draftOutcome(harness);
		assert.deepEqual(outcome, { kind: "failed", failure: { kind: "completion_failed", detail: "upstream 500" } });
	});

	it("returns to idle after a failed completion", async () => {
		const harness = createHarness({ response: err({ kind: "completion_failed", detail: "upstream 500" }) });
		await draftOutcome(harness);
		assert.deepEqual(harness.machine.current(), { kind: "idle" });
	});

	it("refuses to open a gate when the prompt file cannot be written", async () => {
		const failure: PromptWriteFailure = { kind: "write_failed", path: PROMPT_PATH, detail: "EACCES" };
		const harness = createHarness({ writeFailure: failure });
		const outcome = await draftOutcome(harness);
		assert.deepEqual(outcome, { kind: "write_failed", failure });
		assert.deepEqual(harness.machine.current(), { kind: "idle" });
	});

	it("refuses to start while a handoff is already running", async () => {
		const harness = createHarness();
		await draftOutcome(harness);
		const started = harness.machine.startRun({
			iteration: 1,
			startedAt: "2026-01-01T00:00:00.000Z",
			checkpoint: { repositoryRoot: "/repo", head: "abc", statuses: [] },
		});
		assert.ok(started.ok);

		const refused = await harness.service.draft("another change", undefined);
		assert.equal(refused.ok, false);
		assert.equal(refused.ok === false ? refused.error.current : undefined, "running");
	});
});

describe("DraftService.chooseModel", () => {
	const manual: ModelChoice = { provider: "bifrost", model: "claude-opus-5", thinking: "xhigh" };

	it("proposes a manually chosen model when the tier resolved to none", async () => {
		const harness = createHarness({ models: [] });
		await draftOutcome(harness);
		const chosen = harness.service.chooseModel(manual);
		assert.ok(chosen.ok);
		assert.deepEqual(chosen.value, { kind: "ready", draft: DRAFT, choice: manual, promptPath: PROMPT_PATH });
	});

	it("moves the machine to proposed once a model exists", async () => {
		const harness = createHarness({ models: [] });
		await draftOutcome(harness);
		harness.service.chooseModel(manual);
		assert.deepEqual(harness.machine.current(), { kind: "proposed", draft: DRAFT, choice: manual });
	});

	it("overrides a tier-resolved choice", async () => {
		const harness = createHarness();
		await draftOutcome(harness);
		harness.service.chooseModel(manual);
		assert.deepEqual(harness.machine.choice(), manual);
	});

	it("reports a conflict when no draft exists", () => {
		const harness = createHarness();
		const chosen = harness.service.chooseModel(manual);
		assert.equal(chosen.ok, false);
		assert.equal(chosen.ok === false ? chosen.error.attempted : undefined, "chooseModel");
	});
});

describe("DraftService.revisePrompt", () => {
	it("rewrites the prompt file with the edited text", async () => {
		const harness = createHarness();
		await draftOutcome(harness);
		const revised = await harness.service.revisePrompt("Edited prompt body.");
		assert.ok(revised.ok);
		assert.deepEqual(harness.writes.at(-1), { path: PROMPT_PATH, contents: "Edited prompt body." });
	});

	it("retains the edited prompt on the machine's draft", async () => {
		const harness = createHarness();
		await draftOutcome(harness);
		await harness.service.revisePrompt("Edited prompt body.");
		assert.equal(harness.machine.draft()?.prompt, "Edited prompt body.");
	});

	it("keeps the resolved choice across an edit", async () => {
		const harness = createHarness();
		await draftOutcome(harness);
		const revised = await harness.service.revisePrompt("Edited prompt body.");
		assert.deepEqual(revised.ok ? revised.value.choice : undefined, EXPECTED_CHOICE);
	});

	it("edits a draft that has no model yet", async () => {
		const harness = createHarness({ models: [] });
		await draftOutcome(harness);
		const revised = await harness.service.revisePrompt("Edited without a model.");
		assert.ok(revised.ok);
		assert.equal(revised.value.choice, undefined);
		assert.equal(harness.machine.current().kind, "drafting");
	});
});

describe("DraftService.isChoiceRunnable", () => {
	it("accepts a choice present in the live registry", () => {
		const harness = createHarness();
		assert.equal(harness.service.isChoiceRunnable(EXPECTED_CHOICE), true);
	});

	it("rejects a choice absent from the live registry", () => {
		const harness = createHarness({ models: [] });
		assert.equal(harness.service.isChoiceRunnable(EXPECTED_CHOICE), false);
	});

	it("rejects an undefined choice", () => {
		const harness = createHarness();
		assert.equal(harness.service.isChoiceRunnable(undefined), false);
	});
});

describe("DraftService.abandon", () => {
	it("returns to idle and records the reset", async () => {
		const harness = createHarness();
		await draftOutcome(harness);
		harness.service.abandon();
		assert.deepEqual(harness.machine.current(), { kind: "idle" });
		assert.equal(harness.recorded.at(-1)?.kind, "idle");
	});

	it("clears the retained draft so a later handoff cannot inherit it", async () => {
		const harness = createHarness({ models: [] });
		await draftOutcome(harness);
		harness.service.abandon();
		const chosen = harness.service.chooseModel(EXPECTED_CHOICE);
		assert.equal(chosen.ok, false);
	});
});
