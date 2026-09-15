/**
 * Boundary for writing the temporary handoff prompt file.
 *
 * The prompt must exist on disk before Gate A opens so the external fallback
 * and manual inspection work even if the extension fails immediately
 * afterwards. That makes writing it a correctness step rather than a
 * convenience, so it gets a port the app layer can depend on and tests can
 * observe, instead of a direct `node:fs` call buried in a service.
 */

import type { Result } from "../domain/result.ts";

/** Expected write conditions a gate should render rather than treat as an extension crash. */
export interface PromptWriteFailure {
	kind: "write_failed";
	path: string;
	detail: string;
}

/** Writes approved prompt text to a path built by `buildPromptPath`. */
export interface PromptFileWriter {
	write(path: string, contents: string): Promise<Result<void, PromptWriteFailure>>;
}
