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
		...preview(partial, limits.partialReport ?? PARTIAL_REPORT_PREVIEW_LINES, "partialReport"),
	];
}

/** Renders the stderr tail, which is usually where a crash names its real cause. */
function stderrLines(view: GateBView, limits: PreviewLimits): string[] {
	const tail = view.stderrTail?.trimEnd();
	if (tail === undefined || tail === "") return [];
	return ["", "Worker stderr (tail):", ...preview(tail, limits.stderr ?? STDERR_PREVIEW_LINES, "stderr")];
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

/** Builds Gate B's menu once so its count is shared by sizing and rendering. */
function gateBOptions(view: GateBView) {
	return gateBMenu({
		interrupted: view.report === null,
		hasReport: (view.report ?? view.partialReport ?? "") !== "",
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
			: previewLimits(terminalRows, fixedRowsFor(view, gateBOptions(view).length), present);

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
	const options = gateBOptions(view);
	const items: SelectItem[] = options.map((option) => ({
		value: option.id,
		label: option.label,
		...(option.description === undefined ? {} : { description: option.description }),
	}));

	return ctx.ui.custom<GateBOptionId | undefined>((tui, theme, _keybindings, done) => {
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
