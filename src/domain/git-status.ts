/**
 * Parser for Git's NUL-delimited porcelain-v1 status format.
 *
 * Checkpoints must preserve literal path bytes as far as the process boundary
 * permits: line-oriented porcelain quotes spaces and escapes, while `-z` keeps
 * each path as a distinct field. Parsing stays pure and total so malformed
 * external output can be rejected by the adapter before Discard touches files.
 */

import type { CheckpointPathStatus } from "./types.ts";

/** Parsed status records plus whether the input was incomplete or structurally unsafe to trust. */
export interface PorcelainParseResult {
	entries: CheckpointPathStatus[];
	malformed: boolean;
}

/** Git porcelain status characters accepted by the v1 grammar, including type changes. */
const STATUS_CODES = " MADRCUT?!";

/** Returns whether a single-character status field is part of Git's porcelain-v1 vocabulary. */
function isStatusCode(value: string | undefined): value is string {
	return value !== undefined && value.length === 1 && STATUS_CODES.includes(value);
}

/** Returns whether a record's status represents a rename or copy with a second path field under `-z`. */
function hasOriginalPath(indexStatus: string, worktreeStatus: string): boolean {
	return indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C";
}

/**
 * Parses `git status --porcelain=v1 -z -uall` output without throwing.
 *
 * A rename/copy's first field contains its destination path and the following
 * NUL-delimited field contains its source path. The result retains both so a
 * pre-existing dirty source can keep the entire later rename out of Discard.
 */
export function parsePorcelainZ(output: string): PorcelainParseResult {
	const entries: CheckpointPathStatus[] = [];
	const fields = output.split("\0");
	let malformed = output.length > 0 && !output.endsWith("\0");

	for (let index = 0; index < fields.length; index += 1) {
		const record = fields[index];
		if (record === undefined) {
			malformed = true;
			continue;
		}
		if (record === "") {
			if (index !== fields.length - 1) malformed = true;
			continue;
		}

		const indexStatus = record[0];
		const worktreeStatus = record[1];
		const separator = record[2];
		const path = record.slice(3);
		if (!isStatusCode(indexStatus) || !isStatusCode(worktreeStatus) || separator !== " " || path === "") {
			malformed = true;
			continue;
		}

		if (hasOriginalPath(indexStatus, worktreeStatus)) {
			const originalPath = fields[index + 1];
			if (originalPath === undefined || originalPath === "") {
				malformed = true;
				continue;
			}
			entries.push({ indexStatus, worktreeStatus, path, originalPath });
			index += 1;
			continue;
		}

		entries.push({ indexStatus, worktreeStatus, path });
	}

	return { entries, malformed };
}
