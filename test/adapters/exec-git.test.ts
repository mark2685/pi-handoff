/**
 * Scratch-repository tests for the Git checkpoint safety boundary.
 *
 * These use the installed Git binary through the same narrow Exec seam as Pi,
 * while each repository gets its own local identity and temporary directory so
 * the tests cannot read network state or a developer's global Git config.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createExecGit } from "../../src/adapters/exec-git.ts";
import type { Checkpoint, CheckpointPathStatus } from "../../src/domain/types.ts";
import type { Exec, ExecResult, GitFailure } from "../../src/ports/git.ts";

let repoDir: string;
const git = createExecGit(realExec);

beforeEach(async () => {
	repoDir = await mkdtemp(path.join(tmpdir(), "pi-handoff-git-"));
});

afterEach(async () => {
	await rm(repoDir, { recursive: true, force: true });
});

/** Executes an argument-vector command with the same buffered result shape supplied by `pi.exec`. */
function realExec(command: string, args: string[], options: { cwd: string }): Promise<ExecResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let spawnFailure: Error | undefined;
		const child = spawn(command, args, { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			spawnFailure = error;
		});
		child.on("close", (code) => {
			if (spawnFailure) stderr += `${spawnFailure.message}\n`;
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

/** Runs Git directly only to arrange and inspect a scratch repository fixture. */
async function runGit(args: string[]): Promise<ExecResult> {
	const result = await realExec("git", args, { cwd: repoDir });
	assert.equal(result.code, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
	return result;
}

/** Initializes a repository with an explicitly local identity, independent of user configuration. */
async function initializeRepository(): Promise<void> {
	await runGit(["init", "--quiet"]);
	await runGit(["config", "user.email", "pi-handoff-test@example.invalid"]);
	await runGit(["config", "user.name", "Pi Handoff Test"]);
}

/** Writes a root-relative fixture path, including any parent directories. */
async function writeRepositoryFile(relativePath: string, content: string): Promise<void> {
	const absolutePath = path.join(repoDir, relativePath);
	await mkdir(path.dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, "utf8");
}

/** Reads a root-relative fixture path as exact UTF-8 text. */
async function readRepositoryFile(relativePath: string): Promise<string> {
	return readFile(path.join(repoDir, relativePath), "utf8");
}

/** Returns whether a root-relative path survives the operation under test. */
async function repositoryPathExists(relativePath: string): Promise<boolean> {
	try {
		await access(path.join(repoDir, relativePath));
		return true;
	} catch (error) {
		if (isErrnoWithCode(error, "ENOENT")) return false;
		throw error;
	}
}

/** Narrows filesystem errors without using `any` in the hermetic fixture helpers. */
function isErrnoWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Seeds and commits the tracked files used by a test. */
async function seedRepository(files: Record<string, string>): Promise<void> {
	await initializeRepository();
	for (const [relativePath, content] of Object.entries(files)) {
		await writeRepositoryFile(relativePath, content);
	}
	await runGit(["add", "--", ...Object.keys(files)]);
	await runGit(["commit", "--quiet", "-m", "seed"]);
}

/** Unwraps an expected successful port result with useful diagnostics if a test fixture is invalid. */
function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: GitFailure }): T {
	if (result.ok) return result.value;
	throw new Error(`expected Git result to succeed: ${JSON.stringify(result.error)}`);
}

/** Finds the one status entry for a fixture path. */
function statusFor(checkpoint: Checkpoint, relativePath: string): CheckpointPathStatus {
	const status = checkpoint.statuses.find((entry) => entry.path === relativePath);
	if (!status) throw new Error(`missing checkpoint status for ${relativePath}`);
	return status;
}

describe("exec Git adapter", () => {
	it("captures a clean repository as a JSON-round-trippable checkpoint", async () => {
		await seedRepository({ "tracked.txt": "base\n" });
		const checkpoint = expectOk(await git.checkpoint(repoDir));
		const head = (await runGit(["rev-parse", "HEAD"])).stdout.trim();
		const repositoryRoot = (await runGit(["rev-parse", "--show-toplevel"])).stdout.trim();

		assert.deepEqual(checkpoint, { repositoryRoot, head, statuses: [] });
		assert.deepEqual(JSON.parse(JSON.stringify(checkpoint)) as Checkpoint, checkpoint);
	});

	it("captures modified, staged, deleted, renamed, and individually expanded untracked paths", async () => {
		await seedRepository({
			"modified.txt": "base\n",
			"deleted.txt": "base\n",
			"rename-from.txt": "base\n",
		});
		await writeRepositoryFile("modified.txt", "user modification\n");
		await writeRepositoryFile("staged-new.txt", "user staged addition\n");
		await runGit(["add", "--", "staged-new.txt"]);
		await rm(path.join(repoDir, "deleted.txt"));
		await runGit(["mv", "--", "rename-from.txt", "renamed-to.txt"]);
		await writeRepositoryFile("untracked.txt", "user untracked\n");
		await writeRepositoryFile("pre-existing-directory/deep.txt", "user nested untracked\n");

		const checkpoint = expectOk(await git.checkpoint(repoDir));

		assert.deepEqual(statusFor(checkpoint, "modified.txt"), {
			indexStatus: " ",
			worktreeStatus: "M",
			path: "modified.txt",
		});
		assert.deepEqual(statusFor(checkpoint, "staged-new.txt"), {
			indexStatus: "A",
			worktreeStatus: " ",
			path: "staged-new.txt",
		});
		assert.deepEqual(statusFor(checkpoint, "deleted.txt"), {
			indexStatus: " ",
			worktreeStatus: "D",
			path: "deleted.txt",
		});
		assert.deepEqual(statusFor(checkpoint, "renamed-to.txt"), {
			indexStatus: "R",
			worktreeStatus: " ",
			path: "renamed-to.txt",
			originalPath: "rename-from.txt",
		});
		assert.deepEqual(statusFor(checkpoint, "untracked.txt"), {
			indexStatus: "?",
			worktreeStatus: "?",
			path: "untracked.txt",
		});
		assert.deepEqual(statusFor(checkpoint, "pre-existing-directory/deep.txt"), {
			indexStatus: "?",
			worktreeStatus: "?",
			path: "pre-existing-directory/deep.txt",
		});
		assert.equal(
			checkpoint.statuses.some((status) => status.path === "pre-existing-directory/"),
			false,
		);
	});

	it("removes a worker-created filename with spaces after a checkpoint", async () => {
		await seedRepository({ "tracked.txt": "base\n" });
		const checkpoint = expectOk(await git.checkpoint(repoDir));
		await writeRepositoryFile("worker file with spaces.txt", "worker output\n");

		const outcome = expectOk(await git.discardSinceCheckpoint(repoDir, checkpoint));

		assert.deepEqual(outcome, {
			restoredPaths: [],
			removedPaths: ["worker file with spaces.txt"],
			skippedPaths: [],
		});
		assert.equal(await repositoryPathExists("worker file with spaces.txt"), false);
	});

	it("restores a worker-renamed tracked path while removing its staged destination", async () => {
		await seedRepository({ "rename-source.txt": "base\n" });
		const checkpoint = expectOk(await git.checkpoint(repoDir));
		await runGit(["mv", "--", "rename-source.txt", "rename-destination.txt"]);

		const outcome = expectOk(await git.discardSinceCheckpoint(repoDir, checkpoint));
		const porcelain = (await runGit(["status", "--porcelain=v1", "-z", "-uall", "--"])).stdout;

		assert.deepEqual(outcome, {
			restoredPaths: ["rename-source.txt"],
			removedPaths: ["rename-destination.txt"],
			skippedPaths: [],
		});
		assert.equal(await readRepositoryFile("rename-source.txt"), "base\n");
		assert.equal(await repositoryPathExists("rename-destination.txt"), false);
		assert.equal(porcelain, "");
	});

	it("returns Git's diffstat verbatim against the checkpoint rather than the current HEAD", async () => {
		await seedRepository({ "worker-target.txt": "base\n" });
		const checkpoint = expectOk(await git.checkpoint(repoDir));
		await writeRepositoryFile("worker-target.txt", "worker change\n");
		await writeRepositoryFile("staged-worker.txt", "worker addition\n");
		await runGit(["add", "--", "staged-worker.txt"]);

		const expected = (await runGit(["diff", "--stat", checkpoint.head, "--"])).stdout;
		const diffstat = expectOk(await git.diffstat(repoDir, checkpoint));

		assert.equal(diffstat, expected);
		assert.match(diffstat, /worker-target\.txt/);
		assert.match(diffstat, /staged-worker\.txt/);
	});

	it("preserves pre-existing tracked and nested untracked work while discarding only worker paths", async () => {
		await seedRepository({
			"user-dirty.txt": "base user file\n",
			"worker-target.txt": "base worker target\n",
		});
		await writeRepositoryFile("user-dirty.txt", "pre-existing user modification\n");
		await writeRepositoryFile("user-untracked.txt", "pre-existing user untracked\n");
		await writeRepositoryFile("mixed-directory/PREEXISTING.txt", "pre-existing nested user work\n");
		const checkpoint = expectOk(await git.checkpoint(repoDir));

		await writeRepositoryFile("worker-target.txt", "worker modification\n");
		await writeRepositoryFile("worker-new.txt", "worker untracked\n");
		await writeRepositoryFile("mixed-directory/worker-added.txt", "worker file beside user work\n");
		await writeRepositoryFile("worker-directory/nested.txt", "worker nested file\n");

		const outcome = expectOk(await git.discardSinceCheckpoint(repoDir, checkpoint));

		assert.deepEqual(outcome.restoredPaths, ["worker-target.txt"]);
		assert.deepEqual(outcome.removedPaths, [
			"mixed-directory/worker-added.txt",
			"worker-directory/nested.txt",
			"worker-new.txt",
		]);
		assert.deepEqual(outcome.skippedPaths, ["user-dirty.txt", "mixed-directory/PREEXISTING.txt", "user-untracked.txt"]);
		assert.equal(await readRepositoryFile("user-dirty.txt"), "pre-existing user modification\n");
		assert.equal(await readRepositoryFile("user-untracked.txt"), "pre-existing user untracked\n");
		assert.equal(await readRepositoryFile("mixed-directory/PREEXISTING.txt"), "pre-existing nested user work\n");
		assert.equal(await readRepositoryFile("worker-target.txt"), "base worker target\n");
		assert.equal(await repositoryPathExists("worker-new.txt"), false);
		assert.equal(await repositoryPathExists("mixed-directory/worker-added.txt"), false);
		assert.equal(await repositoryPathExists("worker-directory/nested.txt"), false);
	});

	it("unstages and removes a worker addition without resetting pre-existing staged user work", async () => {
		await seedRepository({ "tracked.txt": "base\n" });
		await writeRepositoryFile("pre-existing-staged.txt", "user staged work\n");
		await runGit(["add", "--", "pre-existing-staged.txt"]);
		const checkpoint = expectOk(await git.checkpoint(repoDir));
		await writeRepositoryFile("staged-worker.txt", "worker staged addition\n");
		await runGit(["add", "--", "staged-worker.txt"]);

		const outcome = expectOk(await git.discardSinceCheckpoint(repoDir, checkpoint));
		const stagedNames = (await runGit(["diff", "--cached", "--name-only", "--"])).stdout;

		assert.deepEqual(outcome, {
			restoredPaths: [],
			removedPaths: ["staged-worker.txt"],
			skippedPaths: ["pre-existing-staged.txt"],
		});
		assert.equal(await readRepositoryFile("pre-existing-staged.txt"), "user staged work\n");
		assert.equal(stagedNames, "pre-existing-staged.txt\n");
		assert.equal(await repositoryPathExists("staged-worker.txt"), false);
	});

	it("uses the checkpoint commit for diffstat after a worker commit but refuses destructive discard", async () => {
		await seedRepository({ "worker-target.txt": "base\n" });
		const checkpoint = expectOk(await git.checkpoint(repoDir));
		await writeRepositoryFile("worker-target.txt", "committed worker change\n");
		await runGit(["add", "--", "worker-target.txt"]);
		await runGit(["commit", "--quiet", "-m", "worker commit"]);

		const diffstat = expectOk(await git.diffstat(repoDir, checkpoint));
		const discard = await git.discardSinceCheckpoint(repoDir, checkpoint);

		assert.match(diffstat, /worker-target\.txt/);
		assert.deepEqual(discard, {
			ok: false,
			error: {
				kind: "head_changed",
				checkpointHead: checkpoint.head,
				currentHead: (await runGit(["rev-parse", "HEAD"])).stdout.trim(),
			},
		});
		assert.equal(await readRepositoryFile("worker-target.txt"), "committed worker change\n");
	});

	it("returns non-repository and empty-repository conditions as values without throwing", async () => {
		const outsideRepository = await git.checkpoint(repoDir);
		assert.equal(outsideRepository.ok, false);
		assert.equal(!outsideRepository.ok && outsideRepository.error.kind, "not_repository");

		await initializeRepository();
		const emptyRepository = await git.checkpoint(repoDir);
		assert.equal(emptyRepository.ok, false);
		assert.equal(!emptyRepository.ok && emptyRepository.error.kind, "no_head");
	});

	it("keeps the adapter's execution dependency narrow enough to fake", async () => {
		const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
		const fakeExec: Exec = async (command, args, options) => {
			calls.push({ command, args, cwd: options.cwd });
			return { code: 128, stdout: "", stderr: "not a git repository" };
		};

		const root = await createExecGit(fakeExec).repositoryRoot("/not-a-repo");

		assert.deepEqual(root, { ok: false, error: { kind: "not_repository", detail: "not a git repository" } });
		assert.deepEqual(calls, [{ command: "git", args: ["rev-parse", "--show-toplevel"], cwd: "/not-a-repo" }]);
	});
});
