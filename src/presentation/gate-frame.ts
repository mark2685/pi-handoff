/**
 * The gate frame: fits a gate's title, header, menu, and evidence blocks to the
 * terminal so that the menu is always on screen.
 *
 * Every gate in this package has the same shape — a title, a few lines of fixed
 * context, a menu of decisions, and one or more blocks of evidence (a prompt, a
 * report, a diffstat) that can be longer than the screen — and until this module
 * existed each gate assembled that shape itself from `Text` and `Spacer` children and
 * guessed at its own height with hand-counted constants. The guess was in source
 * lines, but the terminal paints rows: a worker report written as unwrapped
 * paragraphs renders three or four rows per line, so an 18-line "preview" painted
 * 45 rows, and in Pi's fullscreen layout a component taller than its dock is clipped
 * from the bottom — exactly where the menu was. Across 238 real result gates from
 * recorded sessions, 82% overflowed a 120×50 terminal with the budget active, and the
 * user pressed Enter on a menu they could not see (ADR-0001).
 *
 * Two mechanics are load-bearing, both borrowed from the text viewer (§5.8):
 *
 *  - **Fitting happens in `render(width)`**, where the real width is known, and is
 *    measured in rendered rows with pi-tui's own `wrapTextWithAnsi`. Every row the
 *    frame paints — headings, signposts, the hidden-blocks line included — goes
 *    through that wrap, because pi-tui's main-screen renderer throws on a row wider
 *    than the terminal and its alternate screen clips one silently. Nothing here
 *    counts source lines except to word a signpost.
 *  - **The menu and hint are invariant.** Blocks shrink in priority order to a floor,
 *    then disappear behind a hidden-blocks line; then the header is cut from the bottom. The menu
 *    is never cut, so a gate can be ugly on a tiny terminal but it cannot be
 *    undecidable.
 *
 * The frame knows nothing about handoffs. A gate module builds a `GateSpec` — pure,
 * unit-tested — and the frame renders it. A block names its viewer by **menu option
 * id**, never by label: the signpost's wording is looked up in the menu actually
 * offered, so it cannot name an option the gate does not render. The result gate's
 * viewer-omission rule ("do not offer a viewer for text the gate already shows in
 * full") is served by `resolveMenu`, which is re-run whenever a fit changes which
 * blocks are shortened — at construction, and again after a resize — so a block cut
 * by a smaller terminal gets its viewer back. Each resolution converges in a few
 * steps: offering a viewer adds a menu row, which can only shorten more blocks, which
 * can only add viewers.
 */

import {
	SelectList,
	type Component,
	type SelectItem,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { MenuOption } from "./menus.ts";

/**
 * Rows kept free below the gate for the fullscreen dock's other occupants.
 *
 * A component cannot learn the height it was allocated — `render(width)` receives only
 * a width — so the frame budgets against the terminal and leaves room for what shares
 * the dock with it: the transcript's one-row minimum, Pi's stock footer (two rows: the
 * working directory line and the usage line; a footer extension may use more), and one
 * row of slack. 1 + 2 + 1 = 4.
 */
export const DOCK_RESERVED_ROWS = 4;

/**
 * Fewest rows a shortened block's body may occupy: two rows of text and the signpost.
 *
 * Below this a block identifies nothing; the frame hides it instead and says so.
 */
export const MIN_BLOCK_BODY_ROWS = 3;

/** Rows assumed when the terminal reports no usable height. */
const FALLBACK_ROWS = 24;

/** Width assumed when the TUI reports an implausible one. */
const FALLBACK_WIDTH = 80;

/** Horizontal padding on every row, matching the one column `Text` used to add. */
const PADDING_X = 1;

/** Bound on menu re-resolution per fit; it converges well before this. */
const MAX_MENU_RESOLUTION_STEPS = 8;

/** One shrinkable block of evidence. */
export interface GateBlock<Id extends string = string> {
	/** Stable id, reported back when the block had to be shortened or hidden. */
	id: string;
	/** Short noun for the hidden-blocks line, e.g. "report" or "prompt preview". */
	label: string;
	/** Heading row above the text, e.g. "Worker report:". Omitted when undefined. */
	heading?: string;
	/** The text, split on newlines; a blank or whitespace-only text is not shown. */
	text: string;
	/**
	 * The id of the menu option that shows the whole text.
	 *
	 * An id, not a label: the signpost looks the label up in the menu being offered, so
	 * it can never name an option the gate does not render, and rewording a menu entry
	 * cannot silently break the signpost that points at it.
	 */
	viewerOption?: Id;
}

/** Tone for a header line, so a frame can colour a warning without knowing what it says. */
export type LineTone = "text" | "dim" | "warning";

/** Everything a gate says and offers; the frame decides only how much of it fits. */
export interface GateSpec<Id extends string> {
	title: string;
	/** Title colour; warning for a gate that exists because something went wrong. */
	tone?: "accent" | "warning";
	/** Fixed lines above the menu; "" is a blank row. Cut only when even the menu would not fit. */
	header: readonly string[];
	/** Optional per-line tone for the header. Defaults to "text". */
	headerTone?: (line: string) => LineTone;
	menu: readonly MenuOption<Id>[];
	/**
	 * Recomputes the menu from the blocks a fit shortened or hid.
	 *
	 * Called at construction and again whenever a refit changes that set, so a block
	 * cut after a resize gets its viewer offered. The result gate uses it to drop a
	 * viewer whose text the gate already shows in full.
	 */
	resolveMenu?: (shortened: ReadonlySet<string>) => readonly MenuOption<Id>[];
	/** Evidence in priority order: the first block is the last to shrink and the first to grow. */
	blocks: readonly GateBlock<Id>[];
	/** Footer hint, e.g. "↑↓ navigate   enter select   esc cancel". */
	hint: string;
}

/** Wraps one logical line into the rows it paints at the current width. */
export type Wrap = (line: string) => string[];

/** One block after fitting. */
export interface FittedBlock {
	id: string;
	heading?: string;
	/** The heading as painted, wrapped. Empty when there is no heading. */
	headingRows: string[];
	/** Rendered rows of the body, already wrapped. */
	rows: string[];
	/**
	 * Present when the body was cut; names how much is hidden and where to read it.
	 *
	 * Always the text that is painted: at a very narrow width the signpost may be cut to
	 * fit the block's allocation, and this field is cut with it, so a consumer reading
	 * the text can never see more than the screen does.
	 */
	signpost?: string;
	/** The signpost as painted, wrapped; `signpost` is these rows joined. Empty when the body was not cut. */
	signpostRows: string[];
	shortened: boolean;
}

/** The rows a gate will paint, and which evidence had to give way. */
export interface GateLayout {
	titleRows: string[];
	headerRows: string[];
	/** How many of the spec's header lines survived; fewer than all when the menu would not otherwise fit. */
	headerLinesKept: number;
	/** Present when header lines were dropped to keep the menu on screen; never cut, so `headerSignpostRows` is its wrap. */
	headerSignpost?: string;
	headerSignpostRows: string[];
	menuRows: number;
	blocks: FittedBlock[];
	/**
	 * Present when one or more blocks did not fit at all: the hidden-blocks line, a dim
	 * row inside the gate. Not a notice in the glossary's sense — there is nothing to dismiss.
	 */
	hiddenBlocksLine?: string;
	/** The line as painted, wrapped; never cut, so this is `hiddenBlocksLine`'s wrap. */
	hiddenBlocksLineRows: string[];
	hintRows: string[];
	/** Total rows the layout paints, including blank separators. */
	rows: number;
	/** Ids of blocks that were shortened or hidden, for `resolveMenu`. */
	shortened: ReadonlySet<string>;
}

interface MeasuredBlock {
	block: GateBlock;
	lines: string[];
	/** Wrapped rows per source line, so the signpost can count lines not fully shown. */
	heights: number[];
	rows: string[];
	headingRows: string[];
	/** The viewer's label in the menu being offered, if that option is present. */
	viewerLabel: string | undefined;
	/** Blank separator plus the heading rows, if any. */
	overhead: number;
	allocated: number;
	visible: boolean;
}

/** Wraps header lines, treating "" as one blank row rather than zero rows. */
function wrapAll(lines: readonly string[], wrap: Wrap): string[] {
	return lines.flatMap((line) => (line === "" ? [""] : wrap(line)));
}

/** Counts source lines whose every row is within the first `rows` rows. */
function fullyShownLines(heights: readonly number[], rows: number): number {
	let used = 0;
	let shown = 0;
	for (const height of heights) {
		if (used + height > rows) break;
		used += height;
		shown += 1;
	}
	return shown;
}

function signpostFor(hidden: number, viewerLabel: string | undefined): string {
	const hint = viewerLabel === undefined ? "" : ` — choose "${viewerLabel}" to read all of it`;
	return `… ${hidden} more line${hidden === 1 ? "" : "s"}${hint}`;
}

/**
 * Words the hidden-blocks line for blocks that did not fit at all.
 *
 * Mentions the viewers only when a hidden block actually has one in the menu; the
 * questions gate's block and the result gate's findings have none, and pointing a
 * user at viewers that do not exist is the dead end this frame exists to prevent.
 */
function hiddenBlocksLineFor(labels: readonly string[], anyViewer: boolean): string {
	const route = anyViewer ? "enlarge the terminal or use the viewers in the menu" : "enlarge the terminal to read them";
	return `… ${labels.join(", ")} not shown — ${route}`;
}

/**
 * Fits a gate into `rows` terminal rows.
 *
 * Pure: the caller supplies the wrap function, so tests can use pi-tui's real wrapping
 * at any width and the component can use the width `render` was given. The layout is
 * title, blank, header, blank, menu, then each visible block as blank, heading, body,
 * then blank and hint. The menu is passed in whole rather than as a row count because
 * `SelectList` paints exactly one row per option and owns its own truncation, and
 * because the signposts take their viewer labels from it.
 */
export function fitGate<Id extends string>(
	spec: Pick<GateSpec<Id>, "title" | "header" | "blocks" | "hint">,
	menu: readonly MenuOption<Id>[],
	rows: number,
	wrap: Wrap,
): GateLayout {
	const budget = Math.max(1, Math.trunc(rows));
	const menuRows = menu.length;
	const titleRows = wrap(spec.title);
	const hintRows = wrap(spec.hint);
	let headerLines = [...spec.header];
	let headerRows = wrapAll(headerLines, wrap);
	let headerSignpost: string | undefined;
	let headerSignpostRows: string[] = [];

	const measured: MeasuredBlock[] = spec.blocks
		.filter((block) => block.text.trim() !== "")
		.map((block) => {
			const lines = block.text.replace(/\s+$/, "").split("\n");
			const wrapped = lines.map((line) => (line === "" ? [""] : wrap(line)));
			const headingRows = block.heading === undefined ? [] : wrap(block.heading);
			return {
				block,
				lines,
				heights: wrapped.map((part) => part.length),
				rows: wrapped.flat(),
				headingRows,
				viewerLabel:
					block.viewerOption === undefined ? undefined : menu.find((option) => option.id === block.viewerOption)?.label,
				overhead: 1 + headingRows.length,
				allocated: 0,
				visible: false,
			};
		});

	const fixedRows = () =>
		titleRows.length +
		1 +
		(headerRows.length === 0 ? 0 : headerRows.length + headerSignpostRows.length + 1) +
		menuRows +
		1 +
		hintRows.length;

	/** Wraps the hidden-blocks line for the given hidden blocks, so its real height is budgeted. */
	const lineFor = (hidden: readonly MeasuredBlock[]): { text: string; rows: string[] } => {
		const text = hiddenBlocksLineFor(
			hidden.map((entry) => entry.block.label),
			hidden.some((entry) => entry.viewerLabel !== undefined),
		);
		return { text, rows: wrap(text) };
	};

	// Give every block its floor in priority order; a block that cannot reach its floor
	// is hidden, and the hidden-blocks line itself needs a blank row plus its own rows.
	let remaining = budget - fixedRows();
	const allocate = () => {
		for (const entry of measured) {
			entry.allocated = 0;
			entry.visible = false;
		}
		let left = remaining;
		for (const entry of measured) {
			const floor = Math.min(entry.rows.length, MIN_BLOCK_BODY_ROWS);
			if (left >= entry.overhead + floor) {
				entry.visible = true;
				entry.allocated = floor;
				left -= entry.overhead + floor;
			}
		}
		let hidden = measured.filter((entry) => !entry.visible);
		let lineRows = hidden.length === 0 ? 0 : 1 + lineFor(hidden).rows.length;
		while (hidden.length > 0 && left < lineRows) {
			// Make room for the line by hiding the lowest-priority visible block.
			const victim = [...measured].reverse().find((entry) => entry.visible);
			if (victim === undefined) break;
			victim.visible = false;
			left += victim.overhead + victim.allocated;
			victim.allocated = 0;
			hidden = measured.filter((entry) => !entry.visible);
			lineRows = 1 + lineFor(hidden).rows.length;
		}
		// The line is dropped too when not even it fits; the menu still comes first.
		const line = hidden.length > 0 && left >= lineRows;
		if (line) left -= lineRows;
		for (const entry of measured) {
			if (!entry.visible) continue;
			const extra = Math.min(entry.rows.length - entry.allocated, Math.max(0, left));
			entry.allocated += extra;
			left -= extra;
		}
		return { hidden, line };
	};
	let { hidden, line } = allocate();

	// Even the fixed content may not fit; cut header lines from the bottom, keeping a
	// signpost, before letting the menu go off screen.
	while (remaining < 0 && headerLines.length > 0) {
		headerLines = headerLines.slice(0, -1);
		const dropped = spec.header.length - headerLines.length;
		headerSignpost = `… ${dropped} more line${dropped === 1 ? "" : "s"}`;
		headerSignpostRows = wrap(headerSignpost);
		headerRows = wrapAll(headerLines, wrap);
		remaining = budget - fixedRows();
		({ hidden, line } = allocate());
	}
	// A header cut to nothing gets no signpost either: there is no row to paint it on
	// (the menu and hint alone already overflow), and the title still names the gate.
	if (headerLines.length === 0) {
		headerSignpost = undefined;
		headerSignpostRows = [];
	}

	const shortened = new Set<string>();
	const blocks: FittedBlock[] = [];
	let painted = fixedRows();
	for (const entry of measured) {
		if (!entry.visible) {
			shortened.add(entry.block.id);
			continue;
		}
		const cut = entry.allocated < entry.rows.length;
		if (cut) shortened.add(entry.block.id);
		// A signpost usually takes one row, but at a narrow width it may wrap; the body
		// gives up whatever the signpost needs so the block stays within its allocation.
		let bodyRows = cut ? Math.max(1, entry.allocated - 1) : entry.allocated;
		let signpost: string | undefined;
		let signpostRows: string[] = [];
		if (cut) {
			signpost = signpostFor(entry.lines.length - fullyShownLines(entry.heights, bodyRows), entry.viewerLabel);
			signpostRows = wrap(signpost);
			if (signpostRows.length > 1) {
				bodyRows = Math.max(1, entry.allocated - signpostRows.length);
				signpost = signpostFor(entry.lines.length - fullyShownLines(entry.heights, bodyRows), entry.viewerLabel);
				signpostRows = wrap(signpost);
			}
			// At a very narrow width the signpost alone can exceed the allocation. Drop the
			// viewer hint first, then the tail of the count, so one body row always remains
			// and the block never paints more rows than it was given.
			if (1 + signpostRows.length > entry.allocated) {
				signpostRows = wrap(signpostFor(entry.lines.length - fullyShownLines(entry.heights, 1), undefined)).slice(
					0,
					Math.max(1, entry.allocated - 1),
				);
				// The text follows the rows, so the layout never reports a signpost it does not paint.
				signpost = signpostRows.join(" ");
				bodyRows = Math.max(1, entry.allocated - signpostRows.length);
			}
		}
		const fitted: FittedBlock = {
			id: entry.block.id,
			...(entry.block.heading === undefined ? {} : { heading: entry.block.heading }),
			headingRows: entry.headingRows,
			rows: entry.rows.slice(0, bodyRows),
			...(signpost === undefined ? {} : { signpost }),
			signpostRows,
			shortened: cut,
		};
		blocks.push(fitted);
		painted += entry.overhead + fitted.rows.length + signpostRows.length;
	}
	const hiddenBlocksLine = line ? lineFor(hidden) : undefined;
	if (hiddenBlocksLine !== undefined) painted += 1 + hiddenBlocksLine.rows.length;

	return {
		titleRows,
		headerRows,
		headerLinesKept: headerLines.length,
		...(headerSignpost === undefined ? {} : { headerSignpost }),
		headerSignpostRows,
		menuRows,
		blocks,
		...(hiddenBlocksLine === undefined ? {} : { hiddenBlocksLine: hiddenBlocksLine.text }),
		hiddenBlocksLineRows: hiddenBlocksLine?.rows ?? [],
		hintRows,
		rows: painted,
		shortened,
	};
}

/**
 * Fits a gate and settles its menu together.
 *
 * Starts from `spec.menu` and re-resolves until the menu stops changing: offering a
 * viewer adds a row, which can only shorten more blocks, which can only offer more
 * viewers, so the sequence is monotone and short. Pure, like `fitGate`.
 */
export function fitGateWithMenu<Id extends string>(
	spec: GateSpec<Id>,
	rows: number,
	wrap: Wrap,
): { layout: GateLayout; menu: readonly MenuOption<Id>[] } {
	let menu = spec.menu;
	let layout = fitGate(spec, menu, rows, wrap);
	if (spec.resolveMenu === undefined) return { layout, menu };
	for (let step = 0; step < MAX_MENU_RESOLUTION_STEPS; step += 1) {
		const next = spec.resolveMenu(layout.shortened);
		if (sameMenu(menu, next)) break;
		menu = next;
		layout = fitGate(spec, menu, rows, wrap);
	}
	return { layout, menu };
}

function sameMenu<Id extends string>(left: readonly MenuOption<Id>[], right: readonly MenuOption<Id>[]): boolean {
	return left.length === right.length && left.every((option, index) => option.id === right[index]?.id);
}

/** Rows the frame may use: the terminal's height less what the dock's other occupants need. */
export function gateRowBudget(terminalRows: number | undefined): number {
	const rows =
		typeof terminalRows === "number" && Number.isFinite(terminalRows) && terminalRows > 0
			? Math.trunc(terminalRows)
			: FALLBACK_ROWS;
	return Math.max(1, rows - DOCK_RESERVED_ROWS);
}

/** The width left for content once both margins are subtracted. */
function contentWidthFor(width: number | undefined): { usable: number; paddingX: number; contentWidth: number } {
	const usable = typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.trunc(width) : FALLBACK_WIDTH;
	const paddingX = Math.min(PADDING_X, Math.max(0, Math.floor((usable - 1) / 2)));
	return { usable, paddingX, contentWidth: Math.max(1, usable - paddingX * 2) };
}

/** A gate component: the fitted layout, plus the `SelectList` that owns key handling. */
export interface GateFrame<Id extends string> extends Component {
	handleInput(data: string): void;
	/** Routes clicks and wheel events over the menu to the `SelectList`, as the old `Container` gates did. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	/** The menu currently offered, after `resolveMenu`; may change after a resize. */
	readonly menu: readonly MenuOption<Id>[];
}

/**
 * Builds the gate component for a spec.
 *
 * The menu is settled from a fit at the terminal's current size, at construction and
 * again on any render whose fit changes it; the `SelectList` is rebuilt only then, and
 * keeps the selected option by id so a resize does not move the cursor.
 */
export function createGateFrame<Id extends string>(
	tui: TUI,
	theme: Theme,
	spec: GateSpec<Id>,
	onSelect: (id: Id) => void,
	onCancel: () => void,
): GateFrame<Id> {
	const wrapAt = (width: number | undefined): Wrap => {
		const { contentWidth } = contentWidthFor(width);
		return (line) => wrapTextWithAnsi(line, contentWidth);
	};

	/**
	 * Builds the list, keeping the cursor across a rebuild.
	 *
	 * Prefers the option the user was on, by id. When that option is gone — a viewer
	 * dropped because the terminal grew — the cursor stays at the same index, clamped,
	 * rather than jumping to the first option: after an accept verdict the first option
	 * is Accept, and a resize must not turn a pending Enter into an acceptance.
	 */
	const listFor = (menu: readonly MenuOption<Id>[], previous?: { id: Id; index: number }): SelectList => {
		const items: SelectItem[] = menu.map((option) => ({
			value: option.id,
			label: option.label,
			...(option.description === undefined ? {} : { description: option.description }),
		}));
		const list = new SelectList(items, items.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("dim", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("dim", text),
		});
		if (previous !== undefined) {
			const byId = items.findIndex((item) => item.value === previous.id);
			const index = byId >= 0 ? byId : Math.min(previous.index, items.length - 1);
			if (index > 0) list.setSelectedIndex(index);
		}
		list.onSelect = (item) => onSelect(item.value as Id);
		list.onCancel = () => onCancel();
		return list;
	};

	let { menu, layout } = fitGateWithMenu(spec, gateRowBudget(tui.terminal?.rows), wrapAt(tui.terminal?.columns));
	let list = listFor(menu);
	/** Where the menu's first row was painted in the last render, for mouse routing. */
	let menuTop = -1;

	const tone = spec.tone ?? "accent";
	const headerTone = spec.headerTone ?? (() => "text" as const);

	return {
		get menu() {
			return menu;
		},

		render(width: number): string[] {
			const { usable, paddingX, contentWidth } = contentWidthFor(width);
			const fitted = fitGateWithMenu(spec, gateRowBudget(tui.terminal?.rows), (line) =>
				wrapTextWithAnsi(line, contentWidth),
			);
			layout = fitted.layout;
			if (!sameMenu(menu, fitted.menu)) {
				const current = list.getSelectedItem()?.value as Id | undefined;
				const index = menu.findIndex((option) => option.id === current);
				menu = fitted.menu;
				list = listFor(menu, current === undefined || index < 0 ? undefined : { id: current, index });
			}

			const margin = " ".repeat(paddingX);
			const out: string[] = [];
			const push = (row: string) => {
				const line = margin + row + margin;
				out.push(line + " ".repeat(Math.max(0, usable - visibleWidth(line))));
			};
			const blank = () => out.push(" ".repeat(usable));

			for (const row of layout.titleRows) push(theme.fg(tone, theme.bold(row)));
			blank();
			if (layout.headerRows.length > 0) {
				// Re-wrap per header line so each keeps its own tone; the layout's row count
				// came from the same wrap, so the totals agree.
				for (const line of spec.header.slice(0, layout.headerLinesKept)) {
					if (line === "") {
						blank();
						continue;
					}
					for (const row of wrapTextWithAnsi(line, contentWidth)) push(theme.fg(headerTone(line), row));
				}
				for (const row of layout.headerSignpostRows) push(theme.fg("dim", row));
				blank();
			}
			menuTop = out.length;
			for (const row of list.render(contentWidth)) push(row);
			for (const block of layout.blocks) {
				blank();
				for (const row of block.headingRows) push(theme.fg("text", row));
				for (const row of block.rows) push(theme.fg("text", row));
				for (const row of block.signpostRows) push(theme.fg("dim", row));
			}
			if (layout.hiddenBlocksLineRows.length > 0) {
				blank();
				for (const row of layout.hiddenBlocksLineRows) push(theme.fg("dim", row));
			}
			blank();
			for (const row of layout.hintRows) push(theme.fg("dim", row));
			return out;
		},

		invalidate(): void {
			// No cached rendering: every pass refits, which is what honours a resize.
		},

		handleInput(data: string): void {
			list.handleInput(data);
		},

		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			// The frame is one component, not a Container of children, so pi-tui cannot route
			// a click to the SelectList by position on its own. Translate into the menu's own
			// rows, as Container.handleMouse would. A `focus` in the result lands on the
			// frame, which is right: the frame is what owns key handling.
			if (menuTop < 0 || event.y < menuTop || event.y >= menuTop + menu.length) return undefined;
			return list.handleMouse({ ...event, y: event.y - menuTop, height: menu.length });
		},
	};
}

/**
 * Shows a gate and resolves the chosen option id, or undefined when it is dismissed.
 *
 * Every gate in the package opens through this one function, so the fit rules, the
 * padding, and the key handling cannot drift between them.
 */
export async function openGate<Id extends string>(ctx: ExtensionContext, spec: GateSpec<Id>): Promise<Id | undefined> {
	return ctx.ui.custom<Id | undefined>((tui, theme, _keybindings, done) =>
		createGateFrame(
			tui,
			theme,
			spec,
			(id) => done(id),
			() => done(undefined),
		),
	);
}
