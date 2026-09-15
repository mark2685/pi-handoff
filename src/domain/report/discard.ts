/**
 * Pure rendering of what Discard actually did.
 *
 * This exists because "Discard changes" is not a full undo, and the gap is
 * silent unless something says so. A path that was already dirty when the
 * checkpoint was taken is left alone even if the worker edited it too, so the
 * worker's edit to that path survives. A user who reads Discard as "put my tree
 * back" would be wrong about their own working tree and have no indication of it.
 *
 * Skipped paths are therefore rendered first, with an explicit warning, rather
 * than appended as a footnote after the successful-sounding restored and removed
 * lists. The warning names the consequence, not just the count.
 *
 * `DiscardPaths` restates the port's `DiscardOutcome` fields so domain code does
 * not depend on a port; the structural match lets callers pass the outcome.
 */

/** The path lists returned by a discard, declared without a port dependency. */
export interface DiscardPaths {
	restoredPaths: readonly string[];
	removedPaths: readonly string[];
	/** Paths left untouched because a checkpoint status already claimed them. */
	skippedPaths: readonly string[];
}

/** Renders a path list under a heading, or nothing when the list is empty. */
function pathSection(heading: string, paths: readonly string[]): string[] {
	if (paths.length === 0) return [];
	return [heading, ...paths.map((path) => `  ${path}`)];
}

/** True when a discard left worker changes in place, which the user must be told. */
export function hasSkippedPaths(outcome: DiscardPaths): boolean {
	return outcome.skippedPaths.length > 0;
}

/**
 * Builds the lines shown after a discard.
 *
 * The skipped-path warning leads because it is the only part of this summary that
 * describes something still wrong with the tree.
 */
export function formatDiscardSummary(outcome: DiscardPaths): string[] {
	const lines: string[] = [];

	if (hasSkippedPaths(outcome)) {
		const count = outcome.skippedPaths.length;
		lines.push(
			`Warning: ${count} path${count === 1 ? "" : "s"} ${count === 1 ? "was" : "were"} NOT reverted.`,
			`${count === 1 ? "It was" : "They were"} already modified before the worker started, so Discard left`,
			`${count === 1 ? "it" : "them"} alone. Any worker change to ${count === 1 ? "this path" : "these paths"} is still present.`,
			"",
			...pathSection("Left as they were (review these yourself):", outcome.skippedPaths),
			"",
		);
	}

	const restored = pathSection("Reverted to their checkpoint state:", outcome.restoredPaths);
	const removed = pathSection("Deleted, having been created during the run:", outcome.removedPaths);

	if (restored.length > 0) lines.push(...restored, "");
	if (removed.length > 0) lines.push(...removed, "");

	if (outcome.restoredPaths.length === 0 && outcome.removedPaths.length === 0) {
		lines.push("No files needed reverting; the worker left no changes outside the checkpoint.", "");
	}

	// Trailing blank lines are an artifact of section joining, not part of the content.
	while (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Builds the one-line notification shown when a discard completes. */
export function formatDiscardHeadline(outcome: DiscardPaths): string {
	const reverted = outcome.restoredPaths.length + outcome.removedPaths.length;
	const base = `Discarded ${reverted} path${reverted === 1 ? "" : "s"}`;
	if (!hasSkippedPaths(outcome)) return base;
	const skipped = outcome.skippedPaths.length;
	return `${base}; ${skipped} path${skipped === 1 ? "" : "s"} left untouched because ${skipped === 1 ? "it was" : "they were"} already modified`;
}
