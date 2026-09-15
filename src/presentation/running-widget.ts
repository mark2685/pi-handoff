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

import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { formatModelChoice } from "../domain/draft/launch.ts";
import { formatCost, formatElapsed, formatTokenCount, formatTokenSummary } from "../domain/report/format.ts";
import type { ModelChoice } from "../domain/types.ts";
import type { RunProgress } from "../app/run-service.ts";

/** How many recent tool calls the widget lists. */
const RECENT_TOOL_CALLS = 5;

/** How often the elapsed-time line is refreshed while the worker is quiet. */
const TICK_INTERVAL_MS = 1_000;

/** Escape, which is the abort key throughout Pi's cancellable surfaces. */
const ESCAPE = "\x1b";

export interface RunningWidgetView {
	slug: string;
	choice: ModelChoice;
	promptPath: string;
}

/** Formats the fixed header lines, which do not change while the worker runs. */
function headerLines(view: RunningWidgetView): string[] {
	return [`Handoff:   ${view.slug}`, `Model:     ${formatModelChoice(view.choice)}`, `Prompt:    ${view.promptPath}`];
}

/** Formats one tool call for the recent-activity list. */
function toolCallLine(result: { toolName: string; isError: boolean }): string {
	return `  ${result.isError ? "✗" : "✓"} ${result.toolName}`;
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
): string[] {
	const usage = state.progress?.usage;
	const lines = [
		...headerLines(view),
		"",
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
	lines.push(state.stopping ? "Stopping the worker…" : "esc  stop the worker");
	return lines;
}

/** A running widget with the handles the run flow drives it through. */
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
	const title = new Text(theme.fg("accent", theme.bold("Worker running")), 1, 0);
	const body = new Text("", 1, 0);
	container.addChild(title);
	container.addChild(new Spacer(1));
	container.addChild(body);

	let progress: RunProgress | undefined;
	let stopping = false;

	/** Repaints the body from current state and asks the TUI to draw it. */
	const repaint = () => {
		const lines = formatRunningLines(view, {
			elapsedMs: options.nowMs() - options.startedAtMs,
			progress,
			stopping,
		});
		body.setText(lines.map((line) => theme.fg(line.startsWith("  ") ? "dim" : "text", line)).join("\n"));
		tui.requestRender();
	};

	// The timer keeps elapsed time moving while the worker produces no events.
	const timer = setInterval(repaint, TICK_INTERVAL_MS);

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
		if (data !== ESCAPE || stopping) return;
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
