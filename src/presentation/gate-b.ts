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

/** Truncates a block to a bounded preview, noting how much was hidden and where the rest is. */
function preview(text: string, limit: number, viewerOption?: string): string[] {
	const lines = text.split("\n");
	if (lines.length <= limit) return lines;
	const hidden = lines.length - limit;
	const hint = viewerOption === undefined ? "" : ` — choose "${viewerOption}" to read all of it`;
	return [...lines.slice(0, limit), `… ${hidden} more line${hidden === 1 ? "" : "s"}${hint}`];
}

/** Renders the diffstat block, distinguishing "no changes" from "could not read". */
function diffstatLines(view: GateBView): string[] {
	if (view.diffstatFailure !== undefined) {
		return ["Changes:   could not be read", `           ${view.diffstatFailure}`];
	}
	if (view.diffstat.trim() === "") return ["Changes:   none against the checkpoint"];
	return ["Changes:", ...preview(view.diffstat.trimEnd(), DIFFSTAT_PREVIEW_LINES, "View full diffstat")];
}

/** Renders the report block, or the reason there is none. */
function reportLines(view: GateBView): string[] {
	if (view.report === null) {
		return [
			"Report:    none — the worker did not finish",
			...(view.interruptionNote === undefined ? [] : [`           ${view.interruptionNote}`]),
			...partialReportLines(view),
			...stderrLines(view),
		];
	}
	return ["Worker report:", ...preview(view.report.trimEnd(), REPORT_PREVIEW_LINES, "View full report")];
}

/**
 * Renders a crashed worker's pre-crash text under a heading that says what it is.
 *
 * The heading carries the whole warning. This text looks exactly like a report and
 * is not one, so it is never introduced as "Worker report".
 */
function partialReportLines(view: GateBView): string[] {
	const partial = view.partialReport?.trimEnd();
	if (partial === undefined || partial === "") return [];
	return [
		"",
		"Partial output before the worker died (NOT a report — it never finished):",
		...preview(partial, PARTIAL_REPORT_PREVIEW_LINES),
	];
}

/** Renders the stderr tail, which is usually where a crash names its real cause. */
function stderrLines(view: GateBView): string[] {
	const tail = view.stderrTail?.trimEnd();
	if (tail === undefined || tail === "") return [];
	return ["", "Worker stderr (tail):", ...preview(tail, STDERR_PREVIEW_LINES)];
}

/** Renders the reviewer response that would otherwise be obscured behind this overlay. */
function reviewLines(view: GateBView): string[] {
	if (view.review === undefined) return [];
	return [
		"",
		`Reviewer verdict: ${view.review.verdict ?? "none (no Verdict: line found)"}`,
		"Reviewer findings:",
		...preview(view.review.text.trimEnd(), REVIEW_PREVIEW_LINES),
	];
}

/**
 * Builds Gate B's summary lines.
 *
 * Usage is omitted rather than zeroed for an interrupted run: printing zero
 * tokens and no cost would claim the worker did nothing, when in fact what it
 * did was not measured. The same reasoning covers an external run, whose worker
 * ran in another terminal and was never measured at all.
 */
export function formatGateBSummary(view: GateBView): string[] {
	const usageLines =
		view.usage === null
			? [
					view.external === true
						? "Usage:     not available — the handoff ran in another terminal"
						: "Usage:     not available for an unfinished run",
				]
			: formatUsageLines(view.usage);

	return [
		`Handoff:   ${view.slug}`,
		`Model:     ${formatModelChoice(view.choice)}`,
		`Iteration: ${view.iteration}`,
		`Prompt:    ${view.promptPath}`,
		...usageLines,
		"",
		...diffstatLines(view),
		"",
		...reportLines(view),
		...reviewLines(view),
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
	const options = gateBMenu({
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
	const items: SelectItem[] = options.map((option) => ({
		value: option.id,
		label: option.label,
		...(option.description === undefined ? {} : { description: option.description }),
	}));

	return ctx.ui.custom<GateBOptionId | undefined>((_tui, theme, _keybindings, done) => {
		const container = new Container();
		const heading = formatGateBTitle(view);
		container.addChild(new Text(theme.fg("accent", theme.bold(heading)), 1, 0));
		container.addChild(new Spacer(1));
		for (const line of formatGateBSummary(view)) {
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
