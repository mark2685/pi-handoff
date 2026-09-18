/**
 * `/handoff` dispatch: drafting, Gate A, and the escape hatches.
 *
 * The drafting flow and Gate A are extracted as `runDraftingFlow` and `runGateA`
 * rather than inlined in the handler, because two entry points need them: the
 * command itself, and Gate B's "Accept and hand off leftovers", which drafts a
 * follow-up from an accepting review. A follow-up that skipped either would be a
 * second, less guarded way to reach a worker.
 *
 * `runGateA` is a loop because Edit prompt, Change model, and View full prompt
 * change what the gate shows without deciding anything, so each must re-render it.
 * Every branch that ends the handoff routes through the service so the machine and
 * its session entries stay consistent.
 *
 * A `needs_input` outcome opens its own gate, nested inside the drafting loop,
 * instead of dumping the whole drafted prompt into the editor: Answer folds the
 * user's response into the accumulated scope and re-enters drafting, so a
 * re-draft that again needs input loops rather than dead-ends; Edit finishes the
 * retained draft in place once the marker is gone. `continueWithPrompt` on the
 * service is the only path from that draft to Gate A, so this gate can never be
 * bypassed by construction.
 *
 * Gate B's own loop lives in `gate-b-flow.ts`, because the `agent_end` reopen and
 * `/handoff` while a review is pending both need it and neither goes through
 * drafting.
 *
 * Four guards are deliberate. Non-interactive modes never open a gate, so
 * `/handoff status` keeps working headlessly while drafting refuses cleanly. Run
 * re-checks the chosen model against the live registry at the moment of the click,
 * not just when the tier resolved, because a provider can disappear while the gate
 * sits open. A pending review short-circuits before drafting: the machine would
 * refuse a new draft anyway, so reopening the gate the user already has is the only
 * useful thing `/handoff` can do there. And an external run short-circuits earlier
 * still, into the gate that brings its result back — that run holds a checkpoint and
 * a tree the user has been editing elsewhere, so drafting over it would strand both.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DraftOutcome, DraftReady, DraftService } from "../app/draft-service.ts";
import type { HandoffMachine } from "../app/handoff-machine.ts";
import type { RunOutcome, RunService } from "../app/run-service.ts";
import { buildLaunchCommand, formatModelChoice } from "../domain/draft/launch.ts";
import { buildLeftoversScope, type LeftoversScopeInput } from "../domain/draft/leftovers.ts";
import { buildPromptPath } from "../domain/draft/slug.ts";
import { resolveModelOverride } from "../domain/rubric/resolve.ts";
import type { ModelChoice } from "../domain/types.ts";
import type { Clock } from "../ports/clock.ts";
import type { Clipboard } from "../ports/clipboard.ts";
import { withLoader } from "../presentation/drafting-loader.ts";
import { openGateA } from "../presentation/gate-a.ts";
import { describeGitFailure } from "../presentation/git-failure.ts";
import { externalRunMenu, selectOption, unparseableMenu } from "../presentation/menus.ts";
import { pickModel } from "../presentation/model-picker.ts";
import { runWithWidget } from "../presentation/running-widget.ts";
import { openTextViewer } from "../presentation/text-viewer.ts";
import type { GateBFlow } from "./gate-b-flow.ts";
import { runNeedsInputFlow } from "./needs-input-flow.ts";
import { HANDOFF_COMMAND, parseHandoffCommand } from "./parse.ts";
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

/** The `/handoff` handler, plus the entry points other surfaces need to reuse it. */
export interface HandoffCommand {
	/** The registered `/handoff` handler. */
	handle: (args: string, ctx: ExtensionContext) => Promise<void>;
	/**
	 * Drafts the follow-up handoff for an accepting review's leftover items.
	 *
	 * Exposed so Gate B's "Accept and hand off leftovers" reaches the same drafting,
	 * NEEDS INPUT, and Gate A path as `/handoff` itself, rather than a parallel one.
	 */
	draftLeftovers: (ctx: ExtensionContext, input: LeftoversScopeInput) => Promise<void>;
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
		case "no_leftovers":
		case "needs_input":
		case "ready":
		case "unparseable":
			return;
	}
}

/** Copies the launch command, falling back to showing it when no clipboard exists. */
async function copyLaunchCommand(ctx: ExtensionContext, clipboard: Clipboard, view: DraftReady): Promise<boolean> {
	if (view.choice === undefined) {
		ctx.ui.notify("Choose a model before copying the launch command", "warning");
		return false;
	}

	const command = buildLaunchCommand(view.choice, view.promptPath);
	const copied = await clipboard.copy(command);
	if (copied.ok) {
		ctx.ui.notify(`Launch command copied to the clipboard:\n${command}`, "info");
		return true;
	}

	// The clipboard is optional; the command itself is the feature.
	ctx.ui.notify(`Clipboard unavailable (${copied.error.detail}). Run this command:\n${command}`, "warning");
	return true;
}

/** Creates the `/handoff` handler and its reusable drafting entry point. */
export function createHandoffCommandHandler(deps: HandoffCommandDeps): HandoffCommand {
	const { machine, createService, runService, gateBFlow, isChoiceRunnable, clipboard, clock } = deps;

	/**
	 * Runs the drafting-to-Gate-A flow for an already-built service and initial scope.
	 *
	 * Extracted from the command body so "Accept and hand off leftovers" reaches the
	 * identical path: the same retry loop, the same NEEDS INPUT gate, and the same
	 * Gate A. A follow-up handoff that bypassed any of that would be a second, less
	 * guarded way to start a worker.
	 *
	 * The two sources differ in exactly one way, and it holds for the whole loop rather
	 * than for the first pass: a leftovers draft's scope is the accepted prompt plus the
	 * review text, and its drafting call sends no transcript. Both continuation paths —
	 * Retry after an unparseable envelope, and a re-draft after answered questions —
	 * re-enter through the same call, because a retry that fell back to the ordinary
	 * path would re-serialize the conversation and, worse, hand the model an
	 * accumulated scope with the accepted prompt and review dropped out of it.
	 */
	async function runDraftingFlow(
		ctx: ExtensionContext,
		service: DraftService,
		initial: { scope: string; modelOverride?: ModelChoice } | { leftovers: LeftoversScopeInput },
	): Promise<void> {
		let view: DraftReady | undefined;
		const leftovers = "leftovers" in initial;
		const modelOverride = leftovers ? undefined : initial.modelOverride;
		// Seeded, not accumulated later: every re-draft below passes this scope back, so
		// the leftovers documents have to be in it from the first pass onwards.
		let scope = leftovers ? buildLeftoversScope(initial.leftovers) : initial.scope;

		while (view === undefined) {
			// Drafting is bound to the reviewing session's current model, not Gate A's
			// worker choice. It is available here at the loader call site, so name it while
			// the potentially long side-call is in progress.
			const draftingModel = ctx.model === undefined ? undefined : `${ctx.model.provider}/${ctx.model.id}`;
			const drafted = await withLoader(
				ctx,
				"Drafting handoff…",
				(signal) => (leftovers ? service.draftLeftovers(scope, signal) : service.draft(scope, signal, modelOverride)),
				draftingModel,
			);

			if (drafted.kind === "aborted") {
				// `abandon` is idempotent, so this is safe even though the abandoned drafting call
				// also abandons when it settles; see the note on DraftService.abandon.
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

			if (outcome.value.kind === "no_leftovers") {
				ctx.ui.notify(
					`The review flagged no remaining items — nothing to hand off. ${outcome.value.rationale}`,
					"info",
				);
				return;
			}

			if (outcome.value.kind === "needs_input") {
				const flowResult = await runNeedsInputFlow(ctx, service, outcome.value, scope);
				if (flowResult.kind === "cancelled") return;
				if (flowResult.kind === "rescoped") {
					scope = flowResult.scope;
					continue;
				}
				view = flowResult.view;
				continue;
			}

			if (outcome.value.kind !== "ready") {
				reportTerminalOutcome(ctx, outcome.value);
				return;
			}

			view = outcome.value;
		}

		await runGateA(ctx, service, view, leftovers ? initial.leftovers.slug : undefined);
	}

	/**
	 * Keeps Gate A open across Edit prompt, Change model, and View full prompt.
	 *
	 * A loop rather than a chain of returns because those three options change what
	 * the gate shows without deciding anything, so each has to re-render it.
	 */
	async function runGateA(
		ctx: ExtensionContext,
		service: DraftService,
		ready: DraftReady,
		leftoversOf?: string,
	): Promise<void> {
		let view = ready;

		for (;;) {
			const runnable = isChoiceRunnable(ctx, view.choice);
			const selected = await openGateA(ctx, {
				...view,
				runnable,
				...(leftoversOf === undefined ? {} : { leftovers: { acceptedSlug: leftoversOf } }),
			});

			if (selected === undefined || selected === "cancel") {
				// Cancel leaves the /tmp prompt in place by design.
				service.abandon();
				ctx.ui.notify(`Handoff cancelled. Prompt left at ${view.promptPath}`, "info");
				return;
			}

			if (selected === "run" || selected === "run_and_review") {
				const choice = view.choice;
				if (!runnable || choice === undefined) {
					ctx.ui.notify("Run is blocked until an available model is chosen", "warning");
					continue;
				}

				// The only difference between the two options: whether a completed run injects
				// the review turn itself. Everything up to that point is identical, so Run's
				// behaviour is unchanged.
				const autoReview = selected === "run_and_review";
				const base = { slug: view.draft.slug, choice, promptPath: view.promptPath };
				const outcome = await runWorker(ctx, view, choice, autoReview);
				if (outcome === undefined) return;

				const settled = await settleRun(ctx, base, outcome, autoReview);
				if (settled === "settled") return;

				// The run never started. Gate A stays open so the user can fix the cause, unless
				// the machine refused the transition, which no amount of retrying at this gate
				// will change.
				if (outcome.kind === "refused") return;
				continue;
			}

			if (selected === "view") {
				// The gate previews twelve lines of prompts that run to well over a hundred;
				// this is the surface that shows the rest without displacing the options.
				await openTextViewer(ctx, `Handoff prompt — ${view.draft.slug} (read-only)`, view.draft.prompt);
				continue;
			}

			if (selected === "external") {
				const copied = await copyLaunchCommand(ctx, clipboard, view);
				if (!copied) continue;

				// Checkpointed and recorded rather than abandoned to idle. Without this the
				// extension forgot the handoff entirely, so the user's own worker edited a tree
				// with no boundary and its result came back as a pasted message with no diffstat
				// and no Discard.
				const started = await runService.startExternal({ cwd: ctx.cwd });
				if (started.kind !== "external_started") {
					if (started.kind === "checkpoint_failed") {
						ctx.ui.notify(
							`The command was copied, but no checkpoint could be taken, so Discard will not be available. ${describeGitFailure(started.failure)}`,
							"warning",
						);
					} else {
						ctx.ui.notify(started.conflict.message, "warning");
					}
					service.abandon();
					return;
				}

				ctx.ui.notify(
					`Checkpoint taken. Run the copied command, then \`${HANDOFF_COMMAND}\` to review the result here.`,
					"info",
				);
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
	}

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
		autoReview: boolean,
	): Promise<RunOutcome | undefined> {
		const rendered = await runWithWidget<RunOutcome>(
			ctx,
			{
				slug: view.draft.slug,
				choice,
				promptPath: view.promptPath,
				...(view.draft.bluf === undefined ? {} : { bluf: view.draft.bluf }),
				...(view.draft.definitionOfDone === undefined ? {} : { definitionOfDone: view.draft.definitionOfDone }),
			},
			{ nowMs: () => clock.nowMs(), onAbort: () => runService.abortActiveRun() },
			(onProgress) =>
				runService.start({
					promptPath: view.promptPath,
					cwd: ctx.cwd,
					onProgress,
					isChoiceRunnable: (candidate) => isChoiceRunnable(ctx, candidate),
					...(autoReview ? { autoReview: true } : {}),
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

	/**
	 * Sends a finished run to Gate B, or straight into the review turn.
	 *
	 * `autoReview` is honoured only for a completed run. An interrupted one has no
	 * report to review, and injecting a review turn for it would spend reviewing
	 * context on a crash the user has not yet seen — Gate B, which explains what
	 * happened and offers Discard, is the right surface for that.
	 */
	async function settleRun(
		ctx: ExtensionContext,
		base: { slug: string; choice: ModelChoice; promptPath: string },
		outcome: RunOutcome,
		autoReview: boolean,
	): Promise<"settled" | "never_started"> {
		const gateB = gateBFlow.viewFromOutcome(base, outcome);
		if (gateB === undefined) {
			// The run never started, so there is nothing to review; the caller decides whether
			// to reopen Gate A or give up, since only it knows which surface it came from.
			reportRunRefusal(ctx, outcome);
			return "never_started";
		}

		if (autoReview && outcome.kind === "completed" && gateBFlow.startReviewTurn(ctx)) return "settled";

		await gateBFlow.run(ctx, gateB);
		return "settled";
	}

	/**
	 * Runs the external-run gate until the user reviews, discards, or defers.
	 *
	 * Reached from `/handoff` while an external run is recorded. Discard is offered
	 * here as well as at Gate B, because a user who abandons a run in the other
	 * terminal has changes to undo and no report coming.
	 */
	async function runExternalGate(ctx: ExtensionContext): Promise<void> {
		for (;;) {
			const running = machine.running();
			if (running === undefined || running.external !== true) return;

			const selected = await selectOption(
				(title, options) => ctx.ui.select(title, options),
				`\`${running.draft.slug}\` is running in another terminal`,
				externalRunMenu(),
			);

			if (selected === undefined || selected === "cancel") {
				ctx.ui.notify(
					`Still waiting on the external run. \`${HANDOFF_COMMAND}\` reopens this when it finishes.`,
					"info",
				);
				return;
			}

			if (selected === "discard") {
				await discardExternalRun(ctx);
				return;
			}

			// An empty report is allowed: the report lives in another terminal's scrollback,
			// and requiring a paste would block review on a copy the user may not have kept.
			const report = await ctx.ui.editor("Paste the worker's report (optional — submit empty to skip)", "");
			if (report === undefined) continue;

			const outcome = await runService.completeExternal({ cwd: ctx.cwd, report });
			// Returns either way: a refusal has already been reported, and looping would ask
			// the user to paste the same report again.
			await settleRun(
				ctx,
				{ slug: running.draft.slug, choice: running.choice, promptPath: buildPromptPath(running.draft.slug) },
				outcome,
				false,
			);
			return;
		}
	}

	/** Reverts an abandoned external run to its checkpoint, reporting what was left alone. */
	async function discardExternalRun(ctx: ExtensionContext): Promise<void> {
		const discarded = await runService.discard(ctx.cwd);
		if (!discarded.ok) {
			const message =
				discarded.error.kind === "conflict"
					? discarded.error.message
					: `Nothing was discarded. ${describeGitFailure(discarded.error)}`;
			ctx.ui.notify(message, "error");
			return;
		}
		ctx.ui.notify(
			`Discarded the external run's changes. ${discarded.value.skippedPaths.length} path(s) already dirty at checkpoint were left alone.`,
			discarded.value.skippedPaths.length > 0 ? "warning" : "info",
		);
	}

	return {
		handle: async function handleHandoffCommand(args: string, ctx: ExtensionContext): Promise<void> {
			const command = parseHandoffCommand(args);

			if (command.kind === "status") {
				ctx.ui.notify(formatHandoffStatus(machine.current()), "info");
				return;
			}

			if (command.kind === "usage") {
				ctx.ui.notify(command.message, "warning");
				return;
			}

			if (command.kind === "unimplemented") {
				ctx.ui.notify(`${HANDOFF_COMMAND} ${command.name} is not implemented yet`, "info");
				return;
			}

			// Drafting needs a gate, an editor, and a model; none of that exists headlessly.
			if (ctx.mode !== "tui") {
				ctx.ui.notify(`${HANDOFF_COMMAND} requires interactive mode; use ${HANDOFF_COMMAND} status elsewhere`, "error");
				return;
			}

			// An external run is in flight, so the only useful thing to offer is the gate that
			// brings its result back. Checked before the pending-review branch because both are
			// "a handoff already exists", and this one is the earlier phase.
			const active = machine.running();
			if (active !== undefined && active.external === true) {
				if (command.scope !== "") {
					ctx.ui.notify(
						"A handoff is already running in another terminal; the supplied scope was not used. Finish or discard it first.",
						"warning",
					);
				}
				await runExternalGate(ctx);
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

			const modelOverride =
				command.modelOverride === undefined
					? undefined
					: resolveModelOverride(
							command.modelOverride,
							ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id })),
						);
			if (command.modelOverride !== undefined && modelOverride === undefined) {
				ctx.ui.notify(
					`Model override \"${command.modelOverride}\" is unavailable or invalid; choose a model from the live registry.`,
					"warning",
				);
				return;
			}

			const service = createService(ctx);
			if (service === undefined) {
				ctx.ui.notify("No model is selected, so a handoff cannot be drafted", "error");
				return;
			}

			let scope = command.scope;

			// A persisted pending envelope is the one drafting state safe to resume: it has
			// its prompt and exact questions, while an old bare drafting state remains idle.
			const drafting = machine.current();
			if (drafting.kind === "drafting" && drafting.pendingDraft !== undefined) {
				const ignored = [
					...(command.scope === "" ? [] : ["the supplied scope"]),
					...(command.modelOverride === undefined ? [] : [`the --model override \"${command.modelOverride}\"`]),
				];
				if (ignored.length > 0) {
					ctx.ui.notify(
						`Pending NEEDS INPUT questions are being reopened; ${ignored.join(" and ")} ${ignored.length === 1 ? "was" : "were"} not used. Cancel on the gate, then re-run the command to start fresh with it.`,
						"warning",
					);
				}
				const resumed = await runNeedsInputFlow(
					ctx,
					service,
					{ kind: "needs_input", ...drafting.pendingDraft },
					drafting.scope,
				);
				if (resumed.kind === "cancelled") return;
				if (resumed.kind === "rescoped") scope = resumed.scope;
				if (resumed.kind === "ready") {
					await runGateA(ctx, service, resumed.view);
					return;
				}
			}

			await runDraftingFlow(ctx, service, modelOverride === undefined ? { scope } : { scope, modelOverride });
		},

		async draftLeftovers(ctx: ExtensionContext, input: LeftoversScopeInput): Promise<void> {
			// A gate is a TUI overlay, and drafting needs one; there is nothing to open elsewhere.
			if (ctx.mode !== "tui") return;

			const service = createService(ctx);
			if (service === undefined) {
				ctx.ui.notify("No model is selected, so the follow-up handoff could not be drafted", "error");
				return;
			}

			await runDraftingFlow(ctx, service, { leftovers: input });
		},
	};
}
