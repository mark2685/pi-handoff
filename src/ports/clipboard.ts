/**
 * Boundary for placing the launch command on the system clipboard.
 *
 * Copying is best-effort by design: `pbcopy` is macOS-only, so every caller
 * must stay correct when the clipboard is unavailable. This port therefore
 * reports failure as an ordinary value, and Run externally falls back to
 * showing the command so the feature keeps working on other platforms.
 */

import type { Result } from "../domain/result.ts";

/** Expected clipboard conditions, including a platform with no clipboard command. */
export interface ClipboardFailure {
	kind: "clipboard_unavailable";
	detail: string;
}

/** Copies one line of text to the system clipboard. */
export interface Clipboard {
	copy(text: string): Promise<Result<void, ClipboardFailure>>;
}
