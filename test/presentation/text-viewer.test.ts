/**
 * Tests for the shared read-only viewer's scrolling arithmetic and key handling.
 *
 * `windowLines` decides what is visible, clamps whatever offset the key handler
 * throws at it, and writes the status line the user navigates by. `closesViewer`
 * is separated out so the one key decision that matters — does this close? — is
 * testable without a TUI, since the Kitty keyboard protocol makes a raw byte
 * comparison wrong in a way no manual check in a single terminal would reveal.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closesViewer, windowLines } from "../../src/presentation/text-viewer.ts";

const LINES = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);

describe("windowLines", () => {
	it("returns the whole text when it fits the viewport", () => {
		const window = windowLines(["a", "b", "c"], 0, 10);
		assert.deepEqual(window.lines, ["a", "b", "c"]);
		assert.equal(window.offset, 0);
	});

	/**
	 * A short text reports its length rather than "lines 1-3 of 3", so the viewer
	 * never implies there is more to scroll to when there is not.
	 */
	it("reports a short text as complete rather than as a position", () => {
		assert.equal(windowLines(["a", "b", "c"], 0, 10).status, "3 lines");
		assert.equal(windowLines(["only"], 0, 10).status, "1 line");
	});

	it("slices the requested window of a long text", () => {
		const window = windowLines(LINES, 20, 10);
		assert.equal(window.lines[0], "line 21");
		assert.equal(window.lines.at(-1), "line 30");
		assert.equal(window.lines.length, 10);
	});

	it("describes the position of a long text", () => {
		assert.equal(windowLines(LINES, 20, 10).status, "Lines 21-30 of 100");
	});

	it("clamps a negative offset instead of rejecting it", () => {
		const window = windowLines(LINES, -50, 10);
		assert.equal(window.offset, 0);
		assert.equal(window.lines[0], "line 1");
	});

	/**
	 * Anchoring the last window to the end is what keeps a page-down at the bottom
	 * from leaving a screen half full of blank rows past the final line.
	 */
	it("anchors the final window to the end of the content", () => {
		const window = windowLines(LINES, 500, 10);
		assert.equal(window.offset, 90);
		assert.equal(window.lines.at(-1), "line 100");
		assert.equal(window.lines.length, 10);
	});

	it("marks the end so the user knows there is nothing further", () => {
		assert.equal(windowLines(LINES, 500, 10).status, "Lines 91-100 of 100 (end)");
		assert.equal(windowLines(LINES, 0, 10).status.includes("(end)"), false);
	});

	it("truncates a fractional offset rather than slicing on a fraction", () => {
		assert.equal(windowLines(LINES, 20.7, 10).offset, 20);
	});

	it("enforces a minimum viewport, so a tiny terminal cannot produce an empty window", () => {
		const window = windowLines(LINES, 0, 0);
		assert.ok(window.lines.length >= 3);
	});

	it("does not mutate or alias the caller's lines", () => {
		const source = ["a", "b"];
		const window = windowLines(source, 0, 10);
		window.lines.push("c");
		assert.deepEqual(source, ["a", "b"]);
	});
});

/**
 * The viewer exists for text the gates cannot fit: prompts written as unwrapped
 * paragraphs, report bullets. Those wrap to several rows each, so a window counted
 * in logical lines overflowed the terminal and pushed the viewer's own heading —
 * and the top of the window — off the screen. Windowing therefore counts rendered
 * rows, with the height of each line supplied by the caller that knows the width.
 */
describe("windowLines with wrapped lines", () => {
	/** Every line three rows tall, the shape a wrapped paragraph actually has. */
	const threeRows = () => 3;

	it("fits fewer lines when each one wraps", () => {
		const window = windowLines(LINES, 0, 12, threeRows);
		assert.equal(window.lines.length, 4, "12 rows holds four three-row lines");
	});

	it("never returns more rows than the viewport has", () => {
		const window = windowLines(LINES, 0, 10, threeRows);
		assert.ok(window.lines.length * 3 <= 10, "expected the window to fit within ten rows");
	});

	it("measures each line separately rather than assuming a uniform height", () => {
		// Rows: 1, 4, 1, 1, ... — the second line alone is as tall as four others.
		const heights = [1, 4, 1, 1, 1, 1];
		const window = windowLines(["a", "b", "c", "d", "e", "f"], 0, 6, (_line, index) => heights[index] ?? 1);
		assert.deepEqual(window.lines, ["a", "b", "c"], "1 + 4 + 1 fills six rows");
	});

	it("reports a text that fits as complete even when its lines wrap", () => {
		assert.equal(windowLines(["a", "b"], 0, 10, threeRows).status, "2 lines");
	});

	/** A short text whose wrapped rows overflow is a position, not a complete view. */
	it("treats a wrapped overflow as scrollable rather than complete", () => {
		const window = windowLines(["a", "b", "c", "d"], 0, 6, threeRows);
		assert.match(window.status, /Lines 1-2 of 4/);
	});

	it("anchors the final window to the end, counting rows", () => {
		const window = windowLines(LINES, 500, 12, threeRows);
		assert.equal(window.lines.at(-1), "line 100");
		assert.equal(window.offset, 96);
		assert.match(window.status, /\(end\)/);
	});

	/** A single paragraph taller than the screen still has to be reachable. */
	it("still shows a line taller than the whole viewport", () => {
		const window = windowLines(["short", "enormous"], 5, 4, (_line, index) => (index === 1 ? 40 : 1));
		assert.deepEqual(window.lines, ["enormous"]);
	});

	it("numbers the status line in logical lines, not rows", () => {
		const window = windowLines(LINES, 10, 12, threeRows);
		assert.equal(window.status, "Lines 11-14 of 100");
	});
});

/**
 * Paging is the arithmetic that broke once windowing became row-measured. A page was
 * computed as a row count and applied as a line delta, so on wrapped content — the
 * only content this viewer exists for — a single page-down at width 80 jumped from
 * lines 1-5 to lines 21-25 and the fifteen in between were never shown.
 *
 * The fix is to page by the rendered window's own boundaries: forward to the first
 * line past it, backward by filling a viewport from its top. These assert both
 * directions, and that walking down and back up returns to where it started.
 */
describe("windowLines paging offsets", () => {
	/** Every line four rows tall, so a row-count page would overshoot fourfold. */
	const fourRows = () => 4;

	it("advances to the first line past the window, skipping nothing", () => {
		const first = windowLines(LINES, 0, 20, fourRows);
		assert.equal(first.lines.length, 5, "20 rows holds five four-row lines");
		assert.equal(first.nextOffset, 5, "the next page starts at the sixth line, not the twentieth");

		const second = windowLines(LINES, first.nextOffset, 20, fourRows);
		assert.equal(second.status, "Lines 6-10 of 100", "expected the page after 1-5 to be 6-10");
	});

	/** The regression itself: contiguous windows, in the shape the reviewer probed. */
	it("pages through wrapped content without leaving a gap", () => {
		const seen: number[] = [];
		let offset = 0;
		for (let page = 0; page < 8; page += 1) {
			const window = windowLines(LINES, offset, 20, fourRows);
			for (let index = 0; index < window.lines.length; index += 1) seen.push(window.offset + index);
			if (window.nextOffset >= LINES.length) break;
			offset = window.nextOffset;
		}
		assert.deepEqual(
			seen,
			Array.from({ length: seen.length }, (_, index) => index),
			"expected every line up to the last page to have been visited exactly once, in order",
		);
	});

	it("pages back by filling a viewport from the top of the window", () => {
		const window = windowLines(LINES, 20, 20, fourRows);
		assert.equal(window.previousOffset, 15, "five four-row lines fit in the viewport above line 21");
	});

	it("returns to the same window after a page down and a page up", () => {
		const first = windowLines(LINES, 40, 20, fourRows);
		const next = windowLines(LINES, first.nextOffset, 20, fourRows);
		const back = windowLines(LINES, next.previousOffset, 20, fourRows);
		assert.equal(back.offset, first.offset);
		assert.deepEqual(back.lines, first.lines);
	});

	it("pages by lines when nothing wraps", () => {
		const window = windowLines(LINES, 0, 10);
		assert.equal(window.nextOffset, 10);
		assert.equal(windowLines(LINES, 10, 10).previousOffset, 0);
	});

	it("stops at the top rather than paging past it", () => {
		assert.equal(windowLines(LINES, 0, 20, fourRows).previousOffset, 0);
	});

	/** A page down at the end is clamped by the next call, which owns the content bound. */
	it("reports a next offset past the end once the last window is reached", () => {
		const last = windowLines(LINES, 500, 20, fourRows);
		assert.match(last.status, /\(end\)/);
		const clamped = windowLines(LINES, last.nextOffset, 20, fourRows);
		assert.equal(clamped.offset, last.offset, "expected paging past the end to stay on the final window");
	});

	/** A line taller than the viewport must not trap either direction. */
	it("always moves by at least one line, even past an oversized line", () => {
		const heights = [1, 40, 1, 1, 1];
		const measure = (_line: string, index: number) => heights[index] ?? 1;
		const source = ["a", "enormous", "c", "d", "e"];
		const window = windowLines(source, 2, 4, measure);
		assert.equal(window.previousOffset, 1, "expected a page up to reach the oversized line rather than stall");
		assert.equal(windowLines(source, 1, 4, measure).previousOffset, 0);
	});

	/** A text that fits has nowhere to page to, and must not offer a phantom move. */
	it("offers no movement when the whole text fits", () => {
		const window = windowLines(["a", "b"], 0, 10);
		assert.equal(window.nextOffset, 0);
		assert.equal(window.previousOffset, 0);
	});
});

/**
 * Escape is the key the footer advertises, and under the Kitty keyboard protocol
 * (Ghostty, WezTerm, Kitty) it arrives as `\x1b[27u` rather than as a bare
 * `\x1b`. The previous version compared raw bytes, so its Escape silently never
 * fired in those terminals while the footer still promised it would.
 */
describe("closesViewer", () => {
	it("closes on a legacy Escape", () => {
		assert.equal(closesViewer("\x1b"), true);
	});

	it("closes on a Kitty-protocol Escape", () => {
		assert.equal(closesViewer("\x1b[27u"), true);
	});

	it("closes on Enter and on q, which a user arrives with in muscle memory", () => {
		assert.equal(closesViewer("\r"), true);
		assert.equal(closesViewer("q"), true);
	});

	/**
	 * Escape is a byte prefix of every arrow and page sequence, which is why the old
	 * version had to test it last. These assert the hazard is gone rather than merely
	 * ordered around.
	 */
	it("does not close on a scroll key that begins with Escape", () => {
		for (const key of ["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~", "\x1b[H", "\x1b[F"]) {
			assert.equal(closesViewer(key), false, `expected ${JSON.stringify(key)} to scroll rather than close`);
		}
	});

	it("does not close on an ordinary character", () => {
		assert.equal(closesViewer("a"), false);
	});
});
