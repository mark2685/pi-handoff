/**
 * Filesystem implementation of the prompt-file boundary.
 *
 * Writes are deliberately non-atomic and unconditional: the target lives in
 * `/tmp`, is named from a normalized slug, and is rewritten by Edit prompt, so
 * a partially written file has no consequence beyond a retry. An unwritable
 * `/tmp` is an ordinary environment condition, so it is reported as a value
 * rather than thrown at whatever gate happened to be opening.
 */

import { writeFile } from "node:fs/promises";
import { err, ok, type Result } from "../domain/result.ts";
import type { PromptFileWriter, PromptWriteFailure } from "../ports/prompt-file-writer.ts";

/** Formats a rejected write without trusting the error's shape. */
function writeDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Creates a writer that persists prompts with UTF-8 encoding. */
export function createFsPromptFileWriter(): PromptFileWriter {
	return {
		async write(path: string, contents: string): Promise<Result<void, PromptWriteFailure>> {
			try {
				await writeFile(path, contents, "utf8");
				return ok(undefined);
			} catch (error) {
				return err({ kind: "write_failed", path, detail: writeDetail(error) });
			}
		},
	};
}
