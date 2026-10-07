/**
 * The result gate: the review surface for a finished worker run.
 *
 * Split the same way as the launch gate. `resultGateContent` is pure and owns
 * everything about what the gate says, including how an interrupted run and a
 * failed diffstat are presented, so those cases are unit-tested; `resultGateOptions`
 * owns which viewers the menu offers. `openResultGate` hands both to the gate frame,
 * which fits the evidence blocks below the menu and reports back which ones it had to
 * shorten, so a viewer is offered exactly when its block hides text.
 *
 * The interrupted case is why the content is not a simple field dump. That state
 * carries null for report, diffstat, and usage, meaning "unavailable" rather than
 * "empty", so each is rendered as an explicit sentence about what happened
 * instead of a blank line that reads as a rendering fault.
 *
 * A crashed worker's partial output and stderr tail are rendered under headings
 * that say what they are. The distinction is the whole point: `report` is a claim
 * the worker chose to make, while partial output is whatever it happened to be
 * saying when it died, and labelling the second as the first is how a mid-task
 * sentence once reached a reviewer as a finished result.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildInterruptedResumeFeedback, normalizeReviewFeedback } from "../domain/draft/feedback.ts";
import { formatModelChoice } from "../domain/draft/launch.ts";
import {
	formatDiscardHeadline,
	formatDiscardPaths,
	formatDiscardWarning,
	hasSkippedPaths,
	type DiscardPaths,
} from "../domain/report/discard.ts";
import { formatUsageLines, type UsageTotals } from "../domain/report/format.ts";
import { parseReviewLeftovers, type CapturedReview } from "../domain/review.ts";
import type { ModelChoice } from "../domain/types.ts";
import { NOT_A_REPORT, PARTIAL_OUTPUT, resultGateTitle } from "../domain/vocabulary.ts";
import { openGate, type GateBlock, type GateSpec } from "./gate-frame.ts";
import { discardSummaryMenu, resultGateMenu, type DiscardSummaryOptionId, type ResultGateOptionId } from "./menus.ts";

export interface ResultGateView {
	slug: string;
	choice: ModelChoice;
	promptPath: string;
	iteration: number;
	/** Null when the run was interrupted, which is never the same as an empty report. */
	report: string | null;
	/** Read live, because an interrupted state stores none. */
	diffstat: string;
	/** Present when Git could not produce a diffstat, so the gate can say why. */
	diffstatFailure: string | undefined;
	/**
	 * Null only when nothing was measured: an external run, or a run whose session
	 * restarted. An interrupted child-process run carries the usage it spent before it
	 * died, which the summary labels as partial rather than final.
	 */
	usage: UsageTotals | null;
	/** Present only for an interrupted run, explaining what ended it. */
	interruptionNote: string | undefined;
	/**
	 * Text a crashed worker emitted before it died, shown labelled as partial output.
	 * Deliberately not merged into `report`: see the module header. The field keeps its
	 * persisted name; the vocabulary is "partial output".
	 */
	partialReport?: string;
	/** Bounded tail of a failed worker's stderr, which usually names the real failure. */
	stderrTail?: string;
	/** True when the handoff ran in another terminal, so absent usage is expected. */
	external?: boolean;
	/** Captured Review here response, only when it applies to this iteration. */
	review?: CapturedReview;
	/**
	 * Whether another worker iteration is allowed, used only for the menu label.
	 *
	 * Undefined leaves the option unlabelled-as-blocked. The service refuses a
	 * bound-exceeding iteration regardless of what this says.
	 */
	feedback?: { allowed: boolean; iteration: number; maxIterations: number };
}

/**
 * The gate's evidence blocks, in the order the frame shrinks them: the worker's own
 * claim first, then the reviewer's, then the diffstat, then crash evidence.
 */
export type ResultGateBlockId = "report" | "review" | "diffstat" | "partialOutput" | "stderr";

/**
 * The menu option that opens each block's viewer, by id.
 *
 * The frame looks the label up in the menu it offers, so the signpost always names
 * what the menu renders. Findings have no viewer: the whole review is already in the
 * transcript. The diffstat viewer appends the stderr tail, so stderr points there.
 */
const VIEWER_FOR: Record<ResultGateBlockId, ResultGateOptionId | undefined> = {
	report: "view_report",
	review: undefined,
	diffstat: "view_diffstat",
	partialOutput: "view_report",
	stderr: "view_diffstat",
};

/** Header and blocks the frame fits; `header` is fixed context, `blocks` give way. */
export interface ResultGateContent {
	header: string[];
	blocks: GateBlock<ResultGateOptionId>[];
}

function block(id: ResultGateBlockId, label: string, heading: string, text: string): GateBlock<ResultGateOptionId> {
	const viewer = VIEWER_FOR[id];
	return {
		id,
		label,
		heading,
		text: text.trimEnd(),
		...(viewer === undefined ? {} : { viewerOption: viewer }),
	};
}

/**
 * Builds the result gate's header and blocks.
 *
 * Usage is omitted rather than zeroed when it was never measured: printing zero
 * tokens and no cost would claim the worker did nothing, when in fact nobody
 * watched it. That covers an external run, whose worker ran in another terminal,
 * and a run whose session restarted. A child-process run that crashed or was
 * stopped *was* measured up to that point, so its figures are shown under a
 * heading that says they are partial — the alternative is what left a seven-hour
 * Opus run's cost unknown.
 *
 * The reviewer's verdict sits with the identity lines at the top of the header rather
 * than at its end: the frame cuts the header from the bottom when even the menu will
 * not fit, and the one line that most changes the decision must be the last to go,
 * not the first.
 */
export function resultGateContent(view: ResultGateView): ResultGateContent {
	const usageLines =
		view.usage === null
			? [
					view.external === true
						? "Usage:     not available — the handoff ran in another terminal"
						: "Usage:     not available for an unfinished run",
				]
			: view.report === null
				? ["Usage:     measured before the run ended", ...formatUsageLines(view.usage)]
				: formatUsageLines(view.usage);

	const diffstatHeader =
		view.diffstatFailure !== undefined
			? ["Changes:   could not be read", `           ${view.diffstatFailure}`]
			: view.diffstat.trim() === ""
				? ["Changes:   none against the checkpoint"]
				: [];

	const reportHeader =
		view.report === null
			? [
					"Report:    none — the worker did not finish",
					...(view.interruptionNote === undefined ? [] : [`           ${view.interruptionNote}`]),
				]
			: [];

	const reviewHeader =
		view.review === undefined ? [] : [`Reviewer verdict: ${view.review.verdict ?? "none (no Verdict: line found)"}`];

	const header = [
		`Handoff:   ${view.slug}`,
		`Model:     ${formatModelChoice(view.choice)}`,
		`Iteration: ${view.iteration}`,
		...reviewHeader,
		`Prompt:    ${view.promptPath}`,
		...usageLines,
		...(diffstatHeader.length + reportHeader.length === 0 ? [] : [""]),
		...diffstatHeader,
		...reportHeader,
	];

	const blocks: GateBlock<ResultGateOptionId>[] = [
		...(view.report === null ? [] : [block("report", "report", "Worker report:", view.report)]),
		...(view.review === undefined ? [] : [block("review", "findings", "Reviewer findings:", view.review.text)]),
		...(view.diffstatFailure === undefined ? [block("diffstat", "diffstat", "Changes:", view.diffstat)] : []),
		...(view.partialReport === undefined
			? []
			: [
					block(
						"partialOutput",
						"partial output",
						`${PARTIAL_OUTPUT} before the worker died (${NOT_A_REPORT} — it never finished):`,
						view.partialReport,
					),
				]),
		...(view.stderrTail === undefined
			? []
			: [block("stderr", "stderr tail", "Worker stderr (tail):", view.stderrTail)]),
	];

	return { header, blocks };
}

/**
 * Everything the gate says, untruncated: the header followed by each block's heading
 * and full text. For callers and tests without a terminal; the frame decides what fits.
 */
export function formatResultGateSummary(view: ResultGateView): string[] {
	const { header, blocks } = resultGateContent(view);
	return [
		...header,
		...blocks.flatMap((entry) =>
			entry.text === "" ? [] : ["", ...(entry.heading === undefined ? [] : [entry.heading]), ...entry.text.split("\n")],
		),
	];
}

/**
 * Builds the result gate's menu.
 *
 * A viewer is offered only for text the gate could not show in full, because a
 * read-only viewer with nowhere to navigate is a broken promise. With no `shortened`
 * set — before the frame has fitted anything — every block with text is a candidate,
 * which is the menu the frame fits first; it then calls back with the blocks it
 * actually shortened. The labels never collapse: partial output is "View partial
 * output", never "View full report", because that relabelling is how a crash fragment
 * was once presented as a finished result.
 */
export function resultGateOptions(view: ResultGateView, shortened?: ReadonlySet<string>) {
	const present = new Set(
		resultGateContent(view)
			.blocks.filter((entry) => entry.text !== "")
			.map((entry) => entry.id),
	);
	const offered = (id: ResultGateBlockId) => present.has(id) && (shortened === undefined || shortened.has(id));
	return resultGateMenu({
		interrupted: view.report === null,
		hasReport: offered("report"),
		hasPartialReport: offered("partialOutput"),
		hasDiffstat: offered("diffstat") || offered("stderr"),
		...(view.review === undefined
			? {}
			: {
					review: {
						...(view.review.verdict === undefined ? {} : { verdict: view.review.verdict }),
						leftovers: parseReviewLeftovers(view.review.text).kind,
					},
				}),
		...(view.feedback === undefined ? {} : { feedback: view.feedback }),
	});
}

/**
 * What the feedback editor can start from, which decides its prefill and its title.
 *
 * `review` has reviewer findings to prefill. `verdict_only` has a review that said
 * nothing but its `Verdict:` line, so there is a review but nothing to edit.
 * `interrupted` has no review and never will, because Review here is refused for a
 * run that produced no report. `none` is a finished iteration nobody has reviewed yet.
 */
export type FeedbackEditorKind = "review" | "verdict_only" | "interrupted" | "none";

/** The title and prefill for Send feedback's editor, which takes nothing else. */
export interface FeedbackEditorRequest {
	kind: FeedbackEditorKind;
	title: string;
	prefill: string;
}

/**
 * Builds Send feedback's editor request.
 *
 * `ctx.ui.editor` accepts a title and a prefill and nothing else, so everything the
 * user needs to know about why the buffer looks the way it does has to be in one of
 * those two. A blank buffer with no explanation is what sent users back to the gate
 * until they accepted a handoff they had not reviewed.
 */
export function buildFeedbackEditorRequest(view: ResultGateView): FeedbackEditorRequest {
	const reviewFeedback = view.review === undefined ? "" : normalizeReviewFeedback(view.review.text);
	if (reviewFeedback !== "") return { kind: "review", title: "Review feedback", prefill: reviewFeedback };
	if (view.review !== undefined) {
		return {
			kind: "verdict_only",
			title: `Review feedback (the review for iteration ${view.iteration} was only its verdict, so there is nothing to edit)`,
			prefill: "",
		};
	}
	// An interrupted run is the one case with nothing to start from and no review to
	// wait for, so the editor opens on a draft the user edits, rewrites, or deletes.
	if (view.report === null) {
		return {
			kind: "interrupted",
			title: `Feedback for interrupted iteration ${view.iteration} (edit this draft before sending)`,
			prefill: buildInterruptedResumeFeedback(view.interruptionNote ?? ""),
		};
	}
	return {
		kind: "none",
		title: `Review feedback (no review captured for iteration ${view.iteration}; Review here would pre-fill this)`,
		prefill: "",
	};
}

/**
 * Names the option that would produce the missing text, when there is one.
 *
 * The label has to match what the menu renders, which relabels Review here to
 * Review again once a review exists, and drops it for an interrupted run. Pointing
 * a user at an option the gate refuses, or one under a different name, is the same
 * dead end as the message this advice was added to fix.
 */
export function feedbackDraftAdvice(kind: FeedbackEditorKind): string {
	switch (kind) {
		case "none":
			return ", or choose Review here first to draft it";
		case "verdict_only":
			return ", or choose Review again first to draft it";
		// `review` had the text already and the user cleared it; `interrupted` is offered
		// no review option at all.
		case "review":
		case "interrupted":
			return "";
	}
}

/** Chooses the gate's heading, so an unfinished run is not titled as a result. */
export function formatResultGateTitle(view: ResultGateView): string {
	return resultGateTitle(view.report !== null);
}

/** The result gate as a spec the frame can fit. */
export function resultGateSpec(view: ResultGateView): GateSpec<ResultGateOptionId> {
	const { header, blocks } = resultGateContent(view);
	return {
		title: formatResultGateTitle(view),
		header,
		menu: resultGateOptions(view),
		resolveMenu: (shortened) => resultGateOptions(view, shortened),
		blocks,
		hint: "↑↓ navigate   enter select   esc leave for later",
	};
}

/**
 * Renders the result gate and resolves the selected option.
 *
 * Resolves undefined when the user dismisses the gate, which the caller treats as
 * leaving the review pending rather than as an implicit accept or discard.
 */
export async function openResultGate(
	ctx: ExtensionContext,
	view: ResultGateView,
): Promise<ResultGateOptionId | undefined> {
	return openGate(ctx, resultGateSpec(view));
}

/** The block id under which the discard summary's path lists are fitted. */
export const DISCARD_PATHS_BLOCK = "paths";

/**
 * The discard summary as a spec the frame can fit.
 *
 * The warning is the header, which the frame cuts only after everything else; the
 * path lists are a block, so on a short terminal they shrink to a signpost that
 * names the viewer instead of silently losing their tail. Before this split the
 * lists sat in the header, where a cut left a bare `… N more lines` and no way to
 * read the rest — on the 24-row minimum, nine skipped paths were enough.
 */
export function discardSummarySpec(outcome: DiscardPaths): GateSpec<DiscardSummaryOptionId> {
	const paths = formatDiscardPaths(outcome).join("\n");
	return {
		title: formatDiscardHeadline(outcome),
		tone: hasSkippedPaths(outcome) ? "warning" : "accent",
		header: formatDiscardWarning(outcome),
		headerTone: (line) => (line.startsWith("Warning:") ? "warning" : "text"),
		menu: discardSummaryMenu({ pathsShortened: true }),
		resolveMenu: (shortened) => discardSummaryMenu({ pathsShortened: shortened.has(DISCARD_PATHS_BLOCK) }),
		blocks: [{ id: DISCARD_PATHS_BLOCK, label: "paths", text: paths, viewerOption: "view_paths" }],
		hint: "enter continue",
	};
}

/**
 * Shows what a discard did and waits for the user to continue.
 *
 * Not a transient notification: the summary reports which paths were deliberately
 * left dirty, and that is the one message in this flow a user cannot afford to miss
 * while scrolling. Resolves `view_paths` when the user asks to read the lists in
 * full; the caller opens the viewer and shows the summary again.
 */
export async function openDiscardSummary(
	ctx: ExtensionContext,
	outcome: DiscardPaths,
): Promise<DiscardSummaryOptionId | undefined> {
	return openGate(ctx, discardSummarySpec(outcome));
}
