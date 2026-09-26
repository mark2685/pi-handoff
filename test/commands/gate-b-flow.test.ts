/**
 * Behavioral tests for the Gate B loop and the `agent_end` reopen.
 *
 * These exist mainly for one ordering property that no other test can express:
 * `agent_end` must clear the review arm *before* it opens Gate B. Pi's
 * `_runAgentPrompt` loops on auto-retry, so more than one `agent_end` per prompt is
 * normal, and a flag cleared only after the gate closed would let the second event
 * stack a second gate behind the first. The double-fire test below is what pins
 * that; removing the clear makes it fail.
 *
 * Gate B is faked at `ctx.ui.custom`, which resolves queued option ids without
 * constructing the overlay. That keeps these tests about the flow's decisions
 * rather than about rendering, matching how the gate formatters are tested
 * separately as pure functions.
 *
 * The feedback branch is deliberately not driven here: it runs behind
 * `runWithWidget`, which only performs its operation when a real TUI invokes the
 * component factory. Its decisions — the bound, the write ordering, the refusals —
 * are covered against `ReviewService` directly instead.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHandoffMachine, type HandoffMachine } from "../../src/app/handoff-machine.ts";
import { createReviewService } from "../../src/app/review-service.ts";
import { createRunService, type RunService } from "../../src/app/run-service.ts";
import type { HandoffStateRecorder, HandoffReportRecorder } from "../../src/app/state-recorder.ts";
import { createGateBFlow, type GateBFlow } from "../../src/commands/gate-b-flow.ts";
import type { LeftoversScopeInput } from "../../src/domain/draft/leftovers.ts";
import { ok } from "../../src/domain/result.ts";
import type { Checkpoint, Draft, ModelChoice } from "../../src/domain/types.ts";
import type { Clock } from "../../src/ports/clock.ts";
import type { Git } from "../../src/ports/git.ts";
import type { PromptFileWriter } from "../../src/ports/prompt-file-writer.ts";
import type { WorkerRunOutcome, WorkerRunner, WorkerUsage } from "../../src/ports/worker-runner.ts";

const DRAFT: Draft = {
	slug: "add-retry-logic",
	prompt: "# Add retry logic\n\nImplement retries in src/client.ts.",
	tier: "standard",
	rationale: "Fully specified.",
};

const CHOICE: ModelChoice = { provider: "bifrost-openai", model: "gpt-5.6-terra", thinking: "high" };
const CHECKPOINT: Checkpoint = { repositoryRoot: "/repo", head: "abc1234", statuses: [] };

const USAGE: WorkerUsage = {
	inputTokens: 10,
	outputTokens: 5,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cost: 0,
	contextTokens: 100,
	turns: 1,
};

const REPORT = "## Summary\nAdded retries.";
const DIFFSTAT = " src/client.ts | 4 ++--";
const PROMPT_PATH = "/tmp/pi-handoff-add-retry-logic.md";
const CWD = "/repo";

interface Harness {
	flow: GateBFlow;
	machine: HandoffMachine;
	runService: RunService;
	ctx: ExtensionContext;
	/** One entry per `ctx.ui.custom` call, so a stacked second gate is visible. */
	overlays: number[];
	notifications: { message: string; level?: string }[];
	messages: string[];
	editorPrefills: string[];
	/** Editor titles, which carry the no-review hint `ctx.ui.editor` has nowhere else to put. */
	editorTitles: string[];
	/** Follow-up drafts requested by "Accept and hand off leftovers". */
	leftovers: LeftoversScopeInput[];
	/** Titles rendered by read-only viewers, whose headings are part of the warning contract. */
	viewerTitles: string[];
	/** Prompt-file contents written by feedback iterations, which is where the sent text lands. */
	promptWrites: string[];
}

interface HarnessOptions {
	/** Option ids resolved by successive Gate B renders, in order. */
	selections?: (string | undefined)[];
	interrupted?: boolean;
	/** Worker outcomes consumed in order: iteration 1, then feedback iterations. */
	outcomes?: WorkerRunOutcome[];
	maxIterations?: number;
	editorResult?: string | undefined;
	/** Submits the prefill unchanged, as the real editor does when the user just presses Enter. */
	editorSubmitsPrefill?: boolean;
}

function createHarness(options: HarnessOptions = {}): Harness {
	const machine = createHandoffMachine();
	const overlays: number[] = [];
	const notifications: { message: string; level?: string }[] = [];
	const messages: string[] = [];
	const editorPrefills: string[] = [];
	const editorTitles: string[] = [];
	const leftovers: LeftoversScopeInput[] = [];
	const viewerTitles: string[] = [];
	const promptWrites: string[] = [];
	const selections = [...(options.selections ?? [])];

	const recorder: HandoffStateRecorder = { record: () => {} };
	const reportRecorder: HandoffReportRecorder = { record: () => {} };
	const promptWriter: PromptFileWriter = {
		write: async (_path: string, contents: string) => {
			promptWrites.push(contents);
			return ok(undefined);
		},
	};

	let workerRun = 0;
	const runner: WorkerRunner = {
		run: async () => {
			const fallback: WorkerRunOutcome = {
				exitCode: options.interrupted === true ? 1 : 0,
				report: options.interrupted === true ? "" : REPORT,
				usage: USAGE,
				toolResults: [],
				stopReason: "endTurn",
				errorMessage: undefined,
				stderr: "",
				aborted: false,
			};
			const configured = options.outcomes?.[Math.min(workerRun, options.outcomes.length - 1)];
			workerRun += 1;
			return configured ?? fallback;
		},
	};

	const git: Git = {
		repositoryRoot: async () => ok("/repo"),
		checkpoint: async () => ok(CHECKPOINT),
		diffstat: async () => ok(DIFFSTAT),
		discardSinceCheckpoint: async () => ok({ restoredPaths: [], removedPaths: [], skippedPaths: [] }),
	};

	const clock: Clock = { nowIso: () => "2026-03-09T09:00:00.000Z", nowMs: () => 0 };

	const runService = createRunService({ machine, runner, git, clock, recorder });
	const reviewService = createReviewService({
		machine,
		runService,
		promptWriter,
		reportRecorder,
		recorder,
		clock,
		maxIterations: options.maxIterations ?? 3,
	});

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: CWD,
		ui: {
			notify: (message: string, level?: string) => {
				notifications.push({ message, ...(level === undefined ? {} : { level }) });
			},
			// Run widgets resolve their custom surface from their operation; gates wait for
			// a choice. Invoking the factory lets feedback exercise its real restart path
			// while counting only Gate B renders, which exposes an unwanted second gate.
			custom: async (factory: unknown) => {
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
				await new Promise((resolve) => setTimeout(resolve, 0));
				if (resolved !== undefined) {
					component.dispose?.();
					return resolved.value;
				}
				const viewer = component as { render?: (width: number) => string[]; scrollBy?: (delta: number) => void };
				if (viewer.scrollBy !== undefined) viewerTitles.push(viewer.render?.(80)[0]?.trim() ?? "");
				overlays.push(overlays.length);
				return selections.shift();
			},
			select: async () => undefined,
			editor: async (title: string, prefill?: string) => {
				editorTitles.push(title);
				editorPrefills.push(prefill ?? "");
				return options.editorSubmitsPrefill === true ? (prefill ?? "") : options.editorResult;
			},
		},
	} as unknown as ExtensionContext;

	const flow = createGateBFlow({
		machine,
		runService,
		reviewService,
		clock,
		isChoiceRunnable: () => true,
		sendUserMessage: (content) => {
			messages.push(content);
		},
		draftLeftovers: async (_ctx, input) => {
			leftovers.push(input);
		},
	});

	return {
		flow,
		machine,
		runService,
		ctx,
		overlays,
		notifications,
		messages,
		editorPrefills,
		editorTitles,
		leftovers,
		viewerTitles,
		promptWrites,
	};
}

/** Drives the machine to a pending review, which is Gate B's precondition. */
async function reachReview(harness: Harness, options: { autoReview?: boolean } = {}): Promise<void> {
	harness.machine.beginDraft("add retries");
	harness.machine.propose(DRAFT, CHOICE);
	await harness.runService.start({
		promptPath: PROMPT_PATH,
		cwd: CWD,
		isChoiceRunnable: () => true,
		...(options.autoReview === true ? { autoReview: true } : {}),
	});
}

describe("GateBFlow.viewFromPendingReview", () => {
	it("builds a view from the review the machine holds", async () => {
		const harness = createHarness();
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);

		assert.ok(view);
		assert.equal(view.slug, "add-retry-logic");
		assert.equal(view.report, REPORT);
	});

	it("carries the feedback allowance so the menu can label the bound", async () => {
		const harness = createHarness();
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);

		assert.deepEqual(view?.feedback, { allowed: true, iteration: 1, maxIterations: 3 });
	});

	/** An interrupted state stores no diffstat, so it has to be read live. */
	it("reads a live diffstat for an interrupted review", async () => {
		const harness = createHarness({ interrupted: true });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);

		assert.equal(view?.report, null);
		assert.equal(view?.diffstat, DIFFSTAT);
	});

	it("builds nothing when no review is pending", async () => {
		const harness = createHarness();

		assert.equal(await harness.flow.viewFromPendingReview(harness.ctx), undefined);
	});
});

describe("GateBFlow.run", () => {
	it("accepts the review and returns to idle", async () => {
		const harness = createHarness({ selections: ["accept"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.equal(harness.machine.current().kind, "idle");
	});

	it("leaves the review pending when the gate is dismissed", async () => {
		const harness = createHarness({ selections: ["dismiss"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.equal(harness.machine.current().kind, "reviewing");
	});

	it("promises that /handoff reopens a dismissed review", async () => {
		const harness = createHarness({ selections: ["dismiss"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.match(harness.notifications[0]?.message ?? "", /`\/handoff` reopens this review/);
	});

	it("treats an escaped gate as leaving the review pending", async () => {
		const harness = createHarness({ selections: [undefined] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.equal(harness.machine.current().kind, "reviewing");
	});

	it("injects the review message when Review here is chosen", async () => {
		const harness = createHarness({ selections: ["review"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.equal(harness.messages.length, 1);
		assert.ok(harness.messages[0]?.includes(REPORT));
	});

	it("arms the review turn before returning", async () => {
		const harness = createHarness({ selections: ["review"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.equal(harness.machine.reviewing()?.awaitingReviewTurn, true);
	});

	/**
	 * The handler must return so the injected turn can run. If it looped back to the
	 * gate instead, a second overlay would sit in front of the review it just asked for.
	 */
	it("closes the gate after Review here rather than reopening it", async () => {
		const harness = createHarness({ selections: ["review"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.equal(harness.overlays.length, 1);
	});

	it("refuses Review here for an interrupted run and keeps the gate open", async () => {
		const harness = createHarness({ interrupted: true, selections: ["review", "dismiss"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.deepEqual(harness.messages, []);
		assert.equal(harness.overlays.length, 2);
	});

	it("prefills feedback with captured review text minus its verdict", async () => {
		const harness = createHarness({ selections: ["feedback"], editorResult: undefined });
		await reachReview(harness);
		harness.machine.clearReviewTurn({
			iteration: 1,
			verdict: "fix",
			text: "Fix the timeout edge case.\nVerdict: fix\n",
		});
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.deepEqual(harness.editorPrefills, ["Fix the timeout edge case."]);
	});

	it("opens a blank feedback editor when no review was captured", async () => {
		const harness = createHarness({ selections: ["feedback"], editorResult: undefined });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.deepEqual(harness.editorPrefills, [""]);
	});

	/**
	 * The editor takes a title and a prefill and nothing else, so a blank buffer can
	 * only explain itself in its title.
	 */
	it("says in the editor title that no review was captured", async () => {
		const harness = createHarness({ selections: ["feedback"], editorResult: undefined });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.match(harness.editorTitles[0] ?? "", /no review captured for iteration 1/);
		assert.match(harness.editorTitles[0] ?? "", /Review here/);
	});

	/** A review turn that failed stores empty text, which is no more usable than no review. */
	it("treats a captured review with empty text as no review", async () => {
		const harness = createHarness({ selections: ["feedback"], editorResult: undefined });
		await reachReview(harness);
		harness.machine.clearReviewTurn({ iteration: 1, text: "" });
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.deepEqual(harness.editorPrefills, [""]);
		assert.match(harness.editorTitles[0] ?? "", /no review captured for iteration 1/);
	});

	/**
	 * The gate's labels and its reviewer block key off the review's presence, so an
	 * empty one has to be absent from the view rather than reinterpreted downstream:
	 * otherwise one render offers "Send review to worker" over an empty findings block
	 * while the editor it opens says no review was captured.
	 */
	it("keeps an empty captured review out of the view entirely", async () => {
		const harness = createHarness();
		await reachReview(harness);
		harness.machine.clearReviewTurn({ iteration: 1, text: "   " });

		assert.equal((await harness.flow.viewFromPendingReview(harness.ctx))?.review, undefined);
	});

	/** A verdict is real evidence even with no findings, and it orders the gate's actions. */
	it("keeps a verdict-only review in the view", async () => {
		const harness = createHarness();
		await reachReview(harness);
		harness.machine.clearReviewTurn({ iteration: 1, verdict: "accept", text: "Verdict: accept" });

		assert.equal((await harness.flow.viewFromPendingReview(harness.ctx))?.review?.verdict, "accept");
	});

	it("returns to the gate without sending verdict-only feedback", async () => {
		const harness = createHarness({ selections: ["feedback", "dismiss"], editorResult: "Verdict: fix" });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.equal(harness.overlays.length, 2);
		assert.equal(harness.machine.reviewing()?.iteration, 1);
		assert.match(harness.notifications[0]?.message ?? "", /only a verdict line/);
	});

	/**
	 * The dead end this replaced: Enter submits and the editor trims, so typing nothing
	 * used to be reported as a verdict-only submission, which describes text the user
	 * never wrote.
	 */
	it("reports an empty feedback submission as empty rather than verdict-only", async () => {
		const harness = createHarness({ selections: ["feedback", "dismiss"], editorResult: "" });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.match(harness.notifications[0]?.message ?? "", /the feedback editor was empty/);
		assert.doesNotMatch(harness.notifications[0]?.message ?? "", /verdict line/);
		assert.match(harness.notifications[0]?.message ?? "", /Shift\+Enter/);
	});

	it("starts no iteration and reopens the gate after an empty submission", async () => {
		const harness = createHarness({ selections: ["feedback", "dismiss"], editorResult: "   " });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.equal(harness.machine.reviewing()?.iteration, 1);
		assert.equal(harness.overlays.length, 2);
	});

	/**
	 * The interrupted run is the case with no review and no prospect of one, so the
	 * editor opens on an editable draft rather than the blank buffer that sent users
	 * back to the gate.
	 */
	it("prefills resume instructions when an interrupted iteration has no review", async () => {
		const harness = createHarness({ interrupted: true, selections: ["feedback"], editorResult: undefined });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		const prefill = harness.editorPrefills[0] ?? "";
		assert.match(
			prefill,
			/What ended the previous iteration: The worker exited with code 1 without producing a report\./,
		);
		assert.match(prefill, /Write the final report/);
		assert.match(harness.editorTitles[0] ?? "", /interrupted iteration 1/);
	});

	it("sends the resume draft as feedback when it is submitted unchanged", async () => {
		const harness = createHarness({
			interrupted: true,
			selections: ["feedback", "dismiss"],
			editorSubmitsPrefill: true,
		});
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.equal(harness.machine.reviewing()?.iteration, 2);
		// No reviewer saw this iteration, so the section says whose instructions these are.
		assert.match(harness.promptWrites[0] ?? "", /## Instructions from the user \(iteration 2\)/);
		assert.doesNotMatch(harness.promptWrites[0] ?? "", /A reviewer inspected that tree/);
		assert.match(harness.promptWrites[0] ?? "", /What ended the previous iteration:/);
		// The interruption is stated once, by the preamble, not again by the draft under it.
		assert.equal((harness.promptWrites[0] ?? "").match(/did not finish/g)?.length, 1);
	});

	/**
	 * The advice has to name an option the gate actually offers. Review here is refused
	 * for a run that produced no report, so pointing an interrupted user at it would be
	 * the same dead end this message replaced.
	 */
	it("offers no Review here advice when an interrupted iteration submits nothing", async () => {
		const harness = createHarness({ interrupted: true, selections: ["feedback", "dismiss"], editorResult: "" });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.match(harness.notifications[0]?.message ?? "", /the feedback editor was empty/);
		assert.doesNotMatch(harness.notifications[0]?.message ?? "", /Review (here|again)/);
		assert.equal(harness.machine.reviewing()?.iteration, 1);
	});

	/** The menu relabels the option once a review exists, so the advice has to follow. */
	it("names Review again when the captured review was only a verdict", async () => {
		const harness = createHarness({ selections: ["feedback", "dismiss"], editorResult: "" });
		await reachReview(harness);
		harness.machine.clearReviewTurn({ iteration: 1, verdict: "fix", text: "Verdict: fix" });
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.match(harness.editorTitles[0] ?? "", /only its verdict/);
		assert.match(harness.notifications[0]?.message ?? "", /choose Review again first/);
	});

	it("refuses feedback at the bound without opening an editor", async () => {
		const harness = createHarness({ maxIterations: 1, selections: ["feedback", "dismiss"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.match(harness.notifications[0]?.message ?? "", /is the last of 1/);
	});

	it("keeps the review pending when feedback is refused at the bound", async () => {
		const harness = createHarness({ maxIterations: 1, selections: ["feedback", "dismiss"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.equal(harness.machine.current().kind, "reviewing");
	});

	it("auto-reviews a completed feedback iteration after Run and review", async () => {
		const harness = createHarness({ selections: ["feedback"], editorResult: "Fix the timeout edge case." });
		await reachReview(harness, { autoReview: true });
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.equal(harness.machine.reviewing()?.iteration, 2);
		assert.equal(harness.machine.reviewing()?.awaitingReviewTurn, true);
		assert.equal(harness.messages.length, 1);
		assert.equal(harness.overlays.length, 1, "the completed retry must not render Gate B before review");
	});

	it("opens Gate B when an auto-review feedback iteration is interrupted", async () => {
		const harness = createHarness({
			selections: ["feedback", "dismiss"],
			editorResult: "Fix the timeout edge case.",
			outcomes: [
				{
					exitCode: 0,
					report: REPORT,
					usage: USAGE,
					toolResults: [],
					stopReason: "endTurn",
					errorMessage: undefined,
					stderr: "",
					aborted: false,
				},
				{
					exitCode: 1,
					report: "partial",
					usage: USAGE,
					toolResults: [],
					stopReason: "error",
					errorMessage: undefined,
					stderr: "failed",
					aborted: false,
				},
			],
		});
		await reachReview(harness, { autoReview: true });
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.equal(harness.machine.reviewing()?.completion, "interrupted");
		assert.equal(harness.machine.reviewing()?.autoReview, true);
		assert.equal(harness.messages.length, 0);
		assert.equal(harness.overlays.length, 2);
	});

	it("opens Gate B after a completed feedback iteration from plain Run", async () => {
		const harness = createHarness({ selections: ["feedback", "dismiss"], editorResult: "Fix the timeout edge case." });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.equal(harness.machine.reviewing()?.completion, "completed");
		assert.equal(harness.machine.reviewing()?.awaitingReviewTurn, false);
		assert.equal(harness.messages.length, 0);
		assert.equal(harness.overlays.length, 2);
	});
});

describe("GateBFlow.handleAgentEnd", () => {
	it("does nothing when no handoff is active", async () => {
		const harness = createHarness();
		await harness.flow.handleAgentEnd(harness.ctx);

		assert.deepEqual(harness.overlays, []);
		assert.deepEqual(harness.notifications, []);
	});

	it("does nothing while a review is pending but unarmed", async () => {
		const harness = createHarness();
		await reachReview(harness);
		await harness.flow.handleAgentEnd(harness.ctx);

		assert.deepEqual(harness.overlays, []);
	});

	it("reopens Gate B after the review turn it armed", async () => {
		const harness = createHarness({ selections: ["review", "dismiss"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);
		await harness.flow.handleAgentEnd(harness.ctx);

		assert.equal(harness.overlays.length, 2);
	});

	it("captures the final reviewer text and verdict before reopening Gate B", async () => {
		const harness = createHarness({ selections: ["review", "dismiss"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);
		await harness.flow.handleAgentEnd(harness.ctx, "The timeout path needs a test.\nVerdict: FIX\n");

		assert.deepEqual(harness.machine.reviewing()?.review, {
			iteration: 1,
			verdict: "fix",
			text: "The timeout path needs a test.\nVerdict: FIX\n",
		});
		assert.equal(harness.machine.reviewing()?.awaitingReviewTurn, false);
	});

	/**
	 * The ordering guard. `agent_end` can fire more than once per prompt, so the arm
	 * has to be down before the gate opens; clearing it afterwards would let the
	 * second event open a second gate behind the first.
	 */
	it("opens exactly one gate when agent_end fires twice for one prompt", async () => {
		const harness = createHarness({ selections: ["review", "dismiss", "dismiss"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		await harness.flow.handleAgentEnd(harness.ctx);
		await harness.flow.handleAgentEnd(harness.ctx);

		// One for Review here, one for the reopen. A third would be the stacked gate.
		assert.equal(harness.overlays.length, 2);
	});

	/**
	 * A concurrent second event must not slip past the flag either: the clear happens
	 * before the first `await`, so the second call sees it down without interleaving.
	 */
	it("opens one gate when two agent_end events race", async () => {
		const harness = createHarness({ selections: ["review", "dismiss", "dismiss"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		await Promise.all([harness.flow.handleAgentEnd(harness.ctx), harness.flow.handleAgentEnd(harness.ctx)]);

		assert.equal(harness.overlays.length, 2);
	});

	it("does not reopen the gate on turns after a dismissed reopen", async () => {
		const harness = createHarness({ selections: ["review", "dismiss"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);
		await harness.flow.handleAgentEnd(harness.ctx);
		harness.overlays.length = 0;

		await harness.flow.handleAgentEnd(harness.ctx);
		assert.deepEqual(harness.overlays, []);
	});

	it("opens no gate outside a TUI, but still clears the arm", async () => {
		const harness = createHarness({ selections: ["review"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		const headless = { ...harness.ctx, mode: "print" } as unknown as ExtensionContext;
		await harness.flow.handleAgentEnd(headless);

		assert.equal(harness.machine.reviewing()?.awaitingReviewTurn, false);
		assert.equal(harness.overlays.length, 1);
	});
});

/**
 * "Run and review" reuses this seam rather than rebuilding the injection, so these
 * assert it arms and injects exactly as the gate's own Review here does.
 */
describe("GateBFlow.startReviewTurn", () => {
	it("arms the review turn and injects the review message", async () => {
		const harness = createHarness();
		await reachReview(harness);

		assert.equal(harness.flow.startReviewTurn(harness.ctx), true);
		assert.equal(harness.machine.reviewing()?.awaitingReviewTurn, true);
		assert.equal(harness.messages.length, 1);
	});

	it("opens no gate, since the point is to skip it", async () => {
		const harness = createHarness();
		await reachReview(harness);
		harness.flow.startReviewTurn(harness.ctx);

		assert.deepEqual(harness.overlays, []);
	});

	it("injects the same message the gate's Review here would have", async () => {
		const auto = createHarness();
		await reachReview(auto);
		auto.flow.startReviewTurn(auto.ctx);

		const manual = createHarness({ selections: ["review"] });
		await reachReview(manual);
		const view = await manual.flow.viewFromPendingReview(manual.ctx);
		assert.ok(view);
		await manual.flow.run(manual.ctx, view);

		assert.deepEqual(auto.messages, manual.messages);
	});

	it("reports failure when the machine refuses to arm, so the caller can fall back", () => {
		const harness = createHarness();
		assert.equal(harness.flow.startReviewTurn(harness.ctx), false);
		assert.deepEqual(harness.messages, []);
	});

	/** An interrupted run has no report, so there is nothing to review automatically. */
	it("refuses to arm an interrupted review", async () => {
		const harness = createHarness({ interrupted: true });
		await reachReview(harness);

		assert.equal(harness.flow.startReviewTurn(harness.ctx), false);
	});

	it("reopens Gate B once when the injected turn ends", async () => {
		const harness = createHarness({ selections: ["dismiss"] });
		await reachReview(harness);
		harness.flow.startReviewTurn(harness.ctx);
		await harness.flow.handleAgentEnd(harness.ctx, "Looks right.\n\nVerdict: accept");

		assert.equal(harness.overlays.length, 1);
		assert.equal(harness.machine.reviewing()?.review?.verdict, "accept");
	});
});

describe("GateBFlow leftovers follow-up", () => {
	/** Captured before Accept, which resets the machine and takes the review with it. */
	it("accepts, then requests a follow-up draft from the prompt and structured items only", async () => {
		// The reopen from `agent_end` is what renders the gate here, and its single queued
		// selection is the leftovers option.
		const harness = createHarness({ selections: ["accept_leftovers"] });
		await reachReview(harness);
		// Armed first: `agent_end` only captures a review for a turn Review here started.
		harness.flow.startReviewTurn(harness.ctx);
		await harness.flow.handleAgentEnd(
			harness.ctx,
			"Correct.\n\nNote for you: schedule the rollout.\n\nLeftovers:\n- Update the stale comment on line 12\n- Rename the misleading test\nVerdict: accept",
		);

		assert.deepEqual(harness.machine.current(), { kind: "idle" });
		assert.equal(harness.leftovers.length, 1);
		assert.equal(harness.leftovers[0]?.slug, "add-retry-logic");
		assert.equal(harness.leftovers[0]?.prompt, DRAFT.prompt);
		assert.deepEqual(harness.leftovers[0]?.items, [
			"Update the stale comment on line 12",
			"Rename the misleading test",
		]);
		assert.equal(harness.leftovers[0]?.reviewText, undefined);
	});

	it("falls back to the full review only when the structured block is missing", async () => {
		const harness = createHarness({ selections: ["accept_leftovers"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.deepEqual(harness.machine.current(), { kind: "idle" });
		assert.equal(harness.leftovers.length, 1);
		assert.equal(harness.leftovers[0]?.reviewText, "");
		assert.equal(harness.leftovers[0]?.items, undefined);
	});
});

describe("GateBFlow read-only viewers", () => {
	it("returns to the gate after viewing the full report", async () => {
		const harness = createHarness({ selections: ["view_report", "dismiss"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		// Gate, viewer, gate again: the viewer decides nothing and hands control back.
		assert.equal(harness.overlays.length, 3);
	});

	it("titles the pre-crash viewer as partial output rather than correcting a report label", async () => {
		const partial = Array.from({ length: 10 }, (_, index) => `partial ${index}`).join("\n");
		const harness = createHarness({
			selections: ["view_report", "dismiss"],
			outcomes: [
				{
					exitCode: 1,
					report: partial,
					usage: USAGE,
					toolResults: [],
					stopReason: "error",
					errorMessage: undefined,
					stderr: "",
					aborted: false,
				},
			],
		});
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.deepEqual(harness.viewerTitles, ["Partial output — add-retry-logic (NOT a report)"]);
	});

	it("returns to the gate after viewing the full diffstat", async () => {
		const harness = createHarness({ selections: ["view_diffstat", "dismiss"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.equal(harness.overlays.length, 3);
	});

	it("leaves the review pending after a viewer, changing no state", async () => {
		const harness = createHarness({ selections: ["view_report", "dismiss"] });
		await reachReview(harness);
		const view = await harness.flow.viewFromPendingReview(harness.ctx);
		assert.ok(view);
		await harness.flow.run(harness.ctx, view);

		assert.equal(harness.machine.current().kind, "reviewing");
	});
});
