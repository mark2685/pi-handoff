/** Tests for the pure, total parser behind checkpoint status snapshots. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePorcelainZ } from "../../src/domain/git-status.ts";

describe("parsePorcelainZ", () => {
	it("returns an empty valid snapshot for empty porcelain output", () => {
		assert.deepEqual(parsePorcelainZ(""), { entries: [], malformed: false });
	});

	it("preserves spaces and the separate source field of a rename", () => {
		assert.deepEqual(parsePorcelainZ(" M tracked file.txt\0?? weird name.txt\0R  renamed to.txt\0renamed from.txt\0"), {
			entries: [
				{ indexStatus: " ", worktreeStatus: "M", path: "tracked file.txt" },
				{ indexStatus: "?", worktreeStatus: "?", path: "weird name.txt" },
				{
					indexStatus: "R",
					worktreeStatus: " ",
					path: "renamed to.txt",
					originalPath: "renamed from.txt",
				},
			],
			malformed: false,
		});
	});

	it("marks arbitrary or incomplete bytes malformed without throwing", () => {
		assert.doesNotThrow(() => parsePorcelainZ("not porcelain\0?? missing terminator"));
		assert.equal(parsePorcelainZ("not porcelain\0?? missing terminator").malformed, true);
	});
});
