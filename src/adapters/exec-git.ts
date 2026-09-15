/**
 * Exec-backed implementation of Pi Handoff's Git boundary.
 *
 * A checkpoint records every pre-existing dirty path with NUL-delimited Git
 * porcelain. Discard then refuses a moved repository or changed HEAD, skips
 * every path owned by that checkpoint, and restores or cleans only remaining
 * paths. This keeps a failed worker from erasing the reviewer's prior work in
 * the shared working tree.
 */

import { parsePorcelainZ } from "../domain/git-status.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Checkpoint, CheckpointPathStatus } from "../domain/types.ts";
import type { DiscardOutcome, Exec, ExecResult, Git, GitFailure } from "../ports/git.ts";

/** Formats an external command's diagnostic without trusting it as structured data. */
function commandDetail(result: ExecResult): string {
	return result.stderr.trim() || result.stdout.trim() || `Git exited with code ${result.code}`;
}

/** Formats a thrown execution error without allowing an expected boundary failure to escape. */
function thrownDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Runs one Git command and converts non-zero exits or executor rejections into values. */
async function runGit(
	exec: Exec,
	cwd: string,
	args: string[],
	command: string,
): Promise<Result<ExecResult, GitFailure>> {
	try {
		const result = await exec("git", args, { cwd });
		return result.code === 0 ? ok(result) : err({ kind: "command_failed", command, detail: commandDetail(result) });
	} catch (error) {
		return err({ kind: "command_failed", command, detail: thrownDetail(error) });
	}
}

/** Summarizes a boundary failure when it must be wrapped in a more specific expected condition. */
function failureDetail(failure: GitFailure): string {
	switch (failure.kind) {
		case "not_repository":
		case "no_head":
		case "invalid_checkpoint":
		case "invalid_porcelain":
		case "command_failed":
			return failure.detail;
		case "repository_changed":
			return `repository changed from ${failure.checkpointRoot} to ${failure.currentRoot}`;
		case "head_changed":
			return `HEAD changed from ${failure.checkpointHead} to ${failure.currentHead}`;
	}
}

/** Reads HEAD after repository-root resolution, where a no-commit repository is an expected outcome. */
async function readHead(exec: Exec, cwd: string): Promise<Result<string, GitFailure>> {
	const result = await runGit(exec, cwd, ["rev-parse", "HEAD"], "git rev-parse HEAD");
	if (!result.ok) return err({ kind: "no_head", detail: failureDetail(result.error) });

	const head = result.value.stdout.trim();
	return head ? ok(head) : err({ kind: "no_head", detail: "git rev-parse HEAD produced no commit" });
}

/** Parses a complete, root-relative status snapshot or refuses to use malformed porcelain. */
async function readStatus(exec: Exec, cwd: string): Promise<Result<CheckpointPathStatus[], GitFailure>> {
	const result = await runGit(
		exec,
		cwd,
		["--literal-pathspecs", "status", "--porcelain=v1", "-z", "-uall", "--"],
		"git status --porcelain=v1 -z -uall --",
	);
	if (!result.ok) return result;

	const parsed = parsePorcelainZ(result.value.stdout);
	return parsed.malformed
		? err({ kind: "invalid_porcelain", detail: "git status returned malformed NUL-delimited porcelain" })
		: ok(parsed.entries);
}

/** Returns the literal paths claimed by any dirty checkpoint entry, including both sides of a rename. */
function checkpointDirtyPaths(checkpoint: Checkpoint): Result<Set<string>, GitFailure> {
	if (
		typeof checkpoint.repositoryRoot !== "string" ||
		typeof checkpoint.head !== "string" ||
		!checkpoint.repositoryRoot ||
		!checkpoint.head
	) {
		return err({ kind: "invalid_checkpoint", detail: "checkpoint is missing its repository root or HEAD commit" });
	}
	if (!Array.isArray(checkpoint.statuses)) {
		return err({ kind: "invalid_checkpoint", detail: "checkpoint is missing its status entries" });
	}

	const paths = new Set<string>();
	for (const status of checkpoint.statuses) {
		if (
			typeof status.path !== "string" ||
			typeof status.indexStatus !== "string" ||
			typeof status.worktreeStatus !== "string" ||
			!status.path
		) {
			return err({ kind: "invalid_checkpoint", detail: "checkpoint contains an invalid status entry" });
		}
		paths.add(status.path);
		if (status.originalPath !== undefined) {
			if (typeof status.originalPath !== "string" || !status.originalPath) {
				return err({ kind: "invalid_checkpoint", detail: "checkpoint contains an empty rename source" });
			}
			paths.add(status.originalPath);
		}
	}

	return ok(paths);
}

/** Resolves a checkpoint's repository again and refuses to apply it across repository boundaries. */
async function checkpointRoot(git: Git, cwd: string, checkpoint: Checkpoint): Promise<Result<string, GitFailure>> {
	const root = await git.repositoryRoot(cwd);
	if (!root.ok) return root;
	return root.value === checkpoint.repositoryRoot
		? root
		: err({ kind: "repository_changed", checkpointRoot: checkpoint.repositoryRoot, currentRoot: root.value });
}

/** Reads the paths present in the checkpoint tree with NUL output so unusual filenames stay literal. */
async function trackedAtCheckpoint(
	exec: Exec,
	cwd: string,
	checkpoint: Checkpoint,
	paths: readonly string[],
): Promise<Result<Set<string>, GitFailure>> {
	const result = await runGit(
		exec,
		cwd,
		["--literal-pathspecs", "ls-tree", "-z", "--name-only", checkpoint.head, "--", ...paths],
		"git ls-tree",
	);
	if (!result.ok) return result;
	return ok(new Set(result.value.stdout.split("\0").filter((path) => path !== "")));
}

/** Performs the small, explicit set of commands that resets only verified worker paths. */
async function discardPaths(
	exec: Exec,
	cwd: string,
	checkpoint: Checkpoint,
	paths: readonly string[],
	trackedPaths: ReadonlySet<string>,
	skippedPaths: string[],
): Promise<Result<DiscardOutcome, GitFailure>> {
	const restoredPaths = paths.filter((path) => trackedPaths.has(path));
	const removedPaths = paths.filter((path) => !trackedPaths.has(path));

	const reset = await runGit(
		exec,
		cwd,
		["--literal-pathspecs", "reset", checkpoint.head, "--", ...paths],
		"git reset <checkpoint> -- <paths>",
	);
	if (!reset.ok) return reset;

	if (restoredPaths.length > 0) {
		const checkout = await runGit(
			exec,
			cwd,
			["--literal-pathspecs", "checkout", checkpoint.head, "--", ...restoredPaths],
			"git checkout <checkpoint> -- <paths>",
		);
		if (!checkout.ok) return checkout;
	}

	for (const path of removedPaths) {
		const clean = await runGit(exec, cwd, ["--literal-pathspecs", "clean", "-f", "--", path], "git clean -f -- <path>");
		if (!clean.ok) return clean;
	}

	return ok({ restoredPaths, removedPaths, skippedPaths });
}

/** Creates the Git adapter used by the later composition root. */
export function createExecGit(exec: Exec): Git {
	const git: Git = {
		async repositoryRoot(cwd: string): Promise<Result<string, GitFailure>> {
			try {
				const result = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
				const root = result.stdout.trim();
				return result.code === 0 && root ? ok(root) : err({ kind: "not_repository", detail: commandDetail(result) });
			} catch (error) {
				return err({ kind: "not_repository", detail: thrownDetail(error) });
			}
		},

		async checkpoint(cwd: string): Promise<Result<Checkpoint, GitFailure>> {
			const root = await git.repositoryRoot(cwd);
			if (!root.ok) return root;

			const head = await readHead(exec, root.value);
			if (!head.ok) return head;
			const statuses = await readStatus(exec, root.value);
			if (!statuses.ok) return statuses;

			return ok({ repositoryRoot: root.value, head: head.value, statuses: statuses.value });
		},

		async diffstat(cwd: string, checkpoint: Checkpoint): Promise<Result<string, GitFailure>> {
			const root = await checkpointRoot(git, cwd, checkpoint);
			if (!root.ok) return root;

			const result = await runGit(
				exec,
				root.value,
				["--literal-pathspecs", "diff", "--stat", checkpoint.head, "--"],
				"git diff --stat <checkpoint> --",
			);
			return result.ok ? ok(result.value.stdout) : result;
		},

		async discardSinceCheckpoint(cwd: string, checkpoint: Checkpoint): Promise<Result<DiscardOutcome, GitFailure>> {
			const checkpointPaths = checkpointDirtyPaths(checkpoint);
			if (!checkpointPaths.ok) return checkpointPaths;

			const root = await checkpointRoot(git, cwd, checkpoint);
			if (!root.ok) return root;
			const currentHead = await readHead(exec, root.value);
			if (!currentHead.ok) return currentHead;
			if (currentHead.value !== checkpoint.head) {
				return err({ kind: "head_changed", checkpointHead: checkpoint.head, currentHead: currentHead.value });
			}

			const currentStatuses = await readStatus(exec, root.value);
			if (!currentStatuses.ok) return currentStatuses;

			const candidatePaths = new Set<string>();
			const skippedPaths = new Set<string>();
			for (const status of currentStatuses.value) {
				const paths = status.originalPath === undefined ? [status.path] : [status.path, status.originalPath];
				if (paths.some((path) => checkpointPaths.value.has(path))) {
					for (const path of paths) skippedPaths.add(path);
					continue;
				}
				for (const path of paths) candidatePaths.add(path);
			}

			const paths = [...candidatePaths];
			if (paths.length === 0) {
				return ok({ restoredPaths: [], removedPaths: [], skippedPaths: [...skippedPaths] });
			}

			const trackedPaths = await trackedAtCheckpoint(exec, root.value, checkpoint, paths);
			if (!trackedPaths.ok) return trackedPaths;
			return discardPaths(exec, root.value, checkpoint, paths, trackedPaths.value, [...skippedPaths]);
		},
	};

	return git;
}
