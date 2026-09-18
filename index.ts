/**
 * Pi Handoff: keeps the current session as reviewer while an isolated child Pi
 * session implements an approved handoff.
 *
 * This file is the composition root. It constructs adapters and services, then
 * registers the command and the lifecycle hooks. All behavior lives in `src/`:
 *
 *   src/domain/       pure handoff rules, no IO or Pi imports
 *   src/ports/        interfaces for everything outside the process
 *   src/adapters/     filesystem, shell, and child-process implementations
 *   src/persistence/  schemas and storage-boundary validation
 *   src/app/          handoff state machine and services
 *   src/presentation/ gates, widgets, and model picker
 *   src/prompts/      drafting and review prompt text
 *   src/commands/     /handoff argument parsing and dispatch
 *
 * Almost everything is built once per session, because a session owns at most one
 * handoff and three separate entry points have to reach the same one: the command,
 * the `agent_end` reopen, and the `session_shutdown` kill. In particular the run
 * service is session-scoped so the shutdown hook can stop a worker it never
 * started, and the live-registry check it needs is passed per call instead of
 * captured, so a session-lived object cannot approve a model that has since
 * disappeared.
 *
 * The drafting service is the exception: it depends on `ctx.model` and the live
 * registry, which can both change between commands, and a stale model must never
 * be used for a side-call the user did not intend.
 *
 * The rubric is `DEFAULT_RUBRIC` for now. A `ConfigStore` reading
 * `~/.pi/agent/handoff.json`, and the `/handoff config` editor that maintains it,
 * are unimplemented and unassigned in the design's task list.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChildProcessWorkerRunner } from "./src/adapters/child-process-worker-runner.ts";
import { createExecGit } from "./src/adapters/exec-git.ts";
import { createFsPromptFileWriter } from "./src/adapters/fs-prompt-file-writer.ts";
import { createPbcopyClipboard } from "./src/adapters/pbcopy-clipboard.ts";
import { createPiDraftingModel, createPiSessionTranscriptSource } from "./src/adapters/pi-drafting-model.ts";
import {
	createSessionHandoffReportRecorder,
	createSessionHandoffStateRecorder,
} from "./src/adapters/session-state-recorder.ts";
import { createSystemClock } from "./src/adapters/system-clock.ts";
import { createDraftService, type DraftService } from "./src/app/draft-service.ts";
import { createHandoffMachine, rehydrateLatestHandoffState } from "./src/app/handoff-machine.ts";
import { createReviewService } from "./src/app/review-service.ts";
import { createRunService } from "./src/app/run-service.ts";
import { createGateBFlow } from "./src/commands/gate-b-flow.ts";
import { createHandoffCommandHandler, type HandoffCommand } from "./src/commands/handoff-command.ts";
import { finalAssistantText } from "./src/commands/review-turn.ts";
import { HANDOFF_COMMAND_NAME } from "./src/commands/parse.ts";
import { DEFAULT_RUBRIC } from "./src/domain/rubric/defaults.ts";
import { isModelAvailable } from "./src/domain/rubric/resolve.ts";
import type { ModelChoice } from "./src/domain/types.ts";

export default function handoff(pi: ExtensionAPI) {
	const machine = createHandoffMachine();
	const recorder = createSessionHandoffStateRecorder(pi);
	const reportRecorder = createSessionHandoffReportRecorder(pi);
	const promptWriter = createFsPromptFileWriter();
	const clipboard = createPbcopyClipboard();
	const clock = createSystemClock();
	const workerRunner = createChildProcessWorkerRunner();
	// `pi.exec` already buffers an argument-vector command into the shape T5's Exec
	// port expects, so the Git adapter needs no separate process adapter of its own.
	const git = createExecGit((command, args, options) => pi.exec(command, args, { cwd: options.cwd }));

	const runService = createRunService({ machine, runner: workerRunner, git, clock, recorder });

	const reviewService = createReviewService({
		machine,
		runService,
		promptWriter,
		reportRecorder,
		recorder,
		clock,
		maxIterations: DEFAULT_RUBRIC.maxIterations,
	});

	/**
	 * Re-checks a model against the live registry at the moment of a click.
	 *
	 * Read through the context rather than captured, because a provider can appear
	 * or disappear while a gate sits open, and every spawn is gated on this.
	 */
	function isChoiceRunnable(ctx: ExtensionContext, choice: ModelChoice | undefined): boolean {
		if (choice === undefined) return false;
		const available = ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id }));
		return isModelAvailable(`${choice.provider}/${choice.model}`, available);
	}

	/** Builds the drafting service for one invocation, or nothing if no model is selected. */
	function createService(ctx: ExtensionContext): DraftService | undefined {
		const model = ctx.model;
		if (model === undefined) return undefined;

		return createDraftService({
			machine,
			draftingModel: createPiDraftingModel(ctx, model),
			transcript: createPiSessionTranscriptSource(ctx),
			promptWriter,
			recorder,
			rubric: DEFAULT_RUBRIC,
			availableModels: () =>
				ctx.modelRegistry.getAvailable().map((available) => ({ provider: available.provider, id: available.id })),
		});
	}

	/**
	 * Assigned after both are built, because the two genuinely need each other:
	 * Gate B's "Accept and hand off leftovers" starts a draft, and the drafting flow
	 * ends at a run whose result Gate B renders. The command is built second and
	 * patched in here rather than duplicating the drafting flow inside Gate B.
	 */
	let command: HandoffCommand | undefined;

	const gateBFlow = createGateBFlow({
		machine,
		runService,
		reviewService,
		clock,
		isChoiceRunnable,
		// `pi.sendUserMessage` returns void and Pi's own runtime attaches the rejection
		// handler, so this is fire-and-forget by construction: the injected message
		// starts an agent turn that the calling handler must return from, and that turn's
		// `agent_end` is what reopens the gate. `deliverAs: "followUp"` is required because
		// Gate B can reopen from `agent_end`, while the agent is still streaming and an
		// un-queued message is refused; when the agent is idle, the option is ignored.
		sendUserMessage: (content) => {
			pi.sendUserMessage(content, { expandPromptTemplates: false, deliverAs: "followUp" });
		},
		draftLeftovers: async (ctx, input) => {
			await command?.draftLeftovers(ctx, input);
		},
	});

	command = createHandoffCommandHandler({
		machine,
		createService,
		runService,
		gateBFlow,
		isChoiceRunnable,
		clipboard,
		clock,
	});

	pi.registerCommand(HANDOFF_COMMAND_NAME, {
		description: "Draft and run a review-preserving implementation handoff.",
		handler: command.handle,
	});

	/**
	 * Restores a handoff that outlived its session, or resets to idle.
	 *
	 * No UI opens here. The reason is deliberately ignored: a `"new"` session has no
	 * entries on its branch, so the same code path resets it, and branching on the
	 * reason would add a way for the two to disagree. Rehydration downgrades a
	 * `running` entry to an interrupted review, which is what makes the child's death
	 * visible instead of silently losing the checkpoint Discard needs.
	 */
	pi.on("session_start", (_event, ctx) => {
		const restored = rehydrateLatestHandoffState(ctx.sessionManager.getBranch());
		if (restored === undefined) machine.reset();
		else machine.restore(restored);
	});

	/**
	 * Kills any worker before Pi tears the session down.
	 *
	 * Awaited on purpose: aborting only requests the death, and the adapter escalates
	 * SIGTERM to SIGKILL after a grace period, so returning early would let Pi exit
	 * while a child was still writing to the working tree — the orphaned-worker case
	 * §7 forbids. State is deliberately untouched: the already-recorded `running`
	 * entry is what lets the next `session_start` downgrade it to an interrupted
	 * review, so overwriting it here would erase the evidence.
	 *
	 * An external run needs no special case. It never created an `AbortController`, so
	 * `abortActiveRun` reports nothing to stop and this returns immediately — the
	 * hook cannot try to kill a process that was never this session's to begin with.
	 */
	pi.on("session_shutdown", async () => {
		if (!runService.abortActiveRun()) return;
		await runService.whenSettled();
	});

	/**
	 * Reopens Gate B after the review turn that Review here injected.
	 *
	 * Inert in every other case. The flow reads the arm flag, clears it before
	 * opening anything, and returns early otherwise, so an ordinary turn in a session
	 * with no handoff never sees handoff UI.
	 */
	pi.on("agent_end", async (event, ctx) => {
		await gateBFlow.handleAgentEnd(ctx, finalAssistantText(event.messages));
	});
}
