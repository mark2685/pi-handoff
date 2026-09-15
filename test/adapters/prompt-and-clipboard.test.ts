/**
 * Tests for the two IO adapters T7 introduces.
 *
 * The prompt writer is exercised against a real temporary directory because its
 * whole purpose is that the file exists before a gate opens. The clipboard is
 * exercised with injected commands so both the success and the
 * clipboard-unavailable branches run on any platform, which is what keeps Run
 * externally working where `pbcopy` does not exist.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createFsPromptFileWriter } from "../../src/adapters/fs-prompt-file-writer.ts";
import { createPbcopyClipboard, DEFAULT_CLIPBOARD_COMMAND } from "../../src/adapters/pbcopy-clipboard.ts";

const scratch = mkdtempSync(join(tmpdir(), "pi-handoff-adapters-"));

after(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("createFsPromptFileWriter", () => {
	it("writes prompt text that can be read back verbatim", async () => {
		const writer = createFsPromptFileWriter();
		const path = join(scratch, "pi-handoff-write.md");
		const result = await writer.write(path, "# Handoff\n\nDo the work.\n");
		assert.ok(result.ok);
		assert.equal(readFileSync(path, "utf8"), "# Handoff\n\nDo the work.\n");
	});

	it("overwrites an existing prompt so Edit prompt replaces the file", async () => {
		const writer = createFsPromptFileWriter();
		const path = join(scratch, "pi-handoff-overwrite.md");
		await writer.write(path, "first");
		await writer.write(path, "second");
		assert.equal(readFileSync(path, "utf8"), "second");
	});

	it("reports an unwritable path as a value", async () => {
		const writer = createFsPromptFileWriter();
		const path = join(scratch, "missing-directory", "pi-handoff.md");
		const result = await writer.write(path, "body");
		assert.equal(result.ok, false);
		assert.equal(result.ok === false ? result.error.kind : undefined, "write_failed");
		assert.equal(result.ok === false ? result.error.path : undefined, path);
	});
});

describe("createPbcopyClipboard", () => {
	it("defaults to the macOS clipboard command", () => {
		assert.equal(DEFAULT_CLIPBOARD_COMMAND, "pbcopy");
	});

	it("succeeds when the clipboard command accepts stdin", async () => {
		const clipboard = createPbcopyClipboard({ command: "cat", args: [] });
		const result = await clipboard.copy('pi --model "bifrost/claude-sonnet-5:high" @/tmp/pi-handoff-x.md');
		assert.ok(result.ok);
	});

	it("reports a missing clipboard command instead of throwing", async () => {
		const clipboard = createPbcopyClipboard({ command: "pi-handoff-no-such-clipboard-command" });
		const result = await clipboard.copy("anything");
		assert.equal(result.ok, false);
		assert.equal(result.ok === false ? result.error.kind : undefined, "clipboard_unavailable");
	});

	it("reports a non-zero exit as unavailable", async () => {
		const clipboard = createPbcopyClipboard({ command: "false", args: [] });
		const result = await clipboard.copy("anything");
		assert.equal(result.ok, false);
		assert.equal(result.ok === false ? result.error.kind : undefined, "clipboard_unavailable");
	});

	it("resolves exactly once for a failing command", async () => {
		const clipboard = createPbcopyClipboard({ command: "pi-handoff-no-such-clipboard-command" });
		const first = await clipboard.copy("anything");
		const second = await clipboard.copy("anything");
		assert.equal(first.ok, false);
		assert.equal(second.ok, false);
	});
});
