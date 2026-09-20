/**
 * End-to-end coverage for the checkpoint boundary: a real Git repository, the real
 * RunService and Gate B flow, and the shared fake Pi worker. No Pi process, model,
 * credentials, or network access is involved.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChildProcessWorkerRunner } from "../../src/adapters/child-process-worker-runner.ts";
import { createExecGit } from "../../src/adapters/exec-git.ts";
import { createHandoffMachine } from "../../src/app/handoff-machine.ts";
import { createReviewService } from "../../src/app/review-service.ts";
import { createRunService } from "../../src/app/run-service.ts";
import { createGateBFlow } from "../../src/commands/gate-b-flow.ts";
import { ok } from "../../src/domain/result.ts";
import type { Draft, ModelChoice } from "../../src/domain/types.ts";
import type { ExecResult } from "../../src/ports/git.ts";
import { writeFakeWorker } from "../adapters/fake-worker.ts";

const CHOICE: ModelChoice = { provider: "test-provider", model: "test-model", thinking: "high" };
const DRAFT: Draft = {
	slug: "scratch-discard",
	prompt: "# Scratch discard\n\nMutate the scratch repository.",
	tier: "routine",
	rationale: "End-to-end test fixture.",
};

let scratchRepository: string | undefined;
let workerDirectory: string | undefined;

/** Removes both temporary directories even when a setup step or assertion fails. */
afterEach(async () => {
	await Promise.all(
		[scratchRepository, workerDirectory]
			.filter((directory): directory is string => directory !== undefined)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
	scratchRepository = undefined;
	workerDirectory = undefined;
});

/** Executes an argument-vector command with the buffered shape supplied by Pi's exec adapter. */
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
			if (spawnFailure !== undefined) stderr += `${spawnFailure.message}\n`;
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

/** Runs Git directly only to arrange and inspect the scratch-repository fixture. */
async function runGit(args: string[]): Promise<ExecResult> {
	if (scratchRepository === undefined) throw new Error("scratch repository was not initialized");
	const result = await realExec("git", args, { cwd: scratchRepository });
	assert.equal(result.code, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
	return result;
}

/** Writes a root-relative fixture file, including parent directories. */
async function writeScratchFile(relativePath: string, content: string): Promise<void> {
	if (scratchRepository === undefined) throw new Error("scratch repository was not initialized");
	const filePath = path.join(scratchRepository, relativePath);
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, content, "utf8");
}

async function readScratchFile(relativePath: string): Promise<string> {
	if (scratchRepository === undefined) throw new Error("scratch repository was not initialized");
	return readFile(path.join(scratchRepository, relativePath), "utf8");
}

async function scratchFileExists(relativePath: string): Promise<boolean> {
	if (scratchRepository === undefined) throw new Error("scratch repository was not initialized");
	try {
		await access(path.join(scratchRepository, relativePath));
		return true;
	} catch (error) {
		if (isErrnoWithCode(error, "ENOENT")) return false;
		throw error;
	}
}

function isErrnoWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

describe("handoff scratch-repository end to end", () => {
	it("runs through Gate B and discards only worker changes since the checkpoint", async () => {
		scratchRepository = await mkdtemp(path.join(tmpdir(), "pi-handoff-e2e-"));
		await runGit(["init", "--quiet"]);
		await runGit(["config", "user.email", "pi-handoff-test@example.invalid"]);
		await runGit(["config", "user.name", "Pi Handoff Test"]);
		await writeScratchFile("worker-edit.txt", "checkpoint version\n");
		await writeScratchFile("pre-existing.txt", "checkpoint version\n");
		await runGit(["add", "worker-edit.txt", "pre-existing.txt"]);
		await runGit(["commit", "--quiet", "-m", "seed"]);

		// This is unrelated work that predates the handoff checkpoint and must survive Discard.
		await writeScratchFile("pre-existing.txt", "user work before checkpoint\n");

		workerDirectory = await mkdtemp(path.join(tmpdir(), "pi-handoff-e2e-worker-"));
		const fakeWorkerPath = await writeFakeWorker(workerDirectory);
		const promptPath = path.join(workerDirectory, "mutates-scratch.md");
		await writeFile(promptPath, DRAFT.prompt, "utf8");

		const machine = createHandoffMachine();
		assert.ok(machine.beginDraft("exercise discard").ok);
		assert.ok(machine.propose(DRAFT, CHOICE).ok);

		const git = createExecGit(realExec);
		const runner = createChildProcessWorkerRunner({
			getInvocation: (args) => ({ command: process.execPath, args: [fakeWorkerPath, ...args] }),
		});
		const clock = { nowIso: () => "2026-03-18T12:00:00.000Z", nowMs: () => 0 };
		const recorder = { record: () => {} };
		const runService = createRunService({ machine, runner, git, clock, recorder });
		const reviewService = createReviewService({
			machine,
			runService,
			promptWriter: { write: async () => ok(undefined) },
			reportRecorder: { record: () => {} },
			recorder,
			clock,
			maxIterations: 3,
		});

		let customCall = 0;
		const notifications: string[] = [];
		const ctx = {
			mode: "tui",
			hasUI: true,
			cwd: scratchRepository,
			ui: {
				// The first custom surface is Gate B; the second is Discard's mandatory acknowledgement.
				custom: async () => {
					customCall += 1;
					return customCall === 1 ? "discard" : undefined;
				},
				select: async () => "Discard the worker's changes",
				notify: (message: string) => notifications.push(message),
			},
		} as unknown as ExtensionContext;
		const gateB = createGateBFlow({
			machine,
			runService,
			reviewService,
			clock,
			isChoiceRunnable: () => true,
			sendUserMessage: () => {},
		});

		const outcome = await runService.start({ promptPath, cwd: scratchRepository, isChoiceRunnable: () => true });
		assert.equal(outcome.kind, "completed");
		if (outcome.kind !== "completed") return;
		assert.equal(machine.current().kind, "reviewing", "a completed worker must reach Gate B");
		assert.ok(
			outcome.state.checkpoint.statuses.some((status) => status.path === "pre-existing.txt"),
			"the checkpoint must record dirty work that predates the worker",
		);
		assert.equal(await readScratchFile("worker-edit.txt"), "worker edit\n");
		assert.equal(await readScratchFile("worker-created.txt"), "worker created\n");
		assert.equal(await readScratchFile("pre-existing.txt"), "user work before checkpoint\n");
		assert.match(outcome.state.diffstat, /worker-edit\.txt/);

		const gateBView = gateB.viewFromOutcome({ slug: DRAFT.slug, choice: CHOICE, promptPath }, outcome);
		assert.notEqual(gateBView, undefined);
		if (gateBView === undefined) return;
		await gateB.run(ctx, gateBView);

		assert.equal(customCall, 2, "Gate B must show Discard and then require its acknowledgement");
		assert.equal(machine.current().kind, "idle", "successful Discard must close the handoff");
		assert.equal(await readScratchFile("worker-edit.txt"), "checkpoint version\n");
		assert.equal(await scratchFileExists("worker-created.txt"), false);
		assert.equal(
			await readScratchFile("pre-existing.txt"),
			"user work before checkpoint\n",
			"Discard must preserve unrelated work that was dirty at checkpoint time",
		);
		assert.equal((await runGit(["status", "--porcelain"])).stdout, " M pre-existing.txt\n");
		assert.deepEqual(notifications, []);
	});
});
