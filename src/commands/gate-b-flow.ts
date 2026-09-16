/**
 * The Gate B loop, shared by `/handoff` and the `agent_end` reopen.
 *
 * Gate B is reached three ways — a run finishing, `/handoff` while a review is
 * pending, and `agent_end` after a Review here turn — and all three must offer the
 * same options with the same guarantees. Keeping the loop here means the third
 * path cannot drift from the first, which matters because the reopen runs from a
 * lifecycle hook where a mistake fires UI in sessions that have no handoff.
 *
 * The hook body is the delicate part. It reads the arm flag, clears it *before*
 * opening anything, and returns early in every other case. Clearing first is what
 * makes a second `agent_end` inert: `_runAgentPrompt` can loop on auto-retry, so
 * more than one event per prompt is normal, and a flag cleared only after the gate
 * closed would let the second event open a second gate behind the first.
 *
 * Review here fires `pi.sendUserMessage` without awaiting anything. The injected
 * message triggers a full agent turn, and the handler must return so that turn can
 * run at all — the gate it is arming is reopened by the turn's own `agent_end`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HandoffMachine } from "../app/handoff-machine.ts";
import type { ReviewService } from "../app/review-service.ts";
import type { RunOutcome, RunService } from "../app/run-service.ts";
import { normalizeReviewFeedback } from "../domain/draft/feedback.ts";
import { formatModelChoice } from "../domain/draft/launch.ts";
import { formatDiscardHeadline, formatDiscardSummary } from "../domain/report/discard.ts";
import { buildPromptPath } from "../domain/draft/slug.ts";
import type { ModelChoice } from "../domain/types.ts";
import type { Clock } from "../ports/clock.ts";
import { openAcknowledgement, openGateB, type GateBView } from "../presentation/gate-b.ts";
import { describeGitFailure, describeGitOrConflict } from "../presentation/git-failure.ts";
import { confirmDiscardMenu, selectOption } from "../presentation/menus.ts";
import { runWithWidget } from "../presentation/running-widget.ts";
import { HANDOFF_COMMAND } from "./parse.ts";

export interface GateBFlowDeps {
	machine: HandoffMachine;
	runService: RunService;
	reviewService: ReviewService;
	clock: Clock;
	/** Re-checked before any spawn, so a vanished provider is caught at the click. */
	isChoiceRunnable: (ctx: ExtensionContext, choice: ModelChoice | undefined) => boolean;
	/**
	 * Injects the review message into the reviewing session.
	 *
	 * Passed in rather than taken from `pi` directly so this module stays free of
	 * adapter and extension-API imports, and so tests can observe the injection.
	 */
	sendUserMessage: (content: string) => void;
}

export interface GateBFlow {
	/** Builds Gate B's view from a run outcome, or nothing if the run never started. */
	viewFromOutcome(
		base: { slug: string; choice: ModelChoice; promptPath: string },
		outcome: RunOutcome,
	): GateBView | undefined;
	/** Builds Gate B's view from the pending review the machine already holds. */
	viewFromPendingReview(ctx: ExtensionContext): Promise<GateBView | undefined>;
	/** Keeps Gate B open until the user accepts, discards, reviews, or defers. */
	run(ctx: ExtensionContext, view: GateBView): Promise<void>;
	/** The `agent_end` body: captures the review and reopens Gate B exactly once. */
	handleAgentEnd(ctx: ExtensionContext, reviewText?: string): Promise<void>;
}

/** Wires Gate B's surfaces to the machine and the two session-scoped services. */
export function createGateBFlow(deps: GateBFlowDeps): GateBFlow {
	const { machine, runService, reviewService, clock, isChoiceRunnable, sendUserMessage } = deps;

	/** Discards the worker's changes, always reporting which paths were left alone. */
	async function discardChanges(ctx: ExtensionContext): Promise<boolean> {
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

	const flow: GateBFlow = {
		viewFromOutcome(
			base: { slug: string; choice: ModelChoice; promptPath: string },
			outcome: RunOutcome,
		): GateBView | undefined {
			// Read after the transition so the label reflects the iteration just finished.
			const allowance = reviewService.feedbackAllowance();
			const feedback = allowance === undefined ? {} : { feedback: allowance };

			if (outcome.kind === "completed") {
				return {
					...base,
					...feedback,
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
					...feedback,
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
		},

		async viewFromPendingReview(ctx: ExtensionContext): Promise<GateBView | undefined> {
			const reviewing = machine.reviewing();
			if (reviewing === undefined) return undefined;

			const allowance = reviewService.feedbackAllowance();
			const review = reviewing.review?.iteration === reviewing.iteration ? reviewing.review : undefined;
			const base = {
				slug: reviewing.draft.slug,
				choice: reviewing.choice,
				promptPath: buildPromptPath(reviewing.draft.slug),
				iteration: reviewing.iteration,
				...(review === undefined ? {} : { review }),
				...(allowance === undefined ? {} : { feedback: allowance }),
			};

			if (reviewing.completion === "completed") {
				return {
					...base,
					report: reviewing.report,
					diffstat: reviewing.diffstat,
					diffstatFailure: undefined,
					usage: reviewing.usage,
					interruptionNote: undefined,
				};
			}

			// An interrupted state stores no diffstat, so it is read live against the checkpoint.
			const diffstat = await runService.diffstat(ctx.cwd);
			return {
				...base,
				report: null,
				diffstat: diffstat.ok ? diffstat.value : "",
				diffstatFailure: diffstat.ok ? undefined : describeGitOrConflict(diffstat.error),
				usage: null,
				interruptionNote: reviewing.interruptionNote,
			};
		},

		async run(ctx: ExtensionContext, view: GateBView): Promise<void> {
			let current = view;

			for (;;) {
				const selected = await openGateB(ctx, current);

				if (selected === undefined || selected === "dismiss") {
					ctx.ui.notify(
						`Review left pending. The worker's changes are still in the working tree, and \`${HANDOFF_COMMAND}\` reopens this review.`,
						"info",
					);
					return;
				}

				if (selected === "accept") {
					const accepted = reviewService.accept();
					if (!accepted.ok) {
						ctx.ui.notify(accepted.error.message, "warning");
						return;
					}
					ctx.ui.notify("Handoff accepted. The working tree is unchanged and nothing was committed.", "info");
					return;
				}

				if (selected === "discard") {
					const discarded = await discardChanges(ctx);
					if (discarded) return;
					continue;
				}

				if (selected === "review") {
					const armed = reviewService.beginReview();
					if (!armed.ok) {
						ctx.ui.notify(armed.error.message, "warning");
						continue;
					}

					// Deliberately not awaited: the message starts an agent turn, and this
					// handler has to return for that turn to run. `agent_end` reopens the gate.
					sendUserMessage(reviewService.buildReviewMessage(armed.value));
					return;
				}

				// Send feedback to worker: bounded, then a full iteration behind the widget.
				const allowance = reviewService.feedbackAllowance();
				if (allowance !== undefined && !allowance.allowed) {
					ctx.ui.notify(
						`Iteration ${allowance.iteration} is the last of ${allowance.maxIterations}, so no more feedback can be sent. Accept or discard.`,
						"warning",
					);
					continue;
				}

				const feedback = await ctx.ui.editor(
					"Review feedback",
					current.review === undefined ? "" : normalizeReviewFeedback(current.review.text),
				);
				if (feedback === undefined) continue;
				const normalizedFeedback = normalizeReviewFeedback(feedback);
				if (normalizedFeedback === "") {
					ctx.ui.notify("No feedback to send: the editor contained only a verdict line.", "warning");
					continue;
				}

				const rendered = await runWithWidget(
					ctx,
					{ slug: current.slug, choice: current.choice, promptPath: current.promptPath },
					{ nowMs: () => clock.nowMs(), onAbort: () => runService.abortActiveRun() },
					(onProgress) =>
						reviewService.sendFeedback({
							feedback: normalizedFeedback,
							cwd: ctx.cwd,
							onProgress,
							isChoiceRunnable: (choice) => isChoiceRunnable(ctx, choice),
						}),
				);

				if (rendered.kind === "failed") {
					ctx.ui.notify(`The feedback run failed unexpectedly: ${rendered.detail}`, "error");
					return;
				}

				const sent = rendered.value;
				if (!sent.ok) {
					switch (sent.error.kind) {
						case "bound_reached":
							ctx.ui.notify(
								`Iteration ${sent.error.iteration} is the last of ${sent.error.maxIterations}, so no more feedback can be sent.`,
								"warning",
							);
							continue;
						case "empty_feedback":
							continue;
						case "write_failed":
							ctx.ui.notify(
								`The feedback was not sent because ${sent.error.failure.path} could not be rewritten: ${sent.error.failure.detail}`,
								"error",
							);
							continue;
						case "conflict":
							ctx.ui.notify(sent.error.conflict.message, "warning");
							return;
					}
				}

				const next = flow.viewFromOutcome(
					{ slug: current.slug, choice: current.choice, promptPath: current.promptPath },
					sent.value,
				);
				if (next === undefined) {
					// The iteration never started; the pending review is still what it was.
					if (sent.value.kind === "model_unavailable") {
						ctx.ui.notify(
							`${formatModelChoice(sent.value.choice)} is no longer available, so no new iteration was started`,
							"error",
						);
					} else if (sent.value.kind === "refused") {
						ctx.ui.notify(sent.value.conflict.message, "warning");
						return;
					} else if (sent.value.kind === "checkpoint_failed") {
						ctx.ui.notify(`No new iteration was started. ${describeGitFailure(sent.value.failure)}`, "error");
					}
					continue;
				}

				current = next;
			}
		},

		async handleAgentEnd(ctx: ExtensionContext, reviewText?: string): Promise<void> {
			// The arm flag is the sole condition under which this hook does anything.
			if (machine.reviewing()?.awaitingReviewTurn !== true) return;

			// Cleared before the gate opens, so a second agent_end for the same prompt
			// finds the flag already down and does nothing.
			const cleared = reviewService.clearReview(reviewText);
			if (!cleared.ok) return;

			// A gate is a TUI overlay; there is nothing to open elsewhere.
			if (ctx.mode !== "tui") return;

			const view = await flow.viewFromPendingReview(ctx);
			if (view === undefined) return;
			await flow.run(ctx, view);
		},
	};

	return flow;
}
