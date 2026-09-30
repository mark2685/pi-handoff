/**
 * The Gate B loop, shared by `/handoff` and the review-turn reopen.
 *
 * Gate B is reached three ways — a run finishing, `/handoff` while a review is
 * pending, and the end of a Review here turn — and all three must offer the same
 * options with the same guarantees. Keeping the loop here means the third path
 * cannot drift from the first, which matters because the reopen runs from a
 * lifecycle hook where a mistake fires UI in sessions that have no handoff.
 *
 * The reopen is deliberately split across two hooks, and the split is the delicate
 * part.
 *
 * `agent_end` only *captures* the review, because Pi awaits extension `agent_end`
 * handlers before its own interactive listener runs, and that listener is what
 * clears the `Working` spinner. A handler that held the gate open would therefore
 * leave Pi claiming to be working underneath it, and alongside the running
 * overlay of any worker the gate started. The capture is overwritten on every
 * event, since `_runAgentPrompt` loops on auto-retry and more than one `agent_end`
 * per prompt is normal — the last one is the review.
 *
 * `agent_settled` reopens the gate, and does it *without being awaited*. Pi emits
 * that event once the run has fully settled, with the session already reporting
 * not-streaming and idle, so a gate opened from there runs while nothing claims to
 * be working. Pi awaits extension handlers there too, so the loop is launched
 * detached: the handler returns immediately and the launch reports its own
 * failures, because a rejection nobody awaits would otherwise be unhandled.
 * Clearing the capture before the first `await` is what keeps a second settle for
 * the same turn from stacking a second gate behind the first.
 *
 * Review here fires `pi.sendUserMessage` without awaiting anything. The injected
 * message triggers a full agent turn, and the caller must return so that turn can
 * run at all — the gate it is arming is reopened after that turn settles.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HandoffMachine } from "../app/handoff-machine.ts";
import type { ReviewService } from "../app/review-service.ts";
import type { RunOutcome, RunService } from "../app/run-service.ts";
import { normalizeReviewFeedback } from "../domain/draft/feedback.ts";
import { formatModelChoice } from "../domain/draft/launch.ts";
import { formatDiscardHeadline, formatDiscardSummary } from "../domain/report/discard.ts";
import { buildPromptPath } from "../domain/draft/slug.ts";
import type { LeftoversScopeInput } from "../domain/draft/leftovers.ts";
import { hasReviewEvidence, parseReviewLeftovers } from "../domain/review.ts";
import type { ModelChoice } from "../domain/types.ts";
import type { Clock } from "../ports/clock.ts";
import {
	buildFeedbackEditorRequest,
	feedbackDraftAdvice,
	openAcknowledgement,
	openGateB,
	type GateBView,
} from "../presentation/gate-b.ts";
import { describeGitFailure, describeGitOrConflict } from "../presentation/git-failure.ts";
import { confirmDiscardMenu, reviewOptionLabel, selectOption, type ReviewOptionLabel } from "../presentation/menus.ts";
import { runWithWidget } from "../presentation/running-widget.ts";
import { openTextViewer } from "../presentation/text-viewer.ts";
import { HANDOFF_COMMAND } from "./parse.ts";
import type { ReviewTurnOutcome } from "./review-turn.ts";

/**
 * Names a failed review turn, and what is still available afterwards.
 *
 * The reviewer model can fail for reasons the reviewing user has to act on — a 402
 * budget error is the observed one — and the failure used to be invisible: the gate
 * reopened with an empty review recorded, as though the diff had been read.
 */
export function formatReviewTurnFailure(errorMessage: string | undefined, reviewLabel: ReviewOptionLabel): string {
	const detail =
		errorMessage === undefined || errorMessage.trim() === "" ? "the model reported an error" : errorMessage;
	return `Review turn failed: ${detail}\nNo review was recorded. Choose "${reviewLabel}" to run it again.`;
}

/**
 * Names why an armed review turn recorded nothing, or undefined when it did record one.
 *
 * The option to name is passed in because it is not always "Review here": a Review again
 * turn that fails keeps the earlier review, so the reopened gate still offers
 * "Review again", and a notice pointing at an option that is not on screen is the dead end
 * `feedbackDraftAdvice` in gate-b.ts already guards against.
 */
export function describeUnrecordedReviewTurn(
	captured: ReviewTurnOutcome,
	reviewLabel: ReviewOptionLabel,
): { message: string; level: "error" | "warning" | "info" } | undefined {
	switch (captured.kind) {
		case "review":
			return undefined;
		case "failed":
			return { message: formatReviewTurnFailure(captured.errorMessage, reviewLabel), level: "error" };
		case "stopped":
			return {
				message: `The review turn was stopped before it finished, so no review was recorded. Choose "${reviewLabel}" to run it again.`,
				level: "info",
			};
		case "empty":
			return {
				message: `The review turn produced no review, so nothing was recorded. Choose "${reviewLabel}" to run it again.`,
				level: "warning",
			};
	}
}

/**
 * Describes a failure inside the detached Gate B reopen.
 *
 * The failure can land anywhere in the loop, not just at the first render: Accept
 * and hand off leftovers resets the machine before its draft runs, and Discard
 * resets it before its acknowledgement. Promising that `/handoff` reopens the
 * review is only true while one is still pending, so the recovery line follows
 * the machine rather than the failure site.
 *
 * The stack goes into the message because nothing else will carry it. When the
 * reopen ran inside `agent_end`, Pi caught the rejection and printed its stack
 * in the chat; a detached promise has no such handler, and `console.error` would
 * write over the TUI rather than into it.
 */
export function formatReopenFailure(error: unknown, reviewPending: boolean): string {
	const detail = error instanceof Error ? error.message : String(error);
	const recovery = reviewPending
		? `The review is still pending; run \`${HANDOFF_COMMAND}\` to reopen Gate B.`
		: `Run \`${HANDOFF_COMMAND} status\` to see where the handoff stands.`;
	// Pi's own extension-error display drops the first stack line for the same reason:
	// it repeats the message already shown above it.
	const stack =
		error instanceof Error && error.stack !== undefined
			? error.stack
					.split("\n")
					.slice(1)
					.map((line) => `  ${line.trim()}`)
					.join("\n")
			: "";
	return `Gate B stopped with an error: ${detail}\n${recovery}${stack === "" ? "" : `\n${stack}`}`;
}

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
	/**
	 * Starts the follow-up handoff for an accepting review's leftover items.
	 *
	 * Injected as a callback because drafting needs a service built from the live
	 * context, which this session-scoped flow has no way to construct — the same
	 * reason `createService` is passed into the command handler.
	 */
	draftLeftovers?: (ctx: ExtensionContext, input: LeftoversScopeInput) => Promise<void>;
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
	/**
	 * Injects the review turn directly, as Review here does, without opening Gate B.
	 *
	 * This is "Run and review": the same arming, the same message, and the same
	 * post-settle reopen, reached without the intervening click. Returns false when
	 * the machine refused to arm, so the caller can fall back to the gate.
	 */
	startReviewTurn(ctx: ExtensionContext): boolean;
	/**
	 * The `agent_end` body: records the armed review turn's result, opening nothing.
	 *
	 * Synchronous and inert in every other case, so an ordinary turn in a session with
	 * no handoff costs a single flag read. Takes the classified outcome rather than bare
	 * text so a turn that ended on a provider error cannot be stored as a review whose
	 * findings happen to be empty.
	 */
	captureReviewTurn(outcome: ReviewTurnOutcome): void;
	/**
	 * The `agent_settled` body: reopens Gate B once for a captured review turn.
	 *
	 * Returns as soon as the loop is launched rather than when the gate closes, so
	 * neither review-turn hook waits on a gate, a worker run, or a leftovers draft.
	 */
	reopenAfterReviewTurn(ctx: ExtensionContext): void;
	/**
	 * Resolves once a launched reopen has finished, rejecting never.
	 *
	 * The seam for observing detached work whose handler has already returned; the
	 * loop itself reports its outcome to the user.
	 */
	whenReopenSettled(): Promise<void>;
	/**
	 * Drops a capture that will never be reopened, on session replacement or shutdown.
	 *
	 * Without it a review captured in one session could reopen a gate in the next one,
	 * against a handoff that session never had.
	 */
	forgetReviewTurn(): void;
}

/** Wires Gate B's surfaces to the machine and the two session-scoped services. */
export function createGateBFlow(deps: GateBFlowDeps): GateBFlow {
	const { machine, runService, reviewService, clock, isChoiceRunnable, sendUserMessage, draftLeftovers } = deps;

	/**
	 * The armed review turn's result, held between `agent_end` and the turn's settle.
	 *
	 * A classified outcome rather than a bare string: a review turn that produced no
	 * assistant text, and one that died on a provider error, both still have to reopen
	 * the gate, so "no review" and "nothing captured" must stay distinguishable — and a
	 * failure has to keep the reason it failed.
	 */
	let capture: ReviewTurnOutcome | undefined;

	/** The detached reopen in flight, if any, so `whenReopenSettled` can await it. */
	let reopen: Promise<void> | undefined;

	/**
	 * Persists the captured review and reopens Gate B, reporting its own failures.
	 *
	 * Nothing awaits this from Pi's side, so an escaping error would be an unhandled
	 * rejection with no user-visible trace. The catch covers the whole loop, including
	 * the runs, drafts, and dialogs the gate starts, so the report is worded from the
	 * machine's state afterwards rather than assuming the gate never opened.
	 */
	async function reopenGateB(ctx: ExtensionContext, captured: ReviewTurnOutcome): Promise<void> {
		try {
			// Re-read rather than trusted: the session can be replaced between the capture and
			// the settle, and a stale capture must not reopen a gate against another handoff.
			if (machine.reviewing()?.awaitingReviewTurn !== true) return;

			// Disarms the turn and persists its verdict and findings, so a dismissed gate
			// leaves the review pending rather than armed. A turn that failed or said nothing
			// records no review at all: Gate B's labels, its action order, and the feedback
			// editor all read the presence of a review as "this iteration was reviewed", and a
			// 402 on the reviewer model is not a review.
			const cleared = reviewService.clearReview(captured.kind === "review" ? captured.text : undefined);
			if (!cleared.ok) return;

			// Reported before the TUI check, because a headless session still deserves to know
			// its review never happened. The label is read from the state just persisted, with
			// the same predicate the reopened gate's menu uses, so the two cannot disagree.
			const reviewed =
				cleared.value.review?.iteration === cleared.value.iteration && hasReviewEvidence(cleared.value.review);
			const unrecorded = describeUnrecordedReviewTurn(captured, reviewOptionLabel(reviewed));
			if (unrecorded !== undefined) ctx.ui.notify(unrecorded.message, unrecorded.level);

			// A gate is a TUI overlay; there is nothing to open elsewhere.
			if (ctx.mode !== "tui") return;

			const view = await flow.viewFromPendingReview(ctx);
			if (view === undefined) return;
			await flow.run(ctx, view);
		} catch (error) {
			ctx.ui.notify(formatReopenFailure(error, machine.reviewing() !== undefined), "error");
		}
	}

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
					...(outcome.state.external === true ? { external: true } : {}),
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
					// Whatever the worker spent before it died, which the gate labels as partial.
					usage: outcome.state.usage,
					interruptionNote: outcome.state.interruptionNote,
					// Carried so the gate can label a crash's leftovers rather than hide them.
					...(outcome.state.partialReport === undefined ? {} : { partialReport: outcome.state.partialReport }),
					...(outcome.state.stderrTail === undefined ? {} : { stderrTail: outcome.state.stderrTail }),
				};
			}

			return undefined;
		},

		async viewFromPendingReview(ctx: ExtensionContext): Promise<GateBView | undefined> {
			const reviewing = machine.reviewing();
			if (reviewing === undefined) return undefined;

			const allowance = reviewService.feedbackAllowance();
			// A review turn that failed stores a record with empty text. Presence drives the
			// menu's labels and the summary's reviewer block, so an empty one is dropped here
			// rather than allowed to claim a review that never happened. A review that is only
			// a verdict is kept: the verdict is real, and it orders the gate's actions.
			const review =
				reviewing.review?.iteration === reviewing.iteration && hasReviewEvidence(reviewing.review)
					? reviewing.review
					: undefined;
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
					...(reviewing.external === true ? { external: true } : {}),
				};
			}

			// An interrupted state stores no diffstat, so it is read live against the checkpoint.
			const diffstat = await runService.diffstat(ctx.cwd);
			return {
				...base,
				report: null,
				diffstat: diffstat.ok ? diffstat.value : "",
				diffstatFailure: diffstat.ok ? undefined : describeGitOrConflict(diffstat.error),
				usage: reviewing.usage,
				interruptionNote: reviewing.interruptionNote,
				...(reviewing.partialReport === undefined ? {} : { partialReport: reviewing.partialReport }),
				...(reviewing.stderrTail === undefined ? {} : { stderrTail: reviewing.stderrTail }),
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

				if (selected === "accept_leftovers") {
					// Captured before Accept, which resets the machine and takes the review with it.
					const reviewing = machine.reviewing();
					const reviewText = current.review?.text ?? reviewing?.review?.text ?? "";
					const parsedLeftovers = parseReviewLeftovers(reviewText);
					const leftovers: LeftoversScopeInput | undefined =
						reviewing === undefined || parsedLeftovers.kind === "none"
							? undefined
							: parsedLeftovers.kind === "items"
								? { slug: reviewing.draft.slug, prompt: reviewing.draft.prompt, items: parsedLeftovers.items }
								: { slug: reviewing.draft.slug, prompt: reviewing.draft.prompt, reviewText };

					const accepted = reviewService.accept();
					if (!accepted.ok) {
						ctx.ui.notify(accepted.error.message, "warning");
						return;
					}

					if (parsedLeftovers.kind === "none") {
						ctx.ui.notify("Handoff accepted. The review listed no leftovers to hand off.", "info");
						return;
					}
					ctx.ui.notify("Handoff accepted. Drafting a follow-up for the review's Leftovers: list…", "info");

					if (leftovers === undefined || draftLeftovers === undefined) {
						ctx.ui.notify(
							`The handoff was accepted, but the follow-up draft could not be started. Run \`${HANDOFF_COMMAND}\` to draft it.`,
							"warning",
						);
						return;
					}

					// The accept has already landed, so a failure here costs the follow-up draft and
					// nothing else; the drafting flow reports its own outcome.
					await draftLeftovers(ctx, leftovers);
					return;
				}

				if (selected === "view_report") {
					const report = current.report ?? current.partialReport ?? "";
					const title =
						current.report === null
							? `Partial output — ${current.slug} (NOT a report)`
							: `Worker report — ${current.slug}`;
					await openTextViewer(ctx, title, report);
					continue;
				}

				if (selected === "view_diffstat") {
					const body =
						current.diffstat.trim() === ""
							? current.diffstatFailure === undefined
								? "No changes against the checkpoint."
								: `The diffstat could not be read.\n\n${current.diffstatFailure}`
							: current.diffstat;
					const stderr = current.stderrTail?.trim();
					// Appended here so the crash evidence is reachable even though it is not a diff:
					// an interrupted run has no report viewer worth opening for stderr alone.
					const withStderr =
						stderr === undefined || stderr === "" ? body : `${body}\n\n--- Worker stderr (tail) ---\n\n${stderr}`;
					await openTextViewer(ctx, `Changes against the checkpoint — ${current.slug}`, withStderr);
					continue;
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
					// handler has to return for that turn to run. The gate reopens once that
					// turn has settled.
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

				const editorRequest = buildFeedbackEditorRequest(current);
				const feedback = await ctx.ui.editor(editorRequest.title, editorRequest.prefill);
				if (feedback === undefined) continue;
				const normalizedFeedback = normalizeReviewFeedback(feedback);
				if (normalizedFeedback === "") {
					// Enter submits and the editor trims, so a user who typed nothing arrives here with
					// "" and used to be told their text was a verdict line. Naming what happened is the
					// difference between retrying deliberately and accepting out of confusion.
					ctx.ui.notify(
						feedback.trim() === ""
							? `Nothing was sent: the feedback editor was empty. Type the feedback for the worker (Shift+Enter adds a line)${feedbackDraftAdvice(
									editorRequest.kind,
								)}.`
							: "No feedback to send: the editor contained only a verdict line.",
						"warning",
					);
					continue;
				}

				const rendered = await runWithWidget(
					ctx,
					{
						slug: current.slug,
						choice: current.choice,
						promptPath: current.promptPath,
						noProgressThresholdMs: runService.noProgressThresholdMs(),
					},
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

				// Run and review is latched when feedback restarts a worker. A completed retry
				// therefore arms the same review turn as iteration 1 and returns so Pi can run
				// it; an interrupted retry still falls through to Gate B below.
				if (sent.value.kind === "completed" && sent.value.state.autoReview === true && flow.startReviewTurn(ctx)) {
					return;
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

		startReviewTurn(ctx: ExtensionContext): boolean {
			const armed = reviewService.beginReview();
			if (!armed.ok) return false;

			// Deliberately not awaited, exactly as the gate's own Review here is not: the
			// message starts an agent turn, the caller has to return for that turn to run, and
			// the gate reopens once that turn has settled.
			sendUserMessage(reviewService.buildReviewMessage(armed.value));
			ctx.ui.notify("The worker finished. Reviewing its work in this session now.", "info");
			return true;
		},

		captureReviewTurn(outcome: ReviewTurnOutcome): void {
			// The arm flag is the sole condition under which this hook does anything.
			if (machine.reviewing()?.awaitingReviewTurn !== true) return;

			// Overwritten, not kept: an auto-retried prompt ends more than once, and the last
			// attempt is the review. That is also what makes a failed attempt Pi then retried
			// harmless — extensions never see `willRetry`, but they do see the attempt that
			// followed it, and `agent_settled` only fires once no retry remains.
			capture = outcome;
		},

		reopenAfterReviewTurn(ctx: ExtensionContext): void {
			const captured = capture;
			if (captured === undefined) return;

			// Cleared before anything is awaited, so a second settle for the same turn finds
			// nothing to reopen and cannot stack a second gate behind the first.
			capture = undefined;

			// The launch reports its own failure, and the outer catch keeps even a notify that
			// threw from becoming an unhandled rejection in a handler that already returned.
			reopen = reopenGateB(ctx, captured).catch(() => undefined);
		},

		async whenReopenSettled(): Promise<void> {
			await reopen;
		},

		forgetReviewTurn(): void {
			capture = undefined;
		},
	};

	return flow;
}
