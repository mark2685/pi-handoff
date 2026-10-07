/**
 * The gate frame's one promise is that a gate fits the rows it is given with its menu
 * intact. These tests state that promise against pi-tui's real wrapping, with the
 * content shapes that broke the previous hand-counted budgets: paragraphs that wrap to
 * several rows each, a header line that wraps, and more evidence than the screen.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	createGateFrame,
	DOCK_RESERVED_ROWS,
	fitGate,
	fitGateWithMenu,
	gateRowBudget,
	MIN_BLOCK_BODY_ROWS,
	type GateBlock,
	type GateSpec,
	type Wrap,
} from "../../src/presentation/gate-frame.ts";
import type { MenuOption } from "../../src/presentation/menus.ts";

const wrapAt =
	(width: number): Wrap =>
	(line) =>
		wrapTextWithAnsi(line, width);

/** A paragraph long enough to wrap three or four times at 78 columns. */
const PARAGRAPH =
	"The worker rewrote the retry loop so that a transient provider failure is retried with exponential backoff before the run is marked as failed, and added a regression test that exercises the timeout path twice.";

const paragraphs = (count: number, prefix = "") =>
	Array.from({ length: count }, (_, index) => `${prefix}${index + 1}. ${PARAGRAPH}`).join("\n");

type Id = "accept" | "view_report" | "view_diffstat" | "dismiss";

const block = (id: string, text: string, viewerOption?: Id): GateBlock<Id> => ({
	id,
	label: id,
	heading: `${id}:`,
	text,
	...(viewerOption === undefined ? {} : { viewerOption }),
});

/** Seven options, the result gate's common size. */
const MENU: readonly MenuOption<Id>[] = [
	{ id: "accept", label: "Accept" },
	{ id: "view_report", label: "View full report" },
	{ id: "view_diffstat", label: "View full diffstat" },
	{ id: "dismiss", label: "Leave this for later" },
	{ id: "accept", label: "Accept again" },
	{ id: "accept", label: "Accept once more" },
	{ id: "accept", label: "Accept, really" },
];

const spec = (
	blocks: GateBlock<Id>[],
	header: string[] = ["Handoff:   add-retries", "Model:     bifrost/claude-sonnet-5:high"],
) => ({
	title: "Handoff complete — review the changes",
	header,
	blocks,
	hint: "↑↓ navigate   enter select   esc leave for later",
});

/** Rows the non-shrinkable part of a layout paints; the menu is on screen only if this fits. */
const fixedRowsOf = (layout: ReturnType<typeof fitGate>) =>
	layout.titleRows.length +
	1 +
	(layout.headerRows.length + layout.headerSignpostRows.length === 0
		? 0
		: layout.headerRows.length + layout.headerSignpostRows.length + 1) +
	layout.menuRows +
	1 +
	layout.hintRows.length;

const threeBlocks = () => [
	block("report", paragraphs(40), "view_report"),
	block("review", paragraphs(30)),
	block("diffstat", paragraphs(20), "view_diffstat"),
];

describe("fitGate", () => {
	it("never paints more rows than it was given, whatever the content", () => {
		const layout = fitGate(spec(threeBlocks()), MENU, 46, wrapAt(78));
		assert.ok(layout.rows <= 46, `painted ${layout.rows} rows into 46`);
	});

	/**
	 * The one exception is a terminal too small for the title, menu, and hint alone:
	 * then the frame keeps the menu and overflows rather than cut it, which is the
	 * whole point.
	 */
	it("holds that bound across terminal sizes and widths, keeping the menu when even that cannot fit", () => {
		for (const rows of [12, 20, 24, 30, 40, 50, 70, 120]) {
			for (const width of [40, 60, 80, 120, 200]) {
				const fixture = spec(threeBlocks());
				const wrap = wrapAt(width - 2);
				const layout = fitGate(fixture, MENU, rows, wrap);
				const irreducible = wrap(fixture.title).length + 1 + MENU.length + 1 + wrap(fixture.hint).length;
				assert.ok(
					layout.rows <= Math.max(rows, irreducible),
					`painted ${layout.rows} rows into ${rows} at width ${width}`,
				);
				assert.ok(fixedRowsOf(layout) <= Math.max(rows, irreducible), `menu section overflows at ${width}x${rows}`);
			}
		}
	});

	/**
	 * The previous budget counted source lines, so an 18-line block painted 45 rows.
	 * Pinned by values that differ between the two measurements: the body is 13 wrapped
	 * fragments (not 13 source lines), and the signpost counts 14 lines not fully shown,
	 * where a source-line count would say 5.
	 */
	it("measures a block in rendered rows, not source lines", () => {
		const layout = fitGate(spec([block("report", paragraphs(18), "view_report")]), MENU, 30, wrapAt(78));
		const report = layout.blocks[0];
		assert.ok(report !== undefined && report.shortened);
		assert.equal(report.rows.length, 13);
		for (const row of report.rows) assert.ok(visibleWidth(row) <= 78, `"${row}" is not a wrapped fragment`);
		assert.equal(
			report.rows.some((row) => row === `1. ${PARAGRAPH}`),
			false,
			"rows are wrapped fragments, never whole source lines",
		);
		assert.equal(report.signpost, '… 14 more lines — choose "View full report" to read all of it');
	});

	it("gives a block that fits its whole text and no signpost", () => {
		const layout = fitGate(
			spec([block("diffstat", "a.ts | 2 +-\nb.ts | 4 ++--", "view_diffstat")]),
			MENU,
			40,
			wrapAt(78),
		);
		assert.deepEqual(layout.blocks[0]?.rows, ["a.ts | 2 +-", "b.ts | 4 ++--"]);
		assert.equal(layout.blocks[0]?.signpost, undefined);
		assert.equal(layout.blocks[0]?.shortened, false);
		assert.deepEqual([...layout.shortened], []);
	});

	it("counts the signpost in source lines not fully shown and names the viewer by its menu label", () => {
		const text = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
		const layout = fitGate(spec([block("report", text, "view_report")]), MENU, 30, wrapAt(78));
		const report = layout.blocks[0];
		assert.ok(report !== undefined && report.shortened);
		assert.equal(
			report.signpost,
			`… ${40 - report.rows.length} more lines — choose "View full report" to read all of it`,
		);
		assert.deepEqual([...layout.shortened], ["report"]);
	});

	/**
	 * Two paragraphs of three rows each; the body gets four rows, so the second line is
	 * only partly shown. Counting hidden rows (6 − 4 = 2) instead of lines not fully
	 * shown (1) is the regression this pins, so the value is exact.
	 */
	it("does not count a wrapped line as shown when only part of it fits", () => {
		const layout = fitGate(
			spec([block("report", paragraphs(2), "view_report")]),
			MENU,
			12 + MENU.length + 2,
			wrapAt(78),
		);
		const report = layout.blocks[0];
		assert.ok(report !== undefined && report.shortened);
		assert.equal(report.rows.length, 4);
		assert.equal(report.signpost, '… 1 more line — choose "View full report" to read all of it');
	});

	it("omits the viewer hint from a signpost when the block has no viewer", () => {
		const layout = fitGate(spec([block("questions", paragraphs(10))]), MENU, 20, wrapAt(78));
		assert.match(layout.blocks[0]?.signpost ?? "", /^… \d+ more lines$/);
	});

	/** A signpost may only name an option the menu actually offers. */
	it("omits the viewer hint when the named option is not in the menu", () => {
		const withoutViewer = MENU.filter((option) => option.id !== "view_report");
		const layout = fitGate(spec([block("report", paragraphs(10), "view_report")]), withoutViewer, 20, wrapAt(78));
		assert.match(layout.blocks[0]?.signpost ?? "", /^… \d+ more lines$/);
	});

	it("gives every block its floor before the first block grows", () => {
		const layout = fitGate(spec(threeBlocks()), MENU, 40, wrapAt(78));
		assert.deepEqual(
			layout.blocks.map((entry) => entry.id),
			["report", "review", "diffstat"],
		);
		for (const entry of layout.blocks) {
			assert.ok(entry.rows.length + 1 >= MIN_BLOCK_BODY_ROWS, `${entry.id} fell below the floor`);
		}
		// Fixed 14 rows, 26 remaining, three floors of 2 + 3 = 15, 11 spare to the first block.
		assert.deepEqual(
			layout.blocks.map((entry) => entry.rows.length),
			[13, 2, 2],
			"the first block, and only the first, takes the spare rows",
		);
	});

	it("hides the lowest-priority blocks behind one hidden-blocks line when there is no room for their floor", () => {
		const layout = fitGate(spec(threeBlocks()), MENU, 20, wrapAt(78));
		assert.ok(layout.rows <= 20);
		assert.ok(layout.blocks.length < 3);
		assert.match(layout.hiddenBlocksLine ?? "", /not shown — enlarge the terminal or use the viewers in the menu/);
		assert.ok(layout.shortened.has("diffstat"), "a hidden block counts as shortened so its viewer is offered");
	});

	it("does not point the hidden-blocks line at viewers when no hidden block has one", () => {
		const layout = fitGate(spec([block("questions", paragraphs(10))], ["Prompt:    /tmp/x.md"]), MENU, 15, wrapAt(78));
		assert.deepEqual(layout.blocks, []);
		assert.equal(layout.hiddenBlocksLine, "… questions not shown — enlarge the terminal to read them");
	});

	it("cuts the header from the bottom with a signpost before it ever cuts the menu", () => {
		const header = Array.from({ length: 20 }, (_, index) => `Line ${index + 1} of a long header`);
		const layout = fitGate(spec([], header), MENU, 16, wrapAt(78));
		assert.ok(layout.rows <= 16);
		assert.ok(fixedRowsOf(layout) <= 16, "the menu section fits once the header is cut");
		assert.ok(layout.headerLinesKept < 20);
		assert.equal(layout.headerSignpost, `… ${20 - layout.headerLinesKept} more lines`);
	});

	/** A header cut to nothing has no row for a signpost either; the layout must not report one it does not paint. */
	it("drops the header signpost too when the header is cut to nothing", () => {
		const layout = fitGate(spec(threeBlocks()), MENU, 12, wrapAt(78));
		assert.equal(layout.headerLinesKept, 0);
		assert.equal(layout.headerSignpost, undefined);
		assert.deepEqual(layout.headerSignpostRows, []);
		assert.equal(layout.rows, fixedRowsOf(layout), "nothing but title, menu, and hint remains");
	});

	it("keeps the header signpost while any header line survives", () => {
		const header = Array.from({ length: 6 }, (_, index) => `Header line ${index + 1}`);
		const layout = fitGate(spec([], header), MENU, 15, wrapAt(78));
		assert.ok(layout.headerLinesKept > 0 && layout.headerLinesKept < 6);
		assert.equal(layout.headerSignpost, `… ${6 - layout.headerLinesKept} more lines`);
		assert.deepEqual(layout.headerSignpostRows, [layout.headerSignpost]);
	});

	it("measures a header line that wraps at its rendered height", () => {
		const header = [`Rationale: ${PARAGRAPH} ${PARAGRAPH}`];
		// 60 columns wraps the rationale but not the title or hint, so only the header differs.
		const narrow = fitGate(spec([], header), MENU, 40, wrapAt(60));
		const wide = fitGate(spec([], header), MENU, 40, wrapAt(400));
		assert.ok(narrow.headerRows.length > wide.headerRows.length);
		assert.equal(narrow.rows - wide.rows, narrow.headerRows.length - wide.headerRows.length);
	});

	/**
	 * pi-tui's main-screen renderer throws on a row wider than the terminal, so every
	 * row — headings, signposts, and the hidden-blocks line included — must be wrapped and counted.
	 */
	it("wraps headings, signposts, and the hidden-blocks line at narrow widths and counts their rows", () => {
		const longHeading: GateBlock<Id> = {
			id: "partialOutput",
			label: "partial output",
			heading: "Partial output before the worker died (NOT a report — it never finished):",
			text: paragraphs(3),
			viewerOption: "view_report",
		};
		for (const width of [30, 40, 60]) {
			const wrap = wrapAt(width);
			const shown = fitGate(spec([longHeading], []), MENU, 40, wrap);
			const hidden = fitGate(spec([longHeading, ...threeBlocks()], []), MENU, 14, wrap);
			for (const layout of [shown, hidden]) {
				const painted = [
					...layout.titleRows,
					...layout.headerRows,
					...layout.headerSignpostRows,
					...layout.blocks.flatMap((entry) => [...entry.headingRows, ...entry.rows, ...entry.signpostRows]),
					...layout.hiddenBlocksLineRows,
					...layout.hintRows,
				];
				for (const row of painted) assert.ok(visibleWidth(row) <= width, `"${row}" is wider than ${width}`);
				const counted =
					layout.titleRows.length +
					1 +
					(layout.headerRows.length + layout.headerSignpostRows.length === 0
						? 0
						: layout.headerRows.length + layout.headerSignpostRows.length + 1) +
					layout.menuRows +
					layout.blocks.reduce(
						(sum, entry) => sum + 1 + entry.headingRows.length + entry.rows.length + entry.signpostRows.length,
						0,
					) +
					(layout.hiddenBlocksLineRows.length === 0 ? 0 : 1 + layout.hiddenBlocksLineRows.length) +
					1 +
					layout.hintRows.length;
				assert.equal(layout.rows, counted, `rows must count every painted row at width ${width}`);
			}
			assert.ok(shown.blocks[0]!.headingRows.length > 1, `the heading must wrap at ${width} for this test to bite`);
		}
	});

	/**
	 * At a very narrow width the viewer signpost alone wraps to more rows than a cut
	 * block's three-row floor; the block must still paint within its allocation.
	 */
	it("keeps a cut block within its allocation when its signpost wraps to several rows", () => {
		for (const width of [12, 16, 20, 24]) {
			const wrap = wrapAt(width);
			const fixture = spec([block("report", paragraphs(10), "view_report")], ["Handoff: x"]);
			const layout = fitGate(fixture, MENU, 24, wrap);
			const irreducible = wrap(fixture.title).length + 1 + MENU.length + 1 + wrap(fixture.hint).length;
			assert.ok(layout.rows <= Math.max(24, irreducible), `painted ${layout.rows} rows at width ${width}`);
			for (const entry of layout.blocks) {
				assert.ok(entry.rows.length >= 1, "a cut block keeps at least one body row");
				for (const row of [...entry.rows, ...entry.signpostRows]) assert.ok(visibleWidth(row) <= width);
			}
		}
	});

	/** When the signpost itself is cut, the text field must describe the painted rows, not the full sentence. */
	it("reports a cut signpost as exactly the rows it paints", () => {
		for (const width of [4, 6, 8]) {
			const wrap = wrapAt(width);
			const fixture = spec([block("report", paragraphs(10), "view_report")], ["Handoff: x"]);
			const layout = fitGate(fixture, MENU, 24, wrap);
			const irreducible = wrap(fixture.title).length + 1 + MENU.length + 1 + wrap(fixture.hint).length;
			assert.ok(layout.rows <= Math.max(24, irreducible), `painted ${layout.rows} rows at width ${width}`);
			for (const entry of layout.blocks) {
				if (!entry.shortened) continue;
				assert.equal(entry.signpost, entry.signpostRows.join(" "));
				assert.equal(entry.signpost?.includes("View full report"), false, "the viewer hint is the first thing dropped");
			}
		}
	});

	it("drops a block whose text is blank rather than rendering an empty heading", () => {
		const layout = fitGate(spec([block("diffstat", "   \n", "view_diffstat")]), MENU, 40, wrapAt(78));
		assert.deepEqual(layout.blocks, []);
		assert.equal(layout.hiddenBlocksLine, undefined);
	});
});

describe("fitGateWithMenu", () => {
	const resolving = (rows: number, text = paragraphs(40)) =>
		fitGateWithMenu(
			{
				...spec([block("report", text, "view_report")]),
				menu: MENU,
				resolveMenu: (shortened) => (shortened.has("report") ? MENU : MENU.filter((o) => o.id !== "view_report")),
			},
			rows,
			wrapAt(78),
		);

	it("keeps a viewer for a block the fit shortened", () => {
		const { menu, layout } = resolving(30);
		assert.ok(layout.shortened.has("report"));
		assert.ok(menu.some((option) => option.id === "view_report"));
	});

	it("drops a viewer for a block the fit shows in full", () => {
		const { menu, layout } = resolving(60, "Done.");
		assert.equal(layout.shortened.has("report"), false);
		assert.equal(
			menu.some((option) => option.id === "view_report"),
			false,
		);
	});
});

describe("gateRowBudget", () => {
	it("reserves rows for the dock's other occupants", () => {
		assert.equal(gateRowBudget(50), 50 - DOCK_RESERVED_ROWS);
	});

	it("falls back to a sane height when the terminal reports none", () => {
		assert.equal(gateRowBudget(undefined), 24 - DOCK_RESERVED_ROWS);
		assert.equal(gateRowBudget(Number.NaN), 24 - DOCK_RESERVED_ROWS);
	});
});

describe("createGateFrame", () => {
	const plainTheme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const tui = (rows: number, columns: number) =>
		({ requestRender: () => {}, terminal: { rows, columns } }) as unknown as Parameters<typeof createGateFrame>[0] & {
			terminal: { rows: number; columns: number };
		};

	const gate = (
		terminal: ReturnType<typeof tui>,
		overrides: Partial<GateSpec<Id>> = {},
		theme: { fg: (role: string, text: string) => string; bold: (text: string) => string } = plainTheme,
		onSelect: (id: Id) => void = () => {},
	) =>
		createGateFrame(
			terminal,
			theme as unknown as Parameters<typeof createGateFrame>[1],
			{
				...spec([block("report", paragraphs(40), "view_report")]),
				menu: [
					{ id: "accept", label: "Accept" },
					{ id: "view_report", label: "View full report" },
					{ id: "dismiss", label: "Leave this for later" },
				],
				...overrides,
			},
			onSelect,
			() => {},
		);

	const DOWN = "\x1b[B";
	const ENTER = "\r";

	it("renders within the row budget with every menu label visible", () => {
		for (const [rows, columns] of [
			[24, 80],
			[40, 120],
			[50, 120],
			[70, 120],
			[45, 160],
		] as const) {
			const lines = gate(tui(rows, columns)).render(columns);
			assert.ok(lines.length <= gateRowBudget(rows), `${lines.length} rows at ${columns}x${rows}`);
			for (const label of ["Accept", "View full report", "Leave this for later"]) {
				assert.ok(
					lines.some((line) => line.includes(label)),
					`${label} missing at ${columns}x${rows}`,
				);
			}
		}
	});

	it("places the menu above the evidence, after the header", () => {
		const lines = gate(tui(50, 120)).render(120);
		const menuAt = lines.findIndex((line) => line.includes("Accept"));
		const headerAt = lines.findIndex((line) => line.includes("Handoff:   add-retries"));
		const reportAt = lines.findIndex((line) => line.includes("report:"));
		assert.ok(headerAt < menuAt && menuAt < reportAt, `header ${headerAt}, menu ${menuAt}, report ${reportAt}`);
	});

	it("never paints a row wider than the terminal, at any width", () => {
		for (const columns of [30, 40, 60, 80, 100]) {
			const frame = gate(tui(24, columns), {
				blocks: [
					{
						id: "partialOutput",
						label: "partial output",
						heading: "Partial output before the worker died (NOT a report — it never finished):",
						text: paragraphs(5),
						viewerOption: "view_report",
					},
					...threeBlocks(),
				],
			});
			for (const line of frame.render(columns)) {
				assert.equal(visibleWidth(line), columns, `row width ${visibleWidth(line)} at ${columns} columns: "${line}"`);
			}
		}
	});

	it("colours the title by tone and header lines by headerTone", () => {
		const roles: string[] = [];
		const recording = {
			fg: (role: string, text: string) => {
				roles.push(`${role}:${text.trim()}`);
				return text;
			},
			bold: (text: string) => text,
		};
		gate(
			tui(40, 100),
			{
				tone: "warning",
				header: ["Warning: two paths were skipped", "  a.ts", "Done."],
				headerTone: (line) => (line.startsWith("Warning:") ? "warning" : line.startsWith("  ") ? "dim" : "text"),
				blocks: [],
			},
			recording,
		).render(100);
		assert.ok(roles.includes("warning:Handoff complete — review the changes"), "title takes the spec's tone");
		assert.ok(roles.includes("warning:Warning: two paths were skipped"));
		assert.ok(roles.includes("dim:a.ts"));
		assert.ok(roles.includes("text:Done."));
	});

	it("resolves the menu from the blocks the fit shortened", () => {
		const seen: string[][] = [];
		const frame = gate(tui(50, 120), {
			resolveMenu: (shortened) => {
				seen.push([...shortened]);
				return [{ id: "accept", label: "Accept" }];
			},
		});
		assert.deepEqual(
			frame.menu.map((option) => option.id),
			["accept"],
		);
		assert.deepEqual(seen[0], ["report"]);
	});

	it("does not offer a viewer for a block the gate shows in full", () => {
		const frame = gate(tui(50, 120), {
			blocks: [block("diffstat", "a.ts | 1 +", "view_diffstat")],
			resolveMenu: (shortened) => (shortened.size === 0 ? [{ id: "accept", label: "Accept" }] : []),
		});
		assert.deepEqual(
			frame.menu.map((option) => option.id),
			["accept"],
		);
	});

	/** The render side must paint the kept header slice and its signpost, not the whole header. */
	it("renders a cut header with its signpost and keeps every menu label on screen", () => {
		const lines = gate(tui(14, 120), {
			header: Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`),
			blocks: [],
		}).render(120);
		assert.ok(lines.length <= gateRowBudget(14), `${lines.length} rows into ${gateRowBudget(14)}`);
		assert.ok(lines.some((line) => line.includes("Line 1")));
		assert.equal(
			lines.some((line) => line.includes("Line 20")),
			false,
		);
		assert.ok(lines.some((line) => /… \d+ more lines/.test(line)));
		for (const label of ["Accept", "View full report", "Leave this for later"]) {
			assert.ok(
				lines.some((line) => line.includes(label)),
				`${label} missing`,
			);
		}
	});

	/** The old Container gates forwarded clicks and wheel events to the SelectList; the frame must too. */
	it("routes a click on a menu row to that option and ignores clicks elsewhere", () => {
		const selected: Id[] = [];
		const frame = gate(tui(50, 120), {}, plainTheme, (id) => selected.push(id));
		const lines = frame.render(120);
		const dismissRow = lines.findIndex((line) => line.includes("Leave this for later"));
		const reportRow = lines.findIndex((line) => line.includes("report:"));
		assert.ok(dismissRow > 0 && reportRow > dismissRow);
		const at = (y: number, type: "press" | "click" | "wheel", wheelDelta?: number) => ({
			type,
			button: type === "wheel" ? ("none" as const) : ("left" as const),
			x: 2,
			y,
			screenX: 2,
			screenY: y,
			width: 120,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			...(wheelDelta === undefined ? {} : { wheelDelta }),
		});
		assert.equal(frame.handleMouse(at(reportRow, "click")), undefined, "a click on the evidence is not a selection");
		assert.ok(frame.handleMouse(at(dismissRow, "press"))?.handled);
		assert.ok(frame.handleMouse(at(dismissRow, "click"))?.handled);
		assert.deepEqual(selected, ["dismiss"]);
		assert.ok(frame.handleMouse(at(dismissRow, "wheel", -1))?.handled, "the wheel moves the cursor over the menu");
	});

	/**
	 * A block that fit when the gate opened can be cut after the terminal shrinks; its
	 * viewer must come back and the signpost must name it, or the text is unreachable.
	 */
	it("offers a viewer again, and names it in the signpost, when a resize cuts a block that had fit", () => {
		const terminal = tui(60, 120);
		const full: readonly MenuOption<Id>[] = [
			{ id: "accept", label: "Accept" },
			{ id: "view_report", label: "View full report" },
			{ id: "dismiss", label: "Leave this for later" },
		];
		const frame = gate(terminal, {
			blocks: [block("report", Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"), "view_report")],
			menu: full,
			resolveMenu: (shortened) => (shortened.has("report") ? full : full.filter((o) => o.id !== "view_report")),
		});
		let lines = frame.render(120);
		assert.equal(
			frame.menu.some((option) => option.id === "view_report"),
			false,
			"the report fits at 60 rows, so no viewer",
		);
		assert.ok(!lines.some((line) => line.includes("more lines")));

		terminal.terminal.rows = 20;
		lines = frame.render(120);
		assert.ok(
			frame.menu.some((option) => option.id === "view_report"),
			"the report is cut at 20 rows, so the viewer returns",
		);
		assert.ok(
			lines.some((line) => line.includes("View full report") && !line.includes("more lines")),
			"the viewer is in the rendered menu",
		);
		assert.ok(
			lines.some((line) => /more lines — choose "View full report"/.test(line)),
			"the signpost names the viewer now offered",
		);
		assert.ok(lines.length <= gateRowBudget(20));
	});

	/**
	 * A rebuilt list must keep the cursor: after an accept verdict the first option is
	 * Accept, so a resize that reset the cursor would turn a pending Enter into an accept.
	 */
	it("keeps the selected option by id when a resize rebuilds the menu", () => {
		const terminal = tui(60, 120);
		const full: readonly MenuOption<Id>[] = [
			{ id: "accept", label: "Accept" },
			{ id: "view_report", label: "View full report" },
			{ id: "dismiss", label: "Leave this for later" },
		];
		const selected: Id[] = [];
		const frame = gate(
			terminal,
			{
				blocks: [block("report", Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"), "view_report")],
				menu: full,
				resolveMenu: (shortened) => (shortened.has("report") ? full : full.filter((o) => o.id !== "view_report")),
			},
			plainTheme,
			(id) => selected.push(id),
		);
		frame.render(120);
		frame.handleInput(DOWN); // Accept → Leave this for later (view_report is absent at 60 rows)
		terminal.terminal.rows = 20;
		frame.render(120); // menu grows to three options; the cursor must still be on dismiss
		frame.handleInput(ENTER);
		assert.deepEqual(selected, ["dismiss"]);
	});

	it("keeps the cursor at the same position, not the first option, when the selected option disappears", () => {
		const terminal = tui(20, 120);
		const full: readonly MenuOption<Id>[] = [
			{ id: "accept", label: "Accept" },
			{ id: "view_report", label: "View full report" },
			{ id: "dismiss", label: "Leave this for later" },
		];
		const selected: Id[] = [];
		const frame = gate(
			terminal,
			{
				blocks: [block("report", Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"), "view_report")],
				menu: full,
				resolveMenu: (shortened) => (shortened.has("report") ? full : full.filter((o) => o.id !== "view_report")),
			},
			plainTheme,
			(id) => selected.push(id),
		);
		frame.render(120);
		frame.handleInput(DOWN); // Accept → View full report (offered at 20 rows)
		terminal.terminal.rows = 60;
		frame.render(120); // the report fits, so View full report is dropped
		assert.equal(
			frame.menu.some((option) => option.id === "view_report"),
			false,
		);
		frame.handleInput(ENTER);
		assert.deepEqual(selected, ["dismiss"], "the cursor stays at index 1, now Leave this for later, never Accept");
	});
});
