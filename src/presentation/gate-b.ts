/**
 * Gate B: the review surface for a finished worker run.
 *
 * Split the same way as Gate A. `formatGateBSummary` is pure and owns everything
 * about what the gate says, including how an interrupted run and a failed
 * diffstat are presented, so those cases are unit-tested. `openGateB` only renders
 * the lines and resolves an option id.
 *
 * The interrupted case is why the summary is not a simple field dump. That state
 * carries null for report, diffstat, and usage, meaning "unavailable" rather than
 * "empty", so each is rendered as an explicit sentence about what happened
 * instead of a blank line that reads as a rendering fault.
 *
 * A crashed worker's pre-crash text and stderr tail are rendered under headings
 * that say what they are. The distinction is the whole point: `report` is a claim
 * the worker chose to make, while `partialReport` is whatever it happened to be
 * saying when it died, and labelling the second as the first is how a mid-task
 * sentence once reached a reviewer as a finished result.
 */

import { Container, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildInterruptedResumeFeedback, normalizeReviewFeedback } from "../domain/draft/feedback.ts";
import { formatModelChoice } from "../domain/draft/launch.ts";
import { formatUsageLines, type UsageTotals } from "../domain/report/format.ts";
import { parseReviewLeftovers, type CapturedReview } from "../domain/review.ts";
import type { ModelChoice } from "../domain/types.ts";
import { gateBMenu, type GateBOptionId } from "./menus.ts";

/** Lines of the report shown inside the gate before it is truncated. */
const REPORT_PREVIEW_LINES = 24;

/** Lines of diffstat shown before it is truncated. */
const DIFFSTAT_PREVIEW_LINES = 12;

/** Lines of captured reviewer findings shown before they are truncated. */
const REVIEW_PREVIEW_LINES = 24;

/** Lines of a crashed worker's pre-crash text shown before it is truncated. */
const PARTIAL_REPORT_PREVIEW_LINES = 8;

/** Lines of a failed worker's stderr tail shown before it is truncated. */
const STDERR_PREVIEW_LINES = 8;

/** Every shortened block keeps at least two lines of text and its signpost. */
const MIN_PREVIEW_ROWS = 3;

/** Gate title, three spacers, and the footer below the select list. */
const GATE_B_CHROME_ROWS = 5;

/**
 * Common completed-review reservation: 15 non-preview summary rows (metadata,
 * usage, headings, and verdict), seven menu rows, and five chrome rows.
 */
export const GATE_B_COMMON_COMPLETED_FIXED_ROWS = 27;

/**
 * Conservative reservation for the largest interrupted review: its evidence
 * headings, menu, and chrome can consume 32 rows before any preview expands.
 * This intentionally over-reserves the shorter crash shapes so their final action
 * is not displaced when all three evidence blocks are present.
 */
export const GATE_B_LARGEST_INTERRUPTED_FIXED_ROWS = 32;

type PreviewKind = "report" | "review" | "diffstat" | "partialReport" | "stderr";

type PreviewLimits = Partial<Record<PreviewKind, number>>;

/** Maximum body-line cap for each preview under the historical, unbudgeted layout. */
const PREVIEW_MAX_LINES: Record<PreviewKind, number> = {
	report: REPORT_PREVIEW_LINES,
	review: REVIEW_PREVIEW_LINES,
	diffstat: DIFFSTAT_PREVIEW_LINES,
	partialReport: PARTIAL_REPORT_PREVIEW_LINES,
	stderr: STDERR_PREVIEW_LINES,
};

/**
 * Gives worker and reviewer text the first spare rows, then diffstat, then crash tails.
 *
 * Every present block first gets its three-row floor. The remaining rows are handed
 * out in this order, so the main report remains useful first and diffstat yields
 * before it, while still taking priority over pre-crash output and stderr. A full
 * historical cap needs one additional row for its `… N more lines` signpost.
 */
const PREVIEW_PRIORITY: readonly PreviewKind[] = ["report", "review", "diffstat", "partialReport", "stderr"];

export interface GateBView {
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
	/** Null when the run was interrupted and reported no metrics. */
	usage: UsageTotals | null;
	/** Present only for an interrupted run, explaining what ended it. */
	interruptionNote: string | undefined;
	/**
	 * Text a crashed worker emitted before it died, shown labelled as pre-crash
	 * output. Deliberately not merged into `report`: see the module header.
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
 * Allocates a shared rendered-row budget across the previews currently present.
 *
 * A short terminal cannot make all fixed metadata and menu rows disappear. Once
 * those have consumed the terminal, every present block stays at its three-row
 * floor; above that point the result grows linearly until it reaches the existing
 * cap plus the signpost row. Omitting `terminalRows` is deliberately handled by
 * the caller, which preserves the exact historical formatter output for tests and
 * non-TUI callers.
 */
function previewLimits(terminalRows: number, fixedRows: number, present: readonly PreviewKind[]): PreviewLimits {
	const limits: PreviewLimits = Object.fromEntries(present.map((kind) => [kind, MIN_PREVIEW_ROWS]));
	let remaining = Math.max(0, Math.floor(terminalRows) - fixedRows - present.length * MIN_PREVIEW_ROWS);

	for (const kind of PREVIEW_PRIORITY) {
		if (!present.includes(kind)) continue;
		const current = limits[kind] ?? MIN_PREVIEW_ROWS;
		const maximum = PREVIEW_MAX_LINES[kind] + 1;
		const added = Math.min(maximum - current, remaining);
		limits[kind] = current + added;
		remaining -= added;
	}
	return limits;
}

/** Converts a rendered-row budget to the number of source lines a preview may show. */
function previewLineLimit(rows: number, kind: PreviewKind): number {
	const maximum = PREVIEW_MAX_LINES[kind];
	return rows >= maximum + 1 ? maximum : rows;
}

/** Exposed cap helpers keep the row arithmetic independently testable. */
export function reportPreviewLimit(
	terminalRows: number,
	fixedRows = GATE_B_COMMON_COMPLETED_FIXED_ROWS,
	present: readonly PreviewKind[] = ["report"],
): number {
	return previewLineLimit(previewLimits(terminalRows, fixedRows, present).report ?? MIN_PREVIEW_ROWS, "report");
}

export function diffstatPreviewLimit(
	terminalRows: number,
	fixedRows = GATE_B_COMMON_COMPLETED_FIXED_ROWS,
	present: readonly PreviewKind[] = ["diffstat"],
): number {
	return previewLineLimit(previewLimits(terminalRows, fixedRows, present).diffstat ?? MIN_PREVIEW_ROWS, "diffstat");
}

export function partialReportPreviewLimit(
	terminalRows: number,
	fixedRows = GATE_B_LARGEST_INTERRUPTED_FIXED_ROWS,
	present: readonly PreviewKind[] = ["partialReport"],
): number {
	return previewLineLimit(
		previewLimits(terminalRows, fixedRows, present).partialReport ?? MIN_PREVIEW_ROWS,
		"partialReport",
	);
}

export function stderrPreviewLimit(
	terminalRows: number,
	fixedRows = GATE_B_LARGEST_INTERRUPTED_FIXED_ROWS,
	present: readonly PreviewKind[] = ["stderr"],
): number {
	return previewLineLimit(previewLimits(terminalRows, fixedRows, present).stderr ?? MIN_PREVIEW_ROWS, "stderr");
}

/** Truncates a block to a bounded preview, noting how much was hidden and where the rest is. */
function preview(text: string, limit: number, kind: PreviewKind, viewerOption?: string): string[] {
	const lines = text.split("\n");
	if (lines.length <= limit) return lines;
	const bodyLines = limit === PREVIEW_MAX_LINES[kind] ? limit : Math.max(1, limit - 1);
	const hidden = lines.length - bodyLines;
	const hint = viewerOption === undefined ? "" : ` — choose "${viewerOption}" to read all of it`;
	return [...lines.slice(0, bodyLines), `… ${hidden} more line${hidden === 1 ? "" : "s"}${hint}`];
}

/** Renders the diffstat block, distinguishing "no changes" from "could not read". */
function diffstatLines(view: GateBView, limits: PreviewLimits): string[] {
	if (view.diffstatFailure !== undefined) {
		return ["Changes:   could not be read", `           ${view.diffstatFailure}`];
	}
	if (view.diffstat.trim() === "") return ["Changes:   none against the checkpoint"];
	return [
		"Changes:",
		...preview(view.diffstat.trimEnd(), limits.diffstat ?? DIFFSTAT_PREVIEW_LINES, "diffstat", "View full diffstat"),
	];
}

/** Renders the report block, or the reason there is none. */
function reportLines(view: GateBView, limits: PreviewLimits): string[] {
	if (view.report === null) {
		return [
			"Report:    none — the worker did not finish",
			...(view.interruptionNote === undefined ? [] : [`           ${view.interruptionNote}`]),
			...partialReportLines(view, limits),
			...stderrLines(view, limits),
		];
	}
	return [
		"Worker report:",
		...preview(view.report.trimEnd(), limits.report ?? REPORT_PREVIEW_LINES, "report", "View full report"),
	];
}

/** Renders a crashed worker's pre-crash text under a heading that says what it is. */
function partialReportLines(view: GateBView, limits: PreviewLimits): string[] {
	const partial = view.partialReport?.trimEnd();
	if (partial === undefined || partial === "") return [];
	return [
		"",
		"Partial output before the worker died (NOT a report — it never finished):",
		...preview(partial, limits.partialReport ?? PARTIAL_REPORT_PREVIEW_LINES, "partialReport", "View partial output"),
	];
}

/** Renders the stderr tail, which is usually where a crash names its real cause. */
function stderrLines(view: GateBView, limits: PreviewLimits): string[] {
	const tail = view.stderrTail?.trimEnd();
	if (tail === undefined || tail === "") return [];
	return [
		"",
		"Worker stderr (tail):",
		...preview(tail, limits.stderr ?? STDERR_PREVIEW_LINES, "stderr", "View full diffstat"),
	];
}

/** Renders the reviewer response that would otherwise be obscured behind this overlay. */
function reviewLines(view: GateBView, limits: PreviewLimits): string[] {
	if (view.review === undefined) return [];
	return [
		"",
		`Reviewer verdict: ${view.review.verdict ?? "none (no Verdict: line found)"}`,
		"Reviewer findings:",
		...preview(view.review.text.trimEnd(), limits.review ?? REVIEW_PREVIEW_LINES, "review"),
	];
}

/** Returns the preview blocks that contain text in the current Gate B state. */
function presentPreviewKinds(view: GateBView): PreviewKind[] {
	return [
		...(view.report !== null && view.report.trimEnd() !== "" ? (["report"] as const) : []),
		...((view.review?.text.trimEnd() ?? "") !== "" ? (["review"] as const) : []),
		...(view.diffstatFailure === undefined && view.diffstat.trimEnd() !== "" ? (["diffstat"] as const) : []),
		...((view.partialReport?.trimEnd() ?? "") !== "" ? (["partialReport"] as const) : []),
		...((view.stderrTail?.trimEnd() ?? "") !== "" ? (["stderr"] as const) : []),
	];
}

type ViewerFlags = { report: boolean; partialReport: boolean; diffstat: boolean };

/** Returns whether a preview omits source lines that only its viewer can reveal. */
function isPreviewTruncated(text: string, limit: number): boolean {
	return text.split("\n").length > limit;
}

/** Computes the viewer choices from the same limits that shorten the gate's previews. */
function viewerFlags(view: GateBView, limits: PreviewLimits): ViewerFlags {
	const report = view.report?.trimEnd();
	const partialReport = view.partialReport?.trimEnd() ?? "";
	const diffstat = view.diffstatFailure === undefined ? view.diffstat.trimEnd() : "";
	const stderr = view.stderrTail?.trimEnd() ?? "";
	return {
		report:
			report !== undefined && report !== "" ? isPreviewTruncated(report, limits.report ?? REPORT_PREVIEW_LINES) : false,
		partialReport:
			partialReport !== ""
				? isPreviewTruncated(partialReport, limits.partialReport ?? PARTIAL_REPORT_PREVIEW_LINES)
				: false,
		diffstat:
			(diffstat !== "" ? isPreviewTruncated(diffstat, limits.diffstat ?? DIFFSTAT_PREVIEW_LINES) : false) ||
			(stderr !== "" ? isPreviewTruncated(stderr, limits.stderr ?? STDERR_PREVIEW_LINES) : false),
	};
}

/** Builds a menu from viewer choices without ever making partial output a report. */
function menuFor(view: GateBView, viewers: ViewerFlags) {
	return gateBMenu({
		interrupted: view.report === null,
		hasReport: viewers.report,
		hasPartialReport: viewers.partialReport,
		hasDiffstat: viewers.diffstat,
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

function sameViewerFlags(left: ViewerFlags, right: ViewerFlags): boolean {
	return left.report === right.report && left.partialReport === right.partialReport && left.diffstat === right.diffstat;
}

/**
 * Builds Gate B's menu from the preview that will actually be rendered.
 *
 * A viewer itself consumes a menu row, which can make a marginal preview shorter.
 * Start with every available viewer and only remove choices as the reclaimed rows
 * reveal their full text; otherwise a one-line crash fragment can reopen the exact
 * no-op viewer this gate is meant to prevent.
 */
export function gateBOptions(view: GateBView, terminalRows?: number) {
	const candidates: ViewerFlags = {
		report: view.report !== null && view.report.trimEnd() !== "",
		partialReport: (view.partialReport?.trimEnd() ?? "") !== "",
		diffstat:
			(view.diffstatFailure === undefined && view.diffstat.trimEnd() !== "") ||
			(view.stderrTail?.trimEnd() ?? "") !== "",
	};
	if (terminalRows === undefined) return menuFor(view, viewerFlags(view, {}));

	let viewers = candidates;
	for (;;) {
		const limits = previewLimits(
			terminalRows,
			fixedRowsFor(view, menuFor(view, viewers).length),
			presentPreviewKinds(view),
		);
		const next = viewerFlags(view, limits);
		if (sameViewerFlags(viewers, next)) return menuFor(view, next);
		viewers = next;
	}
}

/** Counts the summary, menu, and chrome that cannot give way to a preview. */
function fixedRowsFor(view: GateBView, menuRows: number): number {
	if (view.report === null) return GATE_B_LARGEST_INTERRUPTED_FIXED_ROWS;

	const usageRows = view.usage === null ? 1 : formatUsageLines(view.usage).length;
	const diffstatRows = view.diffstatFailure !== undefined ? 2 : 1;
	const reviewRows = view.review === undefined ? 0 : 3;
	const structuralRows = 4 + usageRows + 1 + diffstatRows + 1 + 1 + reviewRows + menuRows + GATE_B_CHROME_ROWS;
	return Math.max(GATE_B_COMMON_COMPLETED_FIXED_ROWS, structuralRows);
}

/**
 * Builds Gate B's summary lines.
 *
 * Usage is omitted rather than zeroed for an interrupted run: printing zero
 * tokens and no cost would claim the worker did nothing, when in fact what it
 * did was not measured. The same reasoning covers an external run, whose worker
 * ran in another terminal and was never measured at all.
 */
export function formatGateBSummary(view: GateBView, terminalRows?: number): string[] {
	const usageLines =
		view.usage === null
			? [
					view.external === true
						? "Usage:     not available — the handoff ran in another terminal"
						: "Usage:     not available for an unfinished run",
				]
			: formatUsageLines(view.usage);
	const present = presentPreviewKinds(view);
	const limits =
		terminalRows === undefined
			? {}
			: previewLimits(terminalRows, fixedRowsFor(view, gateBOptions(view, terminalRows).length), present);

	return [
		`Handoff:   ${view.slug}`,
		`Model:     ${formatModelChoice(view.choice)}`,
		`Iteration: ${view.iteration}`,
		`Prompt:    ${view.promptPath}`,
		...usageLines,
		"",
		...diffstatLines(view, limits),
		"",
		...reportLines(view, limits),
		...reviewLines(view, limits),
	];
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
export function buildFeedbackEditorRequest(view: GateBView): FeedbackEditorRequest {
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
export function formatGateBTitle(view: GateBView): string {
	return view.report === null ? "Handoff did not complete" : "Handoff complete — review the changes";
}

/**
 * Renders Gate B and resolves the selected option.
 *
 * Resolves undefined when the user dismisses the gate, which the caller treats as
 * leaving the review pending rather than as an implicit accept or discard.
 */
export async function openGateB(ctx: ExtensionContext, view: GateBView): Promise<GateBOptionId | undefined> {
	return ctx.ui.custom<GateBOptionId | undefined>((tui, theme, _keybindings, done) => {
		const options = gateBOptions(view, tui.terminal.rows);
		const items: SelectItem[] = options.map((option) => ({
			value: option.id,
			label: option.label,
			...(option.description === undefined ? {} : { description: option.description }),
		}));
		const container = new Container();
		const heading = formatGateBTitle(view);
		container.addChild(new Text(theme.fg("accent", theme.bold(heading)), 1, 0));
		container.addChild(new Spacer(1));
		for (const line of formatGateBSummary(view, tui.terminal.rows)) {
			// An empty Text renders zero lines, so a blank separator must be a Spacer.
			if (line === "") {
				container.addChild(new Spacer(1));
				continue;
			}
			container.addChild(new Text(theme.fg(line.startsWith("…") ? "dim" : "text", line), 1, 0));
		}
		container.addChild(new Spacer(1));

		const list = new SelectList(items, items.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("dim", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("dim", text),
		});
		list.onSelect = (item) => done(item.value as GateBOptionId);
		list.onCancel = () => done(undefined);
		container.addChild(list);

		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate   enter select   esc leave for later"), 1, 0));

		// SelectList owns key handling; forwarding keeps the container focusable.
		const focusable = container as Container & { handleInput?: (data: string) => void };
		focusable.handleInput = (data: string) => list.handleInput(data);
		return focusable;
	});
}

/**
 * Shows a block of lines and waits for acknowledgement.
 *
 * Used for the discard summary, which must not be a transient notification: it
 * reports which paths were deliberately left dirty, and that is the one message
 * in this flow a user cannot afford to miss while scrolling.
 */
export async function openAcknowledgement(
	ctx: ExtensionContext,
	title: string,
	lines: readonly string[],
	options: { warning?: boolean } = {},
): Promise<void> {
	await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
		const container = new Container();
		const titleColor = options.warning === true ? "warning" : "accent";
		container.addChild(new Text(theme.fg(titleColor, theme.bold(title)), 1, 0));
		container.addChild(new Spacer(1));
		for (const line of lines) {
			// An empty Text renders zero lines, so a blank separator must be a Spacer.
			if (line === "") {
				container.addChild(new Spacer(1));
				continue;
			}
			const color = line.startsWith("Warning:") ? "warning" : line.startsWith("  ") ? "dim" : "text";
			container.addChild(new Text(theme.fg(color, line), 1, 0));
		}
		container.addChild(new Spacer(1));

		const items: SelectItem[] = [{ value: "ok", label: "OK" }];
		const list = new SelectList(items, 1, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("dim", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("dim", text),
		});
		list.onSelect = () => done(undefined);
		list.onCancel = () => done(undefined);
		container.addChild(list);

		const focusable = container as Container & { handleInput?: (data: string) => void };
		focusable.handleInput = (data: string) => list.handleInput(data);
		return focusable;
	});
}
