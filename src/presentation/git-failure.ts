/**
 * Renders Git and handoff failures as sentences a user can act on.
 *
 * This lives on its own because both `/handoff`'s Gate A dispatch and Gate B's
 * flow need it, and having either import the other would make the two modules
 * mutually dependent. It is pure text, so it is asserted directly.
 */

import type { HandoffConflict } from "../app/handoff-machine.ts";
import type { GitFailure } from "../ports/git.ts";

/** Renders a Git failure as a sentence a user can act on. */
export function describeGitFailure(failure: GitFailure): string {
	switch (failure.kind) {
		case "not_repository":
			return `This directory is not a Git repository (${failure.detail})`;
		case "no_head":
			return `This repository has no commit to check against (${failure.detail})`;
		case "repository_changed":
			return `The repository moved from ${failure.checkpointRoot} to ${failure.currentRoot}`;
		case "head_changed":
			return `HEAD moved from ${failure.checkpointHead} to ${failure.currentHead} since the checkpoint`;
		case "invalid_checkpoint":
			return `The checkpoint could not be used (${failure.detail})`;
		case "invalid_porcelain":
			return `Git reported a status this extension could not read (${failure.detail})`;
		case "command_failed":
			return `\`${failure.command}\` failed: ${failure.detail}`;
	}
}

/**
 * Renders either failure a checkpoint-backed Git read can return.
 *
 * A conflict already carries a user-facing message, so it is passed through
 * rather than re-worded into a second vocabulary for the same condition.
 */
export function describeGitOrConflict(failure: GitFailure | HandoffConflict): string {
	return failure.kind === "conflict" ? failure.message : describeGitFailure(failure);
}
