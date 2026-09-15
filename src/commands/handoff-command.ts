/**
 * `/handoff` dispatch: drafting, Gate A, and the escape hatches.
 *
 * This module owns the loop that keeps Gate A open across Edit prompt and Change
 * model, because those options change the proposal and must re-render it rather
 * than fall through to a decision. Every branch that ends the handoff routes
 * through the service so the machine and its session entries stay consistent.
 *
 * Gate B's own loop lives in `gate-b-flow.ts`, because the `agent_end` reopen and
 * `/handoff` while a review is pending both need it and neither goes through
 * drafting.
 *
 * Three guards are deliberate. Non-interactive modes never open a gate, so
 * `/handoff status` keeps working headlessly while drafting refuses cleanly. Run
 * re-checks the chosen model against the live registry at the moment of the click,
 * not just when the tier resolved, because a provider can disappear while the gate
 * sits open. And a pending review short-circuits before drafting: the machine
 * would refuse a new draft anyway, so reopening the gate the user already has is
 * the only useful thing `/handoff` can do there.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DraftOutcome, DraftReady, DraftService } from "../app/draft-service.ts";
import type { HandoffMachine } from "../app/handoff-machine.ts";
import type { RunOutcome, RunService } from "../app/run-service.ts";
import { buildLaunchCommand, formatModelChoice } from "../domain/draft/launch.ts";
import type { ModelChoice } from "../domain/types.ts";
import type { Clock } from "../ports/clock.ts";
import type { Clipboard } from "../ports/clipboard.ts";
import { withLoader } from "../presentation/drafting-loader.ts";
import { openGateA } from "../presentation/gate-a.ts";
import { describeGitFailure } from "../presentation/git-failure.ts";
import { selectOption, unparseableMenu } from "../presentation/menus.ts";
import { pickModel } from "../presentation/model-picker.ts";
import { runWithWidget } from "../presentation/running-widget.ts";
import type { GateBFlow } from "./gate-b-flow.ts";
import { parseHandoffCommand } from "./parse.ts";
import { formatHandoffStatus } from "./status.ts";

export interface HandoffCommandDeps {
	machine: HandoffMachine;
	/** Constructed per invocation, because the drafting model depends on the live context. */
	createService: (ctx: ExtensionContext) => DraftService | undefined;
	/** Session-scoped, so a reopened gate and the shutdown hook reach the same run. */
	runService: RunService;
	/** Session-scoped for the same reason: `agent_end` has no invocation to build one in. */
	gateBFlow: GateBFlow;
	/** Re-checked at every click, so a vanished provider blocks the spawn. */
	isChoiceRunnable: (ctx: ExtensionContext, choice: ModelChoice | undefined) => boolean;
	clipboard: Clipboard;
	clock: Clock;
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
	const { machine, createService, runService, gateBFlow, isChoiceRunnable, clipboard, clock } = deps;

	/**
	 * Runs the worker behind the live widget and returns its outcome.
	 *
	 * The widget's Escape handler calls the run service's kill seam rather than
	 * resolving the overlay, so the overlay closes only once the child is actually
	 * gone. See `running-widget.ts` for why that ordering matters.
	 */
	async function runWorker(
		ctx: ExtensionContext,
		view: DraftReady,
		choice: ModelChoice,
	): Promise<RunOutcome | undefined> {
		const rendered = await runWithWidget(
			ctx,
			{ slug: view.draft.slug, choice, promptPath: view.promptPath },
			{ nowMs: () => clock.nowMs(), onAbort: () => runService.abortActiveRun() },
			(onProgress) =>
				runService.start({
					promptPath: view.promptPath,
					cwd: ctx.cwd,
					onProgress,
					isChoiceRunnable: (candidate) => isChoiceRunnable(ctx, candidate),
				}),
		);

		if (rendered.kind === "failed") {
			// A rejection here is a defect, not a cancellation, so it is reported as one.
			ctx.ui.notify(`The handoff run failed unexpectedly: ${rendered.detail}`, "error");
			return undefined;
		}

		return rendered.value;
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

		// A pending review is reopened rather than drafted over. Drafting would be refused
		// by the machine anyway, and Gate B already carries Discard and Accept, so there is
		// nothing to ask the user first.
		if (machine.reviewing() !== undefined) {
			const pending = await gateBFlow.viewFromPendingReview(ctx);
			if (pending !== undefined) {
				await gateBFlow.run(ctx, pending);
				return;
			}
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
			const runnable = isChoiceRunnable(ctx, view.choice);
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

				const outcome = await runWorker(ctx, view, choice);
				if (outcome === undefined) return;

				const gateB = gateBFlow.viewFromOutcome(
					{ slug: view.draft.slug, choice, promptPath: view.promptPath },
					outcome,
				);
				if (gateB === undefined) {
					// The run never started; Gate A stays open so the user can fix the cause.
					reportRunRefusal(ctx, outcome);
					if (outcome.kind === "refused") return;
					continue;
				}

				await gateBFlow.run(ctx, gateB);
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
