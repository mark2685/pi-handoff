/**
 * Pi Handoff: keeps the current session as reviewer while an isolated child Pi
 * session implements an approved handoff.
 *
 * This file is the composition root. It constructs adapters and services, then
 * registers the command. All behavior lives in `src/`:
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
 * The machine and the state recorder are built once per session, because they
 * represent the one handoff a session may own. The drafting service is built per
 * invocation instead: it depends on `ctx.model` and the live registry, which can
 * both change between commands, and a stale model must never be used for a
 * side-call the user did not intend.
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
import { createHandoffMachine } from "./src/app/handoff-machine.ts";
import { createRunService, type RunService } from "./src/app/run-service.ts";
import { createHandoffCommandHandler } from "./src/commands/handoff-command.ts";
import { DEFAULT_RUBRIC } from "./src/domain/rubric/defaults.ts";

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
	 * Builds the run service for one invocation.
	 *
	 * It borrows the drafting service's `isChoiceRunnable`, which reads the live
	 * registry, so the spawn-time model check sees the registry as it is at the
	 * moment of the click rather than as it was when Gate A opened.
	 */
	function createRun(_ctx: ExtensionContext, service: DraftService): RunService {
		return createRunService({
			machine,
			runner: workerRunner,
			git,
			clock,
			recorder,
			isChoiceRunnable: (choice) => service.isChoiceRunnable(choice),
		});
	}

	pi.registerCommand("handoff", {
		description: "Draft and run a review-preserving implementation handoff.",
		handler: createHandoffCommandHandler({
			machine,
			createService,
			createRunService: createRun,
			clipboard,
			reportRecorder,
			clock,
		}),
	});
}
