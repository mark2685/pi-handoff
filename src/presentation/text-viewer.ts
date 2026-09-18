/**
 * A read-only scrollable viewer for text a gate can only preview.
 *
 * Every gate in this package shows a bounded preview: Gate A truncates the prompt
 * to twelve lines, Gate B truncates the report to twenty-four and the diffstat to
 * twelve. Those bounds exist because the gates do not scroll, and they were the
 * reason a user sat at Gate A for up to twenty-eight minutes deciding whether to
 * approve a hundred-line prompt they could only see the head of. The remedy is not
 * bigger previews — a gate that fills the screen hides its own options — but a
 * separate surface that shows the whole text and gives it back.
 *
 * Split the same way as the gates. `windowLines` is pure and owns scrolling
 * arithmetic and the status line, so paging, clamping, and the end-of-content
 * behavior are unit-tested without a TUI. The component around it renders a window
 * and translates keys.
 *
 * Two mechanics are load-bearing. Windowing is measured in **rendered rows, not
 * logical lines**: this viewer exists for prompts written as unwrapped paragraphs
 * and report bullets, which routinely occupy three or four rows each, and a window
 * counted in logical lines overflowed the terminal and pushed its own heading off
 * the screen. The measurement therefore happens inside `render(width)`, where the
 * real width is known, rather than against a width guessed beforehand. Paging
 * follows from that: a page down moves to the first line **past the rendered
 * window** rather than by a row count, because rows and lines are not
 * interchangeable in either direction — applying a nineteen-row page to a screen
 * holding five wrapped lines skipped the fourteen in between. And keys are
 * matched with pi-tui's `matchesKey` rather than by comparing raw bytes, because
 * under the Kitty keyboard protocol — Ghostty, WezTerm, Kitty — plain Escape
 * arrives as `\x1b[27u` and a byte comparison silently never fires, leaving the
 * footer advertising a key that does nothing.
 *
 * Read-only on purpose. `ctx.ui.editor` was the previous stand-in for this (the
 * NEEDS INPUT gate's View full draft used it, titled "read-only; edits are
 * discarded"), which asks the user to type into a buffer whose changes are thrown
 * away — a surface that lies about what it does. This viewer cannot edit, so it
 * cannot mislead.
 */

import { type Component, Key, matchesKey, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

/** Rows reserved for the title, its blank line, and the footer hint. */
const CHROME_ROWS = 3;

/** Viewport height assumed when the terminal reports an implausible size. */
const FALLBACK_VIEWPORT_ROWS = 20;

/** Smallest viewport worth rendering, so arithmetic cannot reach zero or negative. */
const MIN_VIEWPORT_ROWS = 3;

/** Horizontal padding applied to every rendered row, matching the gates' one column. */
const PADDING_X = 1;

/** Width assumed when the TUI reports an implausible one, so wrapping stays sane. */
const FALLBACK_WIDTH = 80;

/** One rendered window of a long text, plus the status line describing the position. */
export interface TextWindow {
	/** The visible slice, already clamped to the content. */
	lines: string[];
	/** The clamped offset actually used, which may differ from the requested one. */
	offset: number;
	/** `Lines 21-40 of 165` style position, or a whole-content note when it all fits. */
	status: string;
	/**
	 * The offset one page forward: the first line past this window.
	 *
	 * Exposed rather than left to the caller as an arithmetic guess because only this
	 * function knows how many lines the window actually held. A page-down computed as a
	 * row count applied to a line offset skipped content: nineteen rows of wrapped
	 * paragraphs is five or six lines, so `offset + rows` jumped past everything in
	 * between.
	 */
	nextOffset: number;
	/** The offset one page back, found by filling a viewport backwards from this window. */
	previousOffset: number;
}

/**
 * How many rendered rows a logical line occupies. Defaults to one row per line.
 *
 * Injected rather than computed here so `windowLines` stays pure and free of any
 * terminal knowledge, while the component can supply real wrapped heights.
 */
export type MeasureRows = (line: string, index: number) => number;

/** The height of every line, so the arithmetic below can index it repeatedly. */
function measureAll(lines: readonly string[], measure: MeasureRows | undefined): number[] {
	if (measure === undefined) return lines.map(() => 1);
	return lines.map((line, index) => Math.max(1, Math.trunc(measure(line, index))));
}

/**
 * The smallest offset whose window still reaches the last line.
 *
 * Found by walking backwards from the end and accumulating heights, because with
 * variable row heights the last window's size is not a fixed number of lines:
 * ten one-row lines and three four-row lines both fill ten rows. Anchoring the
 * final window this way is what keeps a page-down at the bottom from leaving a
 * screen half full of blank rows past the final line.
 */
function maxOffsetFor(heights: readonly number[], viewportRows: number): number {
	let rows = 0;
	let offset = heights.length;
	for (let index = heights.length - 1; index >= 0; index -= 1) {
		const height = heights[index] ?? 1;
		if (rows + height > viewportRows && rows > 0) break;
		rows += height;
		offset = index;
	}
	// A single line taller than the viewport still has to be reachable.
	return Math.min(offset, Math.max(0, heights.length - 1));
}

/**
 * The offset a page-up from `end` lands on: fills a viewport backwards from it.
 *
 * The same walk as `maxOffsetFor`, which is the point — a page back has to be the
 * inverse of the window that a page forward would render, or paging up and down
 * over the same boundary drifts. Always retreats by at least one line, so a single
 * line taller than the viewport cannot trap the scroll.
 */
function pageUpOffsetFrom(heights: readonly number[], end: number, viewportRows: number): number {
	let rows = 0;
	let offset = end;
	for (let index = end - 1; index >= 0; index -= 1) {
		const height = heights[index] ?? 1;
		if (rows + height > viewportRows && rows > 0) break;
		rows += height;
		offset = index;
	}
	return Math.min(offset, Math.max(0, end - 1));
}

/**
 * Slices a window of lines that fits a viewport and describes the position.
 *
 * Clamps rather than rejects an out-of-range offset, because scroll input arrives
 * as unbounded key repeats and the caller should not have to pre-check each one.
 * A short text is reported as complete instead of as "lines 1-3 of 3", so the
 * viewer never implies there is more to see when there is not.
 *
 * `viewportRows` counts terminal rows. With no `measure` every line is one row and
 * this reduces to plain line windowing; with one, a wrapped line consumes the rows
 * it actually paints, so the window never overflows the screen it was sized for.
 * The status line stays in logical lines, since those are what the text's own
 * numbering means to a reader.
 */
export function windowLines(
	lines: readonly string[],
	offset: number,
	viewportRows: number,
	measure?: MeasureRows,
): TextWindow {
	const height = Math.max(MIN_VIEWPORT_ROWS, Math.trunc(viewportRows));
	const heights = measureAll(lines, measure);
	const total = lines.length;
	const totalRows = heights.reduce((sum, rows) => sum + rows, 0);

	if (totalRows <= height) {
		return {
			lines: [...lines],
			offset: 0,
			status: total === 1 ? "1 line" : `${total} lines`,
			nextOffset: 0,
			previousOffset: 0,
		};
	}

	const maxOffset = maxOffsetFor(heights, height);
	const clamped = Math.min(Math.max(Math.trunc(offset), 0), maxOffset);

	// Take lines until the next one would not fit, so the window is bounded by rows
	// rather than by a count that ignores wrapping.
	let rows = 0;
	let end = clamped;
	while (end < total) {
		const lineRows = heights[end] ?? 1;
		if (rows + lineRows > height && end > clamped) break;
		rows += lineRows;
		end += 1;
	}

	return {
		lines: lines.slice(clamped, end),
		offset: clamped,
		status: `Lines ${clamped + 1}-${end} of ${total}${clamped === maxOffset ? " (end)" : ""}`,
		// The next window starts where this one ended, so nothing between them is skipped;
		// clamping is left to the next call, which is where the content bound lives.
		nextOffset: end,
		previousOffset: pageUpOffsetFrom(heights, clamped, height),
	};
}

/** Reads a usable viewport height from the terminal, tolerating an unreported size. */
function viewportRowsFor(tui: TUI): number {
	const rows = tui.terminal?.rows;
	if (typeof rows !== "number" || !Number.isFinite(rows) || rows <= 0) return FALLBACK_VIEWPORT_ROWS;
	return Math.max(MIN_VIEWPORT_ROWS, rows - CHROME_ROWS);
}

/**
 * A read-only viewer component that windows its content by rendered rows.
 *
 * Windowing lives in `render(width)` rather than in a `setText` repaint because
 * the width is only known here. Sizing a window against a guessed width is what
 * made the previous version overflow: it counted logical lines, and the wrapped
 * paragraphs this viewer exists to show occupy several rows each.
 */
export interface TextViewer extends Component {
	/** Scrolls by a delta in logical lines; clamping is `windowLines`' job. */
	scrollBy(delta: number): void;
	/** Jumps to the top or the bottom. */
	scrollTo(offset: number): void;
}

/** Builds the viewer component for a title and the already-split lines. */
export function createTextViewer(tui: TUI, theme: Theme, title: string, lines: readonly string[]): TextViewer {
	let offset = 0;
	/**
	 * The window the last `render` produced, which is what a page key navigates by.
	 *
	 * Paging needs the boundaries of the window actually on screen, and only `render`
	 * knows them, because only it knows the width the lines wrapped at. Reconstructing
	 * them in the key handler is what produced the skipping: it applied a row count as
	 * a line delta, so a screen holding five wrapped lines advanced nineteen.
	 */
	let rendered: TextWindow | undefined;

	/** Wrapped height of one line at the content width, mirroring `Text`'s own wrapping. */
	const heightAt = (contentWidth: number) => (line: string) => wrapTextWithAnsi(line, contentWidth).length;

	const viewer: TextViewer = {
		render(width: number): string[] {
			const usable = Number.isFinite(width) && width > 0 ? Math.trunc(width) : FALLBACK_WIDTH;
			// Mirrors `Text`'s padding arithmetic so a measured height matches a painted one.
			const paddingX = Math.min(PADDING_X, Math.max(0, Math.floor((usable - 1) / 2)));
			const contentWidth = Math.max(1, usable - paddingX * 2);
			const margin = " ".repeat(paddingX);

			const window = windowLines(lines, offset, viewportRowsFor(tui), heightAt(contentWidth));
			offset = window.offset;
			rendered = window;

			const footer = `${window.status}   \u2191\u2193 pgup/pgdn home/end scroll   esc close`;
			const rows: string[] = [];

			/** Pads a rendered row to the full width, as `Text` does, so the theme's background is even. */
			const push = (text: string) => {
				for (const wrapped of wrapTextWithAnsi(text, contentWidth)) {
					const line = margin + wrapped + margin;
					rows.push(line + " ".repeat(Math.max(0, usable - visibleWidth(line))));
				}
			};

			push(theme.fg("accent", theme.bold(title)));
			rows.push(" ".repeat(usable));
			for (const line of window.lines) push(theme.fg("text", line));
			push(theme.fg("dim", footer));

			return rows;
		},

		invalidate(): void {
			// No cached rendering: `render` recomputes the window every pass, which is what
			// lets a resize be honored without an explicit resize hook.
		},

		scrollBy(delta: number): void {
			offset += delta;
			tui.requestRender();
		},

		scrollTo(next: number): void {
			offset = next;
			tui.requestRender();
		},

		handleInput(data: string): void {
			// Paging uses the rendered window's own boundaries rather than a row delta: a page
			// down starts at the first line past the window, so nothing between two screens is
			// skipped, and a page up fills a viewport backwards from the current top. Before the
			// first render there is no window to page by, so a page key falls back to a single
			// line, which is always safe.
			const window = rendered;

			if (matchesKey(data, Key.up)) return viewer.scrollBy(-1);
			if (matchesKey(data, Key.down)) return viewer.scrollBy(1);
			if (matchesKey(data, Key.pageUp))
				return viewer.scrollTo(window === undefined ? offset - 1 : window.previousOffset);
			if (matchesKey(data, Key.pageDown)) return viewer.scrollTo(window === undefined ? offset + 1 : window.nextOffset);
			if (matchesKey(data, Key.home)) return viewer.scrollTo(0);
			if (matchesKey(data, Key.end)) return viewer.scrollTo(lines.length);
		},
	};

	return viewer;
}

/** True when a key means "close this read-only surface". */
export function closesViewer(data: string): boolean {
	// Escape, Enter, and `q` all close: a user arriving from a select list has all
	// three in muscle memory, and on a read-only surface none of them can mean
	// anything else. Matched through `matchesKey` so the Kitty protocol's `\x1b[27u`
	// Escape is recognized rather than silently ignored.
	return matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, "q");
}

/**
 * Shows text read-only and scrollable, resolving when the user closes it.
 *
 * Resolves void: there is nothing to decide here, so the caller re-renders the
 * gate it came from.
 */
export async function openTextViewer(ctx: ExtensionContext, title: string, text: string): Promise<void> {
	const lines = text.replace(/\s+$/, "").split("\n");

	await ctx.ui.custom<void>((tui: TUI, theme: Theme, _keybindings, done) => {
		const viewer = createTextViewer(tui, theme, title, lines);
		const scroll = viewer.handleInput?.bind(viewer);

		return {
			...viewer,
			handleInput(data: string): void {
				// Close is checked first and by key identity rather than by byte prefix. The old
				// version tested `data === "\x1b"` last, because escape is a prefix of every
				// arrow and page sequence; `matchesKey` compares parsed keys, so the ordering
				// hazard is gone and a scroll key cannot be mistaken for a close.
				if (closesViewer(data)) {
					done(undefined);
					return;
				}
				scroll?.(data);
			},
		};
	});
}
