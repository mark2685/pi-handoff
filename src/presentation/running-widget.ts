/**
 * The live widget shown while a worker runs.
 *
 * This is the first live-updating component in the package, so two mechanics are
 * worth stating. Updates are pushed with `tui.requestRender()` — once per second
 * from a timer so elapsed time advances even when the worker is silent, and again
 * on every progress event so turns, tokens, cost, and recent tool calls track the
 * child. And the overlay owns the abort, following `drafting-loader.ts`: Pi's
 * command context exposes no abort signal for this phase, so Escape here is the
 * only thing that can stop the worker.
 *
 * Escape does not resolve the overlay. The child dies through SIGTERM and then
 * SIGKILL, which takes time, and closing the overlay at the keypress would hand
 * the session back while a process was still writing to the working tree. Instead
 * the widget switches to a stopping state and the run's own completion resolves
 * it, so the overlay closes only once the worker is actually gone.
 *
 * `ctx.ui.custom` is used rather than `ctx.ui.setWidget` because §5.4 requires the
 * user to be able to stop the worker: an overlay takes keyboard focus, and
 * `setWidget` renders without focus, leaving no key to bind Escape to. Blocking
 * also matches the design's decision that the reviewing session waits at a gate.
 */

import { Container, Key, matchesKey, Spacer, Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { formatModelChoice } from "../domain/draft/launch.ts";
import { formatCost, formatElapsed, formatTokenCount, formatTokenSummary } from "../domain/report/format.ts";
import type { ModelChoice } from "../domain/types.ts";
import type { RunProgress } from "../app/run-service.ts";

/** How many recent tool calls the widget lists. */
const RECENT_TOOL_CALLS = 5;

/** The minimum completion checklist still useful on the 24-row minimum target. */
const MIN_WIDGET_DEFINITION_OF_DONE_ITEMS = 2;

/** Never duplicate the full Gate A checklist in the running overlay. */
const MAX_WIDGET_DEFINITION_OF_DONE_ITEMS = 5;

/**
 * Rows occupied with the goal line, the definition heading, two completion bullets, five recent
 * calls, metrics, title, spacer, and the abort hint. Keep this conservative budget so
 * the hint stays visible at the 24-row minimum target.
 */
const WIDGET_FIXED_ROWS = 22;

/** Horizontal padding Text adds on either side of the live body. */
const WIDGET_BODY_PADDING_X = 1;

/** How often the worker pulse and elapsed-time/status age are refreshed while the worker is quiet. */
const TICK_INTERVAL_MS = 120;

/** The same dim-to-accent-to-terminal-foreground pulse used by the Hadrian theme's working indicator. */
const STATUS_INDICATOR_FRAMES = ["·", "•", "●", "●", "●", "•"] as const;

export interface RunningWidgetView {
	slug: string;
	choice: ModelChoice;
	promptPath: string;
	bluf?: string;
	definitionOfDone?: string[];
	/** The child adapter's quiet interval, repeated here so the prompt names the real policy. */
	noProgressThresholdMs: number;
}

/** Returns the width available to a Text body after its left and right margins. */
function bodyContentWidth(terminalWidth: number): number {
	return Math.max(1, Math.floor(terminalWidth) - WIDGET_BODY_PADDING_X * 2);
}

/**
 * Chooses a row-aware checklist cap while reserving the live status and abort hint.
 *
 * Two conditions fit at the 24-row minimum target; a taller terminal gets up to all
 * five conditions without giving the fixed Gate A detail block a second full rendering.
 */
export function definitionOfDoneLimit(terminalRows: number): number {
	return Math.max(
		MIN_WIDGET_DEFINITION_OF_DONE_ITEMS,
		Math.min(MAX_WIDGET_DEFINITION_OF_DONE_ITEMS, Math.floor(terminalRows) - WIDGET_FIXED_ROWS),
	);
}

/**
 * Formats fixed header metadata without displacing live status in a 24-row terminal.
 *
 * `width` is the Text content width, excluding its horizontal padding. The full
 * definition remains at Gate A; the running overlay shows the goal and a row-aware
 * subset of conditions.
 */
export function formatRunningHeaderLines(
	view: RunningWidgetView,
	width = Number.POSITIVE_INFINITY,
	definitionOfDoneItems = MIN_WIDGET_DEFINITION_OF_DONE_ITEMS,
): string[] {
	const lines = [
		`Handoff:   ${view.slug}`,
		`Model:     ${formatModelChoice(view.choice)}`,
		`Prompt:    ${view.promptPath}`,
	];
	if (view.bluf !== undefined) lines.push(`Goal: ${view.bluf}`);

	const conditions = view.definitionOfDone?.slice(0, definitionOfDoneItems) ?? [];
	if (conditions.length > 0) {
		const suffix = (view.definitionOfDone?.length ?? 0) > conditions.length ? " (first conditions)" : "";
		lines.push(`Definition of done:${suffix}`, ...conditions.map((condition) => `  - ${condition}`));
	}

	const maximum = Math.max(1, Math.floor(width));
	return lines.map((line) => truncateToWidth(line, maximum, "…"));
}

/** Formats one completed tool call for the recent-activity list. */
function toolCallLine(result: { toolName: string; isError: boolean }): string {
	return `  ${result.isError ? "✗" : "✓"} ${result.toolName}`;
}

/** Formats an elapsed age in language that does not imply a silent worker is progressing. */
function formatUpdateAge(elapsedMs: number): string {
	return elapsedMs < 1_000 ? "just now" : `${formatElapsed(elapsedMs)} ago`;
}

/** Produces the compact status row that replaces the old spacer below the run metadata. */
export function formatWorkerStatusLine(state: {
	elapsedMs: number;
	progress: RunProgress | undefined;
	stopping: boolean;
	noProgressThresholdMs: number;
}): string {
	if (state.stopping) return "Status:    ⏳ Stopping worker — waiting for it to exit";

	const progress = state.progress;
	if (progress === undefined) {
		return `Status:    ◌ Starting worker — no events yet (${formatElapsed(state.elapsedMs)})`;
	}

	const updateAge = formatUpdateAge(Math.max(0, state.elapsedMs - progress.elapsedMs));
	const activeTools = progress.activeTools ?? [];
	if (progress.activity?.kind === "stalled") {
		const activeToolContext =
			activeTools.length === 0
				? ""
				: ` while running ${activeTools.length} ${activeTools.length === 1 ? "tool" : "tools"}: ${activeTools.map((tool) => tool.toolName).join(", ")}`;
		return `Status:    ⚠ No worker event for ${formatElapsed(state.noProgressThresholdMs)}${activeToolContext} · last event ${updateAge} — it may still be working; press esc to stop or wait`;
	}

	if (activeTools.length > 0) {
		const names = activeTools.map((tool) => tool.toolName).join(", ");
		return `Status:    ↻ Running ${activeTools.length} ${activeTools.length === 1 ? "tool" : "tools"}: ${names} · last event ${updateAge}`;
	}

	const activity = progress.activity;
	let detail: string;
	switch (activity?.kind) {
		case "thinking":
			detail = "Thinking";
			break;
		case "writing":
			detail = "Writing a response";
			break;
		case "preparing_tool":
			detail = activity.toolName === undefined ? "Preparing a tool" : `Preparing ${activity.toolName}`;
			break;
		case "finalizing":
			detail = "Finalizing";
			break;
		case "running_tools":
			detail = activity.toolName === undefined ? "Running a tool" : `Running ${activity.toolName}`;
			break;
		case "starting":
			detail = "Starting worker";
			break;
		default:
			detail = "Worker reported progress";
	}
	return `Status:    ● ${detail} · last event ${updateAge}`;
}

/**
 * Builds the live body of the widget.
 *
 * Kept pure and exported so the content is testable without a TUI, which is the
 * same split Gate A and Gate B use.
 */
export function formatRunningLines(
	view: RunningWidgetView,
	state: { elapsedMs: number; progress: RunProgress | undefined; stopping: boolean },
	width = Number.POSITIVE_INFINITY,
	definitionOfDoneItems = MIN_WIDGET_DEFINITION_OF_DONE_ITEMS,
): string[] {
	const usage = state.progress?.usage;
	const lines = [
		...formatRunningHeaderLines(view, width, definitionOfDoneItems),
		formatWorkerStatusLine({ ...state, noProgressThresholdMs: view.noProgressThresholdMs }),
		`Elapsed:   ${formatElapsed(state.elapsedMs)}`,
		`Turns:     ${usage === undefined ? 0 : usage.turns}`,
		`Tokens:    ${usage === undefined ? "none yet" : formatTokenSummary(usage)}`,
		`Context:   ${usage === undefined ? "none yet" : formatTokenCount(usage.contextTokens)}`,
		`Cost:      ${usage === undefined ? "not reported" : formatCost(usage.cost)}`,
	];

	const toolResults = state.progress?.toolResults ?? [];
	if (toolResults.length > 0) {
		const recent = toolResults.slice(-RECENT_TOOL_CALLS);
		lines.push("", `Recent tool calls (${toolResults.length} total):`, ...recent.map(toolCallLine));
	}

	lines.push("");
	lines.push(
		state.stopping
			? "Stopping the worker…"
			: state.progress?.activity?.kind === "stalled"
				? "esc  stop the worker · or keep waiting"
				: "esc  stop the worker",
	);

	// Tool names originate outside the extension and can be arbitrarily long. Every
	// body line therefore needs the same visible-width cap as the metadata header:
	// otherwise one long name wraps, consumes the abort hint's reserved row, and
	// defeats the widget's fixed-height budget.
	const maximum = Math.max(1, Math.floor(width));
	return lines.map((line) => truncateToWidth(line, maximum, "…"));
}

/** A running widget with the handles the run flow drives it through. */
/** True when a key means "stop the running worker". */
export function isAbortKey(data: string): boolean {
	// Parsed matching recognizes both the legacy Escape byte and Kitty's `\x1b[27u`
	// encoding, rather than leaving the advertised key inert in Kitty terminals.
	return matchesKey(data, Key.escape);
}

export interface RunningWidget extends Container {
	/** Applies a progress event and repaints. */
	update(progress: RunProgress): void;
	/** Switches to the stopping state, shown until the child actually exits. */
	markStopping(): void;
	/** Stops the repaint timer. Called by Pi when the overlay closes. */
	dispose(): void;
	/** Escape requests the worker's death; other keys are ignored. */
	handleInput(data: string): void;
}

/**
 * Builds the widget component.
 *
 * `onAbort` is invoked on Escape and is expected to request the worker's death;
 * it deliberately does not resolve the overlay.
 */
export function createRunningWidget(
	tui: TUI,
	theme: Theme,
	view: RunningWidgetView,
	options: { nowMs: () => number; startedAtMs: number; onAbort: () => void },
): RunningWidget {
	const container = new Container() as RunningWidget;
	const title = new Text("", 1, 0);
	const body = new Text("", WIDGET_BODY_PADDING_X, 0);
	container.addChild(title);
	container.addChild(new Spacer(1));
	container.addChild(body);

	let progress: RunProgress | undefined;
	let stopping = false;
	let pulseIndex = 0;

	/** Chooses a theme token for the pulse without using status colors for ordinary work. */
	const indicator = () => {
		const frame = STATUS_INDICATOR_FRAMES[pulseIndex % STATUS_INDICATOR_FRAMES.length] ?? "●";
		if (frame === "·") return theme.fg("dim", frame);
		if (frame === "•") return theme.fg("muted", frame);
		if (pulseIndex % STATUS_INDICATOR_FRAMES.length === 3) return theme.bold(frame);
		return theme.fg("accent", frame);
	};

	/** Repaints the body from current state and asks the TUI to draw it. */
	const repaint = () => {
		const state = {
			elapsedMs: options.nowMs() - options.startedAtMs,
			progress,
			stopping,
		};
		const lines = formatRunningLines(
			view,
			state,
			bodyContentWidth(tui.terminal.columns),
			definitionOfDoneLimit(tui.terminal.rows),
		);
		title.setText(`${indicator()} ${theme.fg("text", theme.bold("Worker running"))}`);
		body.setText(
			lines
				.map((line) => {
					if (!line.startsWith("Status:    ")) return theme.fg(line.startsWith("  ") ? "dim" : "text", line);
					const detail = line.slice("Status:    ".length);
					const token = stopping || detail.startsWith("◌") ? "warning" : "accent";
					return `${theme.fg("muted", "Status:    ")}${theme.fg(token, detail.slice(0, 1))}${theme.fg("text", detail.slice(1))}`;
				})
				.join("\n"),
		);
		tui.requestRender();
	};

	// The pulse keeps the worker visibly alive even while it has no new JSON events;
	// the status row separately says exactly how long it has been since the last one.
	const timer = setInterval(() => {
		pulseIndex += 1;
		repaint();
	}, TICK_INTERVAL_MS);

	container.update = (next: RunProgress) => {
		progress = next;
		repaint();
	};

	container.markStopping = () => {
		stopping = true;
		repaint();
	};

	container.dispose = () => {
		clearInterval(timer);
	};

	container.handleInput = (data: string) => {
		if (!isAbortKey(data) || stopping) return;
		// Requests the kill; the run's completion closes the overlay.
		options.onAbort();
		container.markStopping();
	};

	repaint();
	return container;
}

/** Distinguishes a completed run from a widget that failed to render. */
export type RunningOutcome<T> = { kind: "completed"; value: T } | { kind: "failed"; detail: string };

/**
 * Runs an operation behind the live widget, forwarding progress into it.
 *
 * A rejection is reported as a failure rather than converted into a cancellation.
 * T7's `withLoader` maps a rejection to an abort, which makes a genuine bug inside
 * the overlay indistinguishable from the user pressing Escape; here the worker's
 * own abort is already represented in the run outcome, so a rejection is only ever
 * a defect and is surfaced as one.
 */
export async function runWithWidget<T>(
	ctx: ExtensionContext,
	view: RunningWidgetView,
	options: { nowMs: () => number; onAbort: () => void },
	operation: (onProgress: (progress: RunProgress) => void) => Promise<T>,
): Promise<RunningOutcome<T>> {
	return ctx.ui.custom<RunningOutcome<T>>((tui, theme, _keybindings, done) => {
		const widget = createRunningWidget(tui, theme, view, {
			nowMs: options.nowMs,
			startedAtMs: options.nowMs(),
			onAbort: options.onAbort,
		});

		operation((progress) => widget.update(progress))
			.then((value) => done({ kind: "completed", value }))
			.catch((error: unknown) => {
				done({ kind: "failed", detail: error instanceof Error ? error.message : String(error) });
			});

		return widget;
	});
}
