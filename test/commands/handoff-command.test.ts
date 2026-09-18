/**
 * Scripted-UI tests for the drafting loop that `/handoff` and "Accept and hand off
 * leftovers" share.
 *
 * These exist for one class of bug the service-level tests structurally cannot see.
 * `DraftService.draftLeftovers` is transcript-free by construction, but *which* service
 * method the loop calls on its second pass is decided here, in the command layer. An
 * earlier version called `draftLeftovers` only for the first pass and fell back to
 * `draft` for a retry or an answered question round, so the transcript-free guarantee
 * held only when the very first leftovers draft parsed and asked nothing — and the
 * accepted prompt and review text dropped out of the scope on the way, because the
 * loop's scope variable started empty.
 *
 * The service here is real, with fake ports, so a transcript read is countable and the
 * scope the drafting model receives is the one the loop actually assembled. The UI is a
 * script: `ctx.ui.custom` serves both the drafting loader and the gates, told apart by
 * invoking the loader's factory and seeing whether it resolves itself.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDraftService, type DraftService } from "../../src/app/draft-service.ts";
import { createHandoffMachine } from "../../src/app/handoff-machine.ts";
import type { HandoffStateRecorder } from "../../src/app/state-recorder.ts";
import type { RunService } from "../../src/app/run-service.ts";
import { createHandoffCommandHandler, type HandoffCommand } from "../../src/commands/handoff-command.ts";
import type { GateBFlow } from "../../src/commands/gate-b-flow.ts";
import { LEFTOVERS_PROMPT_HEADING, LEFTOVERS_REVIEW_HEADING } from "../../src/domain/draft/leftovers.ts";
import { ok, type Result } from "../../src/domain/result.ts";
import { DEFAULT_RUBRIC } from "../../src/domain/rubric/defaults.ts";
import type { AvailableModel, Draft } from "../../src/domain/types.ts";
import type { Clock } from "../../src/ports/clock.ts";
import type { Clipboard } from "../../src/ports/clipboard.ts";
import type { DraftingFailure, DraftingModel, DraftingRequest } from "../../src/ports/drafting-model.ts";
import type { PromptFileWriter } from "../../src/ports/prompt-file-writer.ts";

const DRAFT: Draft = {
	slug: "fix-the-nits",
	prompt: "Document the timeout in the README and rename the misleading test.",
	tier: "standard",
	rationale: "Two small, fully specified edits.",
};

/** The `standard` tier's first default candidate, so resolution has a deterministic winner. */
const MODELS: AvailableModel[] = [{ provider: "bifrost-openai", id: "gpt-5.6-terra" }];

/** The accepted handoff and its review, the two documents a leftovers draft is built from. */
const LEFTOVERS = {
	prompt: "Implement the retry logic in src/client.ts and run `npm test`.",
	reviewText: "Accept. Two nits: the timeout is undocumented and the test name is misleading.",
	slug: "add-retry-logic",
};

/** Text unique to the transcript, so its absence from a request is checkable. */
const TRANSCRIPT_TEXT = "user: please add retries\nassistant: done";

interface HarnessOptions {
	/** Drafting responses consumed in order; the last repeats once exhausted. */
	responses?: Result<string, DraftingFailure>[];
	/** Ids returned by successive gate overlays, in order. The loader consumes none of these. */
	gateSelections?: (string | undefined)[];
	/** Results returned by successive `ctx.ui.select` calls, in order. */
	selectResults?: (string | undefined)[];
	/** Results returned by successive `ctx.ui.input` calls, in order. */
	inputResults?: (string | undefined)[];
}

interface Harness {
	command: HandoffCommand;
	ctx: ExtensionContext;
	requests: DraftingRequest[];
	/** The machine's drafting scope as of each drafting call, which is what a restart resumes. */
	scopeAtCall: (string | undefined)[];
	transcriptReads: () => number;
	notifications: { message: string; level?: string }[];
	selectCalls: { title: string; options: string[] }[];
}

/**
 * Builds the command handler with a real DraftService, fake ports, and a scripted UI.
 *
 * The service is real on purpose: the assertions are about which of its methods the
 * loop calls and with what scope, and a faked service would answer neither.
 */
function createHarness(options: HarnessOptions = {}): Harness {
	const requests: DraftingRequest[] = [];
	const scopeAtCall: (string | undefined)[] = [];
	const notifications: { message: string; level?: string }[] = [];
	const selectCalls: { title: string; options: string[] }[] = [];
	const gateSelections = [...(options.gateSelections ?? [])];
	const selectResults = [...(options.selectResults ?? [])];
	const inputResults = [...(options.inputResults ?? [])];
	let transcriptReads = 0;
	let callIndex = 0;

	const machine = createHandoffMachine();

	const draftingModel: DraftingModel = {
		complete: async (request) => {
			requests.push(request);
			const state = machine.current();
			scopeAtCall.push(state.kind === "drafting" ? state.scope : undefined);
			const responses = options.responses ?? [ok(JSON.stringify(DRAFT))];
			const response = responses[Math.min(callIndex, responses.length - 1)];
			callIndex += 1;
			return response ?? ok(JSON.stringify(DRAFT));
		},
	};

	const promptWriter: PromptFileWriter = { write: async () => ok(undefined) };
	const recorder: HandoffStateRecorder = { record: () => {} };

	const service = createDraftService({
		machine,
		draftingModel,
		transcript: {
			read: () => {
				transcriptReads += 1;
				return { kind: "text", text: TRANSCRIPT_TEXT };
			},
		},
		promptWriter,
		recorder,
		rubric: DEFAULT_RUBRIC,
		availableModels: () => MODELS,
	});

	/**
	 * Serves both the drafting loader and the gates.
	 *
	 * `withLoader` resolves the overlay itself, from inside the factory, once the
	 * operation it wrapped settles; a gate resolves only on a keypress that cannot
	 * happen here. So the factory is invoked, pending work is flushed, and whichever
	 * of the two happened decides the result. The component is disposed because the
	 * real loader starts an animation interval that would otherwise outlive the test.
	 */
	const custom = async (factory: unknown): Promise<unknown> => {
		let resolved: { value: unknown } | undefined;
		const build = factory as (
			tui: unknown,
			theme: unknown,
			keybindings: unknown,
			done: (value: unknown) => void,
		) => { dispose?: () => void };

		const component = build(
			{ requestRender: () => {}, terminal: { rows: 24, columns: 80 } },
			{ fg: (_role: string, text: string) => text, bold: (text: string) => text },
			{},
			(value: unknown) => {
				resolved = { value };
			},
		);

		// Lets the drafting call's promise chain settle before the overlay is judged.
		await new Promise((resolve) => setTimeout(resolve, 0));
		component.dispose?.();

		return resolved === undefined ? gateSelections.shift() : resolved.value;
	};

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/repo",
		ui: {
			custom,
			select: async (title: string, choices: string[]) => {
				selectCalls.push({ title, options: choices });
				return selectResults.shift();
			},
			input: async () => inputResults.shift(),
			editor: async () => undefined,
			setEditorText: () => {},
			notify: (message: string, level?: string) => {
				notifications.push({ message, ...(level === undefined ? {} : { level }) });
			},
		},
	} as unknown as ExtensionContext;

	const runService = {
		startExternal: async () => ok(undefined),
		abortActiveRun: () => {},
	} as unknown as RunService;

	const gateBFlow = {
		run: async () => {},
		viewFromOutcome: () => undefined,
		viewFromPendingReview: async () => undefined,
		startReviewTurn: () => false,
	} as unknown as GateBFlow;

	const command = createHandoffCommandHandler({
		machine,
		createService: (): DraftService => service,
		runService,
		gateBFlow,
		isChoiceRunnable: () => true,
		clipboard: { copy: async () => ok(undefined) } as unknown as Clipboard,
		clock: { nowMs: () => 0 } as unknown as Clock,
	});

	return {
		command,
		ctx,
		requests,
		scopeAtCall,
		transcriptReads: () => transcriptReads,
		notifications,
		selectCalls,
	};
}

/** The envelope for a draft that asks one question, so NEEDS INPUT opens. */
function questioningDraft(): string {
	return JSON.stringify({ ...DRAFT, questions: [{ question: "Document the timeout where?" }] });
}

/**
 * The drafting loader builds a real `BorderedLoader`, which reads the process-wide
 * theme, so the theme has to exist before any of these run. The file watcher is left
 * off: it would keep a handle open past the end of the test run.
 */
before(() => {
	initTheme(undefined, false);
});

describe("draftLeftovers", () => {
	it("sends the accepted prompt and the review text, and never reads the transcript", async () => {
		const harness = createHarness({ gateSelections: ["cancel"] });
		await harness.command.draftLeftovers(harness.ctx, LEFTOVERS);

		assert.equal(harness.transcriptReads(), 0);
		const [request] = harness.requests;
		assert.ok(request !== undefined);
		assert.match(request.userMessage, /the timeout is undocumented/);
		assert.match(request.userMessage, new RegExp(LEFTOVERS_PROMPT_HEADING));
		assert.equal(request.userMessage.includes(TRANSCRIPT_TEXT), false);
	});

	/**
	 * The retry path. It previously called `draft("")`, which both re-serialized the
	 * conversation and replaced the machine's scope with nothing, so the second attempt
	 * was drafted from the transcript with no scope at all.
	 */
	it("retries a leftovers draft without the transcript and without losing the scope", async () => {
		const harness = createHarness({
			responses: [ok("not an envelope"), ok(JSON.stringify(DRAFT))],
			gateSelections: ["cancel"],
			selectResults: ["Retry drafting"],
		});
		await harness.command.draftLeftovers(harness.ctx, LEFTOVERS);

		assert.equal(harness.transcriptReads(), 0, "expected no conversation history on either pass");
		assert.equal(harness.requests.length, 2, "expected the retry to have made a second drafting call");
		for (const request of harness.requests) {
			assert.match(request.userMessage, /the timeout is undocumented/, "expected the review text to survive the retry");
			assert.match(request.userMessage, /Implement the retry logic/, "expected the accepted prompt to survive");
			assert.equal(request.userMessage.includes("## Conversation History"), false);
		}
	});

	/**
	 * The answered-question path. It previously rescoped from an empty string, so the
	 * re-draft's scope was the `Q:`/`A:` block alone and the leftovers documents were
	 * gone — and it re-serialized the transcript on the way.
	 */
	it("keeps the leftovers scope when an answered question round re-drafts", async () => {
		const harness = createHarness({
			responses: [ok(questioningDraft()), ok(JSON.stringify(DRAFT))],
			gateSelections: ["answer", "cancel"],
			inputResults: ["In the README."],
		});
		await harness.command.draftLeftovers(harness.ctx, LEFTOVERS);

		assert.equal(harness.transcriptReads(), 0, "expected the answered round to stay transcript-free");
		assert.equal(harness.requests.length, 2, "expected the answers to have triggered a re-draft");
		const redraft = harness.requests[1];
		assert.ok(redraft !== undefined);
		assert.match(redraft.userMessage, /the timeout is undocumented/, "expected the review text to survive rescoping");
		assert.match(redraft.userMessage, /Implement the retry logic/, "expected the accepted prompt to survive");
		assert.match(redraft.userMessage, /A: In the README\./, "expected the answer to have been folded in");
		assert.equal(redraft.userMessage.includes(TRANSCRIPT_TEXT), false);
	});

	/**
	 * The machine's scope is what a restart resumes a pending round from, so it has to
	 * carry the leftovers documents too — not just the message that happened to be sent.
	 */
	it("records the leftovers documents on the scope a restart would resume", async () => {
		const harness = createHarness({
			responses: [ok(questioningDraft()), ok(JSON.stringify(DRAFT))],
			gateSelections: ["answer", "cancel"],
			inputResults: ["In the README."],
		});
		await harness.command.draftLeftovers(harness.ctx, LEFTOVERS);

		const resumed = harness.scopeAtCall[1];
		assert.ok(resumed !== undefined, "expected the machine to have been drafting for the re-draft");
		assert.match(resumed, new RegExp(LEFTOVERS_REVIEW_HEADING));
		assert.match(resumed, /Implement the retry logic/);
		assert.match(resumed, /A: In the README\./);
	});
});

/**
 * The ordinary `/handoff` path is the control: it must still serialize the conversation.
 * Without this, a change that made everything transcript-free would pass the tests above.
 */
describe("handle", () => {
	it("drafts an ordinary handoff from the transcript", async () => {
		const harness = createHarness({ gateSelections: ["cancel"] });
		await harness.command.handle("", harness.ctx);

		assert.equal(harness.transcriptReads(), 1);
		const [request] = harness.requests;
		assert.ok(request !== undefined);
		assert.match(request.userMessage, /## Conversation History/);
		assert.ok(request.userMessage.includes(TRANSCRIPT_TEXT));
	});

	it("passes a command-line scope through to the drafting call", async () => {
		const harness = createHarness({ gateSelections: ["cancel"] });
		await harness.command.handle("only the retry path", harness.ctx);

		const [request] = harness.requests;
		assert.ok(request !== undefined);
		assert.match(request.userMessage, /only the retry path/);
	});
});
