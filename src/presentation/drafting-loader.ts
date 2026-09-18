/**
 * The loader shown while the drafting side-call runs.
 *
 * This exists so the drafting call is cancellable: `CancellableLoader` owns an
 * abort signal, and the reference extension's pattern is to pass that signal into
 * `complete()` and resolve the overlay from `onAbort`. The stock `BorderedLoader`
 * does not expose a message updater, so this equivalent shell owns its inner loader
 * directly. That lets elapsed time advance without changing cancellation behavior.
 */

import {
	CancellableLoader,
	Container,
	Spacer,
	Text,
	truncateToWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { formatElapsed } from "../domain/report/format.ts";

/** How often elapsed time is refreshed while the drafting model is quiet. */
const TICK_INTERVAL_MS = 1_000;

/** Horizontal padding added by the inner loader's Text component. */
const LOADER_BODY_PADDING_X = 1;

/** Result of a loader-wrapped operation, distinguishing an abort from a value. */
export type LoaderOutcome<T> = { kind: "completed"; value: T } | { kind: "aborted" };

export interface DraftingLoaderMessage {
	/** The existing action text, for example "Drafting handoff…". */
	message: string;
	/** Milliseconds since the drafting side-call began. */
	elapsedMs: number;
	/** The selected reviewing-session model that performs the side-call, when known. */
	model?: string;
}

/** Returns the width available to the loader text after its horizontal padding. */
function loaderContentWidth(terminalWidth: number): number {
	return Math.max(1, Math.floor(terminalWidth) - LOADER_BODY_PADDING_X * 2);
}

/** A width-aware horizontal rule matching the stock bordered-loader shell. */
class HorizontalRule implements Component {
	private readonly color: (text: string) => string;

	constructor(color: (text: string) => string) {
		this.color = color;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, Math.floor(width))))];
	}
}

/** A cancellable, bordered loader whose text can be updated after construction. */
class DraftingLoader extends Container {
	private readonly loader: CancellableLoader;

	constructor(tui: TUI, theme: Theme, message: string) {
		super();
		const border = (text: string) => theme.fg("border", text);
		this.loader = new CancellableLoader(
			tui,
			(text) => theme.fg("accent", text),
			(text) => theme.fg("muted", text),
			message,
		);
		this.addChild(new HorizontalRule(border));
		this.addChild(this.loader);
		this.addChild(new Spacer(1));
		this.addChild(new Text("esc  cancel", 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new HorizontalRule(border));
	}

	get signal(): AbortSignal {
		return this.loader.signal;
	}

	set onAbort(callback: (() => void) | undefined) {
		if (callback === undefined) delete this.loader.onAbort;
		else this.loader.onAbort = callback;
	}

	setMessage(message: string): void {
		this.loader.setMessage(message);
	}

	handleInput(data: string): void {
		this.loader.handleInput(data);
	}

	dispose(): void {
		this.loader.dispose();
	}
}

/**
 * Formats the live drafting-loader text without depending on the TUI.
 *
 * `width` is the loader's available content width. The model can be provider/model
 * rather than a worker-style choice because the side-call is bound directly to the
 * reviewing session's current model and has no separate thinking selection.
 */
export function formatDraftingLoaderMessage(view: DraftingLoaderMessage, width = Number.POSITIVE_INFINITY): string {
	const details = [`Elapsed: ${formatElapsed(view.elapsedMs)}`];
	if (view.model !== undefined && view.model !== "") details.push(`Model: ${view.model}`);
	return truncateToWidth(`${view.message} · ${details.join(" · ")}`, Math.max(1, Math.floor(width)), "…");
}

/**
 * Runs an operation behind a cancellable, live-updating bordered loader.
 *
 * A rejection is converted to an abort rather than propagated, because a failure
 * inside the overlay would otherwise leave the TUI holding a component with no
 * resolution path. Callers see an ordinary aborted outcome and report it.
 */
export async function withLoader<T>(
	ctx: ExtensionContext,
	message: string,
	operation: (signal: AbortSignal) => Promise<T>,
	model?: string,
): Promise<LoaderOutcome<T>> {
	return ctx.ui.custom<LoaderOutcome<T>>((tui, theme, _keybindings, done) => {
		const startedAtMs = Date.now();
		const formatMessage = (elapsedMs: number) =>
			formatDraftingLoaderMessage(
				{ message, elapsedMs, ...(model === undefined ? {} : { model }) },
				loaderContentWidth(tui.terminal.columns),
			);
		const loader = new DraftingLoader(tui, theme, formatMessage(0));
		let settled = false;
		const timer = setInterval(() => {
			loader.setMessage(formatMessage(Date.now() - startedAtMs));
		}, TICK_INTERVAL_MS);

		const finish = (outcome: LoaderOutcome<T>) => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			done(outcome);
		};

		loader.onAbort = () => finish({ kind: "aborted" });
		operation(loader.signal)
			.then((value) => finish({ kind: "completed", value }))
			.catch(() => finish({ kind: "aborted" }));

		return loader;
	});
}
