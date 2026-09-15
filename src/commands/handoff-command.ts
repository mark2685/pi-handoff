/**
 * `/handoff` dispatch: drafting, Gate A, and the escape hatches.
 *
 * This module owns the loop that keeps Gate A open across Edit prompt and Change
 * model, because those options change the proposal and must re-render it rather
 * than fall through to a decision. Every branch that ends the handoff routes
 * through the service so the machine and its session entries stay consistent.
 *
 * Two guards are deliberate. Non-interactive modes never open a gate, so
 * `/handoff status` keeps working headlessly while drafting refuses cleanly. And
 * Run re-checks the chosen model against the live registry at the moment of the
 * click, not just when the tier resolved, because a provider can disappear while
 * the gate sits open.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DraftOutcome, DraftReady, DraftService } from "../app/draft-service.ts";
import type { HandoffMachine } from "../app/handoff-machine.ts";
import type { RunOutcome, RunService } from "../app/run-service.ts";
import type { HandoffReportRecorder } from "../app/state-recorder.ts";
import { buildLaunchCommand, formatModelChoice } from "../domain/draft/launch.ts";
import { formatDiscardHeadline, formatDiscardSummary } from "../domain/report/discard.ts";
import type { ModelChoice } from "../domain/types.ts";
import type { Clock } from "../ports/clock.ts";
import type { Clipboard } from "../ports/clipboard.ts";
import type { GitFailure } from "../ports/git.ts";
import { withLoader } from "../presentation/drafting-loader.ts";
import { openGateA } from "../presentation/gate-a.ts";
import { openAcknowledgement, openGateB, type GateBView } from "../presentation/gate-b.ts";
import { confirmDiscardMenu, selectOption, unparseableMenu } from "../presentation/menus.ts";
import { pickModel } from "../presentation/model-picker.ts";
import { runWithWidget } from "../presentation/running-widget.ts";
import { parseHandoffCommand } from "./parse.ts";
import { formatHandoffStatus } from "./status.ts";

export interface HandoffCommandDeps {
	machine: HandoffMachine;
	/** Constructed per invocation, because the drafting model depends on the live context. */
	createService: (ctx: ExtensionContext) => DraftService | undefined;
	/** Constructed per invocation for the same reason, since Run re-checks the live registry. */
	createRunService: (ctx: ExtensionContext, service: DraftService) => RunService;
	clipboard: Clipboard;
	reportRecorder: HandoffReportRecorder;
	clock: Clock;
}

/** Renders a Git failure as a sentence a user can act on. */
function describeGitFailure(failure: GitFailure): string {
	switch (failure.kind) {
		case "not_repository":
			return `This directory is not a Git repository (${failure.detail})`;
		case "no_head":
			return `This repository has no commit to check against (${failure.detail})`;
		case "repository_changed":
			return `The repository moved from ${failure.checkpointRoot} to ${failure.currentRoot}`;
		case "head_changed":
			return `HEAD moved from ${failure.checkpointHead} to ${failure.currentHead} since the checkpoint`;
		case "invalid_checkpoint":
			return `The checkpoint could not be used (${failure.detail})`;
		case "invalid_porcelain":
			return `Git reported a status this extension could not read (${failure.detail})`;
		case "command_failed":
			return `\`${failure.command}\` failed: ${failure.detail}`;
	}
}

/** Renders a draft outcome that ends the flow before Gate A. */
function reportTerminalOutcome(ctx: ExtensionContext, outcome: DraftOutcome): void {
	switch (outcome.kind) {
		case "empty_session":
			ctx.ui.notify("No conversation to hand off yet", "warning");
			return;
		case "failed":
			switch (outcome.failure.kind) {
				case "aborted":
					ctx.ui.notify("Handoff drafting cancelled", "info");
					return;
				case "empty_response":
					ctx.ui.notify("The drafting model returned no text", "error");
					return;
				case "completion_failed":
					ctx.ui.notify(`Handoff drafting failed: ${outcome.failure.detail}`, "error");
					return;
			}
			return;
		case "write_failed":
			ctx.ui.notify(
				`Could not write the handoff prompt to ${outcome.failure.path}: ${outcome.failure.detail}`,
				"error",
			);
			return;
		case "needs_input":
			// The draft asked for context; show it rather than running it.
			ctx.ui.notify(`The draft needs more context before it can run. Prompt saved to ${outcome.promptPath}`, "warning");
			ctx.ui.setEditorText(outcome.draft.prompt);
			return;
		case "ready":
		case "unparseable":
			return;
	}
}

/** Copies the launch command, falling back to showing it when no clipboard exists. */
async function runExternally(ctx: ExtensionContext, clipboard: Clipboard, view: DraftReady): Promise<void> {
	if (view.choice === undefined) {
		ctx.ui.notify("Choose a model before copying the launch command", "warning");
		return;
	}

	const command = buildLaunchCommand(view.choice, view.promptPath);
	const copied = await clipboard.copy(command);
	if (copied.ok) {
		ctx.ui.notify(`Launch command copied to the clipboard:\n${command}`, "info");
		return;
	}

	// The clipboard is optional; the command itself is the feature.
	ctx.ui.notify(`Clipboard unavailable (${copied.error.detail}). Run this command:\n${command}`, "warning");
}

/** Creates the `/handoff` handler. */
export function createHandoffCommandHandler(deps: HandoffCommandDeps) {
	const { machine, createService, createRunService, clipboard, reportRecorder, clock } = deps;

	/**
	 * Runs the worker behind the live widget and returns its outcome.
	 *
	 * The widget's Escape handler calls the run service's kill seam rather than
	 * resolving the overlay, so the overlay closes only once the child is actually
	 * gone. See `running-widget.ts` for why that ordering matters.
	 */
	async function runWorker(
		ctx: ExtensionContext,
		runService: RunService,
		view: DraftReady,
		choice: ModelChoice,
	): Promise<RunOutcome | undefined> {
		const rendered = await runWithWidget(
			ctx,
			{ slug: view.draft.slug, choice, promptPath: view.promptPath },
			{ nowMs: () => clock.nowMs(), onAbort: () => runService.abortActiveRun() },
			(onProgress) => runService.start({ promptPath: view.promptPath, cwd: ctx.cwd, onProgress }),
		);

		if (rendered.kind === "failed") {
			// A rejection here is a defect, not a cancellation, so it is reported as one.
			ctx.ui.notify(`The handoff run failed unexpectedly: ${rendered.detail}`, "error");
			return undefined;
		}

		return rendered.value;
	}

	/** Builds Gate B's view from a run outcome that reached a review state. */
	function buildGateBView(view: DraftReady, choice: ModelChoice, outcome: RunOutcome): GateBView | undefined {
		const base = { slug: view.draft.slug, choice, promptPath: view.promptPath };

		if (outcome.kind === "completed") {
			return {
				...base,
				iteration: outcome.state.iteration,
				report: outcome.state.report,
				diffstat: outcome.state.diffstat,
				diffstatFailure:
					outcome.diffstatFailure === undefined ? undefined : describeGitFailure(outcome.diffstatFailure),
				usage: outcome.state.usage,
				interruptionNote: undefined,
			};
		}

		if (outcome.kind === "interrupted") {
			return {
				...base,
				iteration: outcome.state.iteration,
				report: null,
				diffstat: outcome.diffstat,
				diffstatFailure:
					outcome.diffstatFailure === undefined ? undefined : describeGitFailure(outcome.diffstatFailure),
				usage: null,
				interruptionNote: outcome.state.interruptionNote,
			};
		}

		return undefined;
	}

	/** Reports a run outcome that never reached a review state. */
	function reportRunRefusal(ctx: ExtensionContext, outcome: RunOutcome): void {
		switch (outcome.kind) {
			case "model_unavailable":
				ctx.ui.notify(
					`${formatModelChoice(outcome.choice)} is no longer available, so the worker was not started`,
					"error",
				);
				return;
			case "checkpoint_failed":
				// Refused before spawning: without a checkpoint, Discard would have nothing to revert to.
				ctx.ui.notify(
					`The worker was not started because no checkpoint could be taken. ${describeGitFailure(outcome.failure)}`,
					"error",
				);
				return;
			case "refused":
				ctx.ui.notify(outcome.conflict.message, "warning");
				return;
			case "completed":
			case "interrupted":
				return;
		}
	}

	/** Discards the worker's changes, always reporting which paths were left alone. */
	async function discardChanges(ctx: ExtensionContext, runService: RunService): Promise<boolean> {
		const confirmed = await selectOption(
			(title, options) => ctx.ui.select(title, options),
			"Discard the worker's changes?",
			confirmDiscardMenu(),
		);
		if (confirmed !== "discard") return false;

		const discarded = await runService.discard(ctx.cwd);
		if (!discarded.ok) {
			const message =
				discarded.error.kind === "conflict"
					? discarded.error.message
					: `Nothing was discarded. ${describeGitFailure(discarded.error)}`;
			ctx.ui.notify(message, "error");
			return false;
		}

		// Always acknowledged, never a transient notify: skipped paths are the one thing
		// here a user cannot afford to scroll past.
		await openAcknowledgement(ctx, formatDiscardHeadline(discarded.value), formatDiscardSummary(discarded.value), {
			warning: discarded.value.skippedPaths.length > 0,
		});
		return true;
	}

	/** Records the accepted report and returns to idle, committing nothing. */
	function acceptRun(ctx: ExtensionContext, gateB: GateBView): void {
		if (gateB.report !== null) {
			reportRecorder.record({
				slug: gateB.slug,
				model: formatModelChoice(gateB.choice),
				iteration: gateB.iteration,
				report: gateB.report,
				diffstat: gateB.diffstat,
				acceptedAt: clock.nowIso(),
			});
		}

		machine.reset();
		ctx.ui.notify("Handoff accepted. The working tree is unchanged and nothing was committed.", "info");
	}

	/** Keeps Gate B open until the user accepts, discards, or leaves it pending. */
	async function reviewRun(ctx: ExtensionContext, runService: RunService, gateB: GateBView): Promise<void> {
		for (;;) {
			const selected = await openGateB(ctx, gateB);

			if (selected === undefined || selected === "dismiss") {
				// Reopening a dismissed gate belongs to a later task, so this does not promise it.
				ctx.ui.notify(
					"Review left pending. The worker's changes are still in the working tree, and a new handoff is refused until this one is accepted or discarded.",
					"info",
				);
				return;
			}

			if (selected === "accept") {
				acceptRun(ctx, gateB);
				return;
			}

			if (selected === "discard") {
				const discarded = await discardChanges(ctx, runService);
				if (discarded) return;
				continue;
			}

			// Review here and Send feedback to worker are shown blocked; a later task owns them.
			ctx.ui.notify(
				selected === "review"
					? "Review here is not implemented yet. Accept or discard for now."
					: "Sending feedback to the worker is not implemented yet. Accept or discard for now.",
				"warning",
			);
		}
	}

	return async function handleHandoffCommand(args: string, ctx: ExtensionContext): Promise<void> {
		const command = parseHandoffCommand(args);

		if (command.kind === "status") {
			ctx.ui.notify(formatHandoffStatus(machine.current()), "info");
			return;
		}

		if (command.kind === "unimplemented") {
			ctx.ui.notify(`/handoff ${command.name} is not implemented yet`, "info");
			return;
		}

		// Drafting needs a gate, an editor, and a model; none of that exists headlessly.
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/handoff requires interactive mode; use /handoff status elsewhere", "error");
			return;
		}

		const service = createService(ctx);
		if (service === undefined) {
			ctx.ui.notify("No model is selected, so a handoff cannot be drafted", "error");
			return;
		}

		let view: DraftReady | undefined;

		// Drafting retries in place, so this loop re-enters until a draft is ready or the flow ends.
		while (view === undefined) {
			const drafted = await withLoader(ctx, "Drafting handoff…", (signal) => service.draft(command.scope, signal));
			if (drafted.kind === "aborted") {
				service.abandon();
				ctx.ui.notify("Handoff drafting cancelled", "info");
				return;
			}

			const outcome = drafted.value;
			if (!outcome.ok) {
				ctx.ui.notify(outcome.error.message, "warning");
				return;
			}

			if (outcome.value.kind === "unparseable") {
				ctx.ui.notify("The drafting model did not return a valid handoff envelope", "warning");
				ctx.ui.setEditorText(outcome.value.rawResponse);
				const retry = await selectOption(
					(title, options) => ctx.ui.select(title, options),
					"Drafting response could not be parsed",
					unparseableMenu(),
				);
				if (retry !== "retry") {
					service.abandon();
					ctx.ui.notify("Handoff cancelled", "info");
					return;
				}
				continue;
			}

			if (outcome.value.kind !== "ready") {
				reportTerminalOutcome(ctx, outcome.value);
				return;
			}

			view = outcome.value;
		}

		// Gate A stays open across Edit prompt and Change model.
		for (;;) {
			const runnable = service.isChoiceRunnable(view.choice);
			const selected = await openGateA(ctx, { ...view, runnable });

			if (selected === undefined || selected === "cancel") {
				// Cancel leaves the /tmp prompt in place by design.
				service.abandon();
				ctx.ui.notify(`Handoff cancelled. Prompt left at ${view.promptPath}`, "info");
				return;
			}

			if (selected === "run") {
				const choice = view.choice;
				if (!runnable || choice === undefined) {
					ctx.ui.notify("Run is blocked until an available model is chosen", "warning");
					continue;
				}

				const runService = createRunService(ctx, service);
				const outcome = await runWorker(ctx, runService, view, choice);
				if (outcome === undefined) return;

				const gateB = buildGateBView(view, choice, outcome);
				if (gateB === undefined) {
					// The run never started; Gate A stays open so the user can fix the cause.
					reportRunRefusal(ctx, outcome);
					if (outcome.kind === "refused") return;
					continue;
				}

				await reviewRun(ctx, runService, gateB);
				return;
			}

			if (selected === "external") {
				await runExternally(ctx, clipboard, view);
				service.abandon();
				return;
			}

			if (selected === "edit") {
				const edited = await ctx.ui.editor("Edit handoff prompt", view.draft.prompt);
				if (edited === undefined) continue;
				const revised = await service.revisePrompt(edited);
				if (!revised.ok) {
					const message = "message" in revised.error ? revised.error.message : revised.error.detail;
					ctx.ui.notify(`Could not update the prompt: ${message}`, "error");
					continue;
				}
				view = revised.value;
				continue;
			}

			if (selected === "model") {
				const picked = await pickModel(ctx, "Choose the worker model");
				if (picked === undefined) continue;
				const chosen = service.chooseModel(picked);
				if (!chosen.ok) {
					ctx.ui.notify(chosen.error.message, "warning");
					continue;
				}
				view = chosen.value;
			}
		}
	};
}
