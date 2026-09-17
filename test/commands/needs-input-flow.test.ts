import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DraftNeedsInput, DraftService } from "../../src/app/draft-service.ts";
import { runNeedsInputFlow } from "../../src/commands/needs-input-flow.ts";
import { ok } from "../../src/domain/result.ts";
import type { Draft, DraftQuestion, ModelChoice } from "../../src/domain/types.ts";

const DRAFT: Draft = {
	slug: "retry-policy",
	prompt: "# Retry policy\n\n## NEEDS INPUT\n\nWhich policy applies?",
	tier: "standard",
	rationale: "The policy is not specified.",
};

const PROMPT_PATH = "/tmp/pi-handoff-retry-policy.md";
const READY = {
	kind: "ready" as const,
	draft: { ...DRAFT, prompt: "Use exponential backoff." },
	choice: { provider: "bifrost", model: "claude-sonnet-5", thinking: "high" },
	promptPath: PROMPT_PATH,
};

interface HarnessOptions {
	gateSelections?: (string | undefined)[];
	selectResults?: (string | undefined)[];
	inputResults?: (string | undefined)[];
	editorResults?: (string | undefined)[];
}

interface Harness {
	ctx: ExtensionContext;
	service: DraftService;
	overlays: number[];
	selectCalls: { title: string; options: string[] }[];
	inputCalls: { title: string; initial: string }[];
	editorPrefills: string[];
	notifications: { message: string; level?: string }[];
	abandoned: number[];
}

function createHarness(options: HarnessOptions = {}): Harness {
	const gateSelections = [...(options.gateSelections ?? [])];
	const selectResults = [...(options.selectResults ?? [])];
	const inputResults = [...(options.inputResults ?? [])];
	const editorResults = [...(options.editorResults ?? [])];
	const selectCalls: { title: string; options: string[] }[] = [];
	const inputCalls: { title: string; initial: string }[] = [];
	const editorPrefills: string[] = [];
	const notifications: { message: string; level?: string }[] = [];
	const overlays: number[] = [];
	const abandoned: number[] = [];

	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async () => {
				overlays.push(overlays.length);
				return gateSelections.shift();
			},
			select: async (title: string, choices: string[]) => {
				selectCalls.push({ title, options: choices });
				return selectResults.shift();
			},
			input: async (title: string, initial: string) => {
				inputCalls.push({ title, initial });
				return inputResults.shift();
			},
			editor: async (_title: string, prefill?: string) => {
				editorPrefills.push(prefill ?? "");
				return editorResults.shift();
			},
			notify: (message: string, level?: string) => {
				notifications.push({ message, ...(level === undefined ? {} : { level }) });
			},
		},
	} as unknown as ExtensionContext;

	const service = {
		abandon: () => {
			abandoned.push(abandoned.length);
		},
		continueWithPrompt: async () => ok(READY),
		draft: async () => ok(READY),
		chooseModel: (_choice: ModelChoice) => ok(READY),
		revisePrompt: async () => ok(READY),
		isChoiceRunnable: () => true,
	} as DraftService;

	return {
		ctx,
		service,
		overlays,
		selectCalls,
		inputCalls,
		editorPrefills,
		notifications,
		abandoned,
	};
}

function initialDraft(questions?: DraftQuestion[], prompt = DRAFT.prompt): DraftNeedsInput {
	return {
		kind: "needs_input",
		draft: { ...DRAFT, prompt, ...(questions === undefined ? {} : { questions }) },
		promptPath: PROMPT_PATH,
	};
}

describe("runNeedsInputFlow", () => {
	it("answers a choice question and puts the recommended choice first and marked", async () => {
		const harness = createHarness({
			gateSelections: ["answer"],
			selectResults: ["Exponential (recommended)"],
		});
		const result = await runNeedsInputFlow(
			harness.ctx,
			harness.service,
			initialDraft([{ question: "Which policy?", choices: ["Fixed", "Exponential"], recommended: 1 }]),
			"retry the client",
		);

		assert.equal(result.kind, "rescoped");
		const rescopedScope = result.kind === "rescoped" ? result.scope : "";
		assert.match(rescopedScope, /A: Exponential/);
		assert.doesNotMatch(rescopedScope, /\(recommended\)/);
		assert.deepEqual(harness.selectCalls[0]?.options, ["Exponential (recommended)", "Fixed", "Other (type an answer)"]);
	});

	it("uses text input for Other and for a free-text question", async () => {
		const choiceHarness = createHarness({
			gateSelections: ["answer"],
			selectResults: ["Other (type an answer)"],
			inputResults: ["Jittered backoff"],
		});
		const choiceResult = await runNeedsInputFlow(
			choiceHarness.ctx,
			choiceHarness.service,
			initialDraft([{ question: "Which policy?", choices: ["Fixed"] }]),
			"scope",
		);
		assert.match(choiceResult.kind === "rescoped" ? choiceResult.scope : "", /A: Jittered backoff/);
		assert.equal(choiceHarness.inputCalls.length, 1);

		const textHarness = createHarness({ gateSelections: ["answer"], inputResults: ["Only retry reads"] });
		await runNeedsInputFlow(
			textHarness.ctx,
			textHarness.service,
			initialDraft([{ question: "What retries?" }]),
			"scope",
		);
		assert.equal(textHarness.inputCalls.length, 1);
		assert.match(textHarness.inputCalls[0]?.title ?? "", /What retries\?/);
	});

	it("submits no partial answers when a later dialog is dismissed", async () => {
		const harness = createHarness({
			gateSelections: ["answer", "cancel"],
			selectResults: ["Fixed", undefined],
		});
		const result = await runNeedsInputFlow(
			harness.ctx,
			harness.service,
			initialDraft([
				{ question: "First?", choices: ["Fixed"] },
				{ question: "Second?", choices: ["Fast"] },
			]),
			"scope",
		);

		assert.deepEqual(result, { kind: "cancelled" });
		assert.equal(harness.overlays.length, 2);
		assert.equal(harness.abandoned.length, 1);
	});

	it("notifies and reopens the gate for an empty answer", async () => {
		const harness = createHarness({ gateSelections: ["answer", "cancel"], inputResults: ["", undefined] });
		const result = await runNeedsInputFlow(
			harness.ctx,
			harness.service,
			initialDraft([{ question: "What?" }]),
			"scope",
		);

		assert.equal(result.kind, "cancelled");
		assert.equal(harness.overlays.length, 2);
		assert.equal(harness.notifications[0]?.level, "warning");
		assert.match(harness.notifications[0]?.message ?? "", /answer is required/);
	});

	it("turns the prose marker fallback into one question", async () => {
		const harness = createHarness({ gateSelections: ["answer"], inputResults: ["Streaming only"] });
		const result = await runNeedsInputFlow(
			harness.ctx,
			harness.service,
			initialDraft(undefined, "## NEEDS INPUT\n\nWhich calls?"),
			"scope",
		);

		assert.equal(result.kind, "rescoped");
		assert.equal(harness.inputCalls.length, 1);
		assert.match(harness.inputCalls[0]?.title ?? "", /Which calls\?/);
	});

	it("views the full draft read-only and returns to the gate", async () => {
		const harness = createHarness({ gateSelections: ["view", "cancel"], editorResults: ["edited but discarded"] });
		const result = await runNeedsInputFlow(harness.ctx, harness.service, initialDraft(), "scope");

		assert.deepEqual(result, { kind: "cancelled" });
		assert.deepEqual(harness.editorPrefills, [DRAFT.prompt]);
		assert.equal(harness.overlays.length, 2);
	});

	it("cancels and abandons the handoff", async () => {
		const harness = createHarness({ gateSelections: ["cancel"] });
		const result = await runNeedsInputFlow(harness.ctx, harness.service, initialDraft(), "scope");

		assert.deepEqual(result, { kind: "cancelled" });
		assert.equal(harness.abandoned.length, 1);
	});

	it("returns deterministic Q/A pairs in the rescoped result", async () => {
		const harness = createHarness({ gateSelections: ["answer"], inputResults: ["Exponential backoff"] });
		const result = await runNeedsInputFlow(
			harness.ctx,
			harness.service,
			initialDraft([{ question: "Which policy?", context: "This affects streaming." }]),
			"retry the client",
		);

		assert.deepEqual(result, {
			kind: "rescoped",
			scope:
				"retry the client\n\n## Answers to the previous draft's NEEDS INPUT questions\n\nQ: Which policy?\nA: Exponential backoff\n",
		});
	});

	it("edits the prompt and continues to Gate A", async () => {
		const harness = createHarness({ gateSelections: ["edit"], editorResults: ["finished prompt"] });
		const result = await runNeedsInputFlow(harness.ctx, harness.service, initialDraft(), "scope");

		assert.deepEqual(result, { kind: "ready", view: READY });
	});
});
