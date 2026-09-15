/**
 * `pbcopy`-backed implementation of the clipboard boundary.
 *
 * `pbcopy` exists only on macOS, so this adapter treats a missing command, a
 * non-zero exit, and a spawn rejection as the same ordinary outcome: the
 * clipboard is unavailable. Run externally then shows the command instead, which
 * is why no path here throws. The command is injectable so tests can exercise
 * both branches without depending on the host platform.
 */

import { spawn } from "node:child_process";
import { err, ok, type Result } from "../domain/result.ts";
import type { Clipboard, ClipboardFailure } from "../ports/clipboard.ts";

/** The macOS clipboard command used when no override is supplied. */
export const DEFAULT_CLIPBOARD_COMMAND = "pbcopy";

export interface PbcopyClipboardOptions {
	/** Replaces `pbcopy` in tests, or on a platform with a different clipboard tool. */
	command?: string;
	args?: string[];
}

/** Creates a clipboard that pipes text to a clipboard command's stdin. */
export function createPbcopyClipboard(options: PbcopyClipboardOptions = {}): Clipboard {
	const command = options.command ?? DEFAULT_CLIPBOARD_COMMAND;
	const args = options.args ?? [];

	return {
		copy(text: string): Promise<Result<void, ClipboardFailure>> {
			return new Promise((resolve) => {
				let settled = false;
				/** Guards against `error` and `close` both firing for one failed spawn. */
				const settle = (result: Result<void, ClipboardFailure>) => {
					if (settled) return;
					settled = true;
					resolve(result);
				};

				try {
					const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
					let stderr = "";

					child.stderr?.on("data", (chunk: Buffer) => {
						stderr += chunk.toString();
					});

					child.on("error", (error: Error) => {
						settle(err({ kind: "clipboard_unavailable", detail: error.message }));
					});

					child.on("close", (code: number | null) => {
						if (code === 0) {
							settle(ok(undefined));
							return;
						}
						const detail = stderr.trim() || `${command} exited with code ${code ?? "unknown"}`;
						settle(err({ kind: "clipboard_unavailable", detail }));
					});

					// A stdin rejection after spawn (for example EPIPE) is the same ordinary failure.
					child.stdin?.on("error", (error: Error) => {
						settle(err({ kind: "clipboard_unavailable", detail: error.message }));
					});
					child.stdin?.end(text);
				} catch (error) {
					settle(
						err({
							kind: "clipboard_unavailable",
							detail: error instanceof Error ? error.message : String(error),
						}),
					);
				}
			});
		},
	};
}
