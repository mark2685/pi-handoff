/**
 * Boundary for the shared-working-tree Git operations used by a handoff.
 *
 * The worker is intentionally not isolated in a worktree, so application code
 * needs a narrow, value-oriented protocol that can checkpoint user changes and
 * later discard only paths proven to be outside that checkpoint. Keeping the
 * exec seam here avoids coupling domain and app code to Pi's full API.
 */

import type { Checkpoint } from "../domain/types.ts";
import type { Result } from "../domain/result.ts";

/** Buffered result from one argument-vector process invocation. */
export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Minimal process capability required by the Git adapter. */
export type Exec = (command: string, args: string[], options: { cwd: string }) => Promise<ExecResult>;

/** Expected Git conditions that callers should render instead of treating as extension crashes. */
export type GitFailure =
	| { kind: "not_repository"; detail: string }
	| { kind: "no_head"; detail: string }
	| { kind: "repository_changed"; checkpointRoot: string; currentRoot: string }
	| { kind: "head_changed"; checkpointHead: string; currentHead: string }
	| { kind: "invalid_checkpoint"; detail: string }
	| { kind: "invalid_porcelain"; detail: string }
	| { kind: "command_failed"; command: string; detail: string };

/** Paths acted on by Discard; skipped paths were dirty when the checkpoint was made. */
export interface DiscardOutcome {
	/** Paths restored from the checkpoint commit. */
	restoredPaths: string[];
	/** Newly introduced paths removed with one literal, per-file `git clean` call each. */
	removedPaths: string[];
	/** Current dirty paths deliberately left alone because a checkpoint status claimed them. */
	skippedPaths: string[];
}

/** Git capabilities needed by RunService and Gate B. */
export interface Git {
	/** Resolves the repository root or reports a non-repository as ordinary data. */
	repositoryRoot(cwd: string): Promise<Result<string, GitFailure>>;
	/** Captures the commit and complete path-level status that establish Discard's safety boundary. */
	checkpoint(cwd: string): Promise<Result<Checkpoint, GitFailure>>;
	/** Returns Git's display-ready diffstat against the checkpoint commit verbatim. */
	diffstat(cwd: string, checkpoint: Checkpoint): Promise<Result<string, GitFailure>>;
	/** Reverts only paths clean at checkpoint time, without creating commits or resetting the whole index. */
	discardSinceCheckpoint(cwd: string, checkpoint: Checkpoint): Promise<Result<DiscardOutcome, GitFailure>>;
}
