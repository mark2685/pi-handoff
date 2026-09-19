/**
 * Behavioral tests for the worker run, restart, Discard, and their refusals.
 *
 * Every dependency is a fake, so these assert the decisions the run service owns
 * rather than the behavior of Git or a child process. The safety-shaped ones
 * matter most: a vanished model and a failed checkpoint must refuse *before* a
 * worker spawns, an aborted run must never invent a report, a restart must reuse
 * the original checkpoint so Discard still covers every iteration, and Discard
 * must report the paths it deliberately left alone.
 *
 * The ordering assertions use a shared event log rather than call counts,
 * because "the checkpoint was taken before the spawn" is the property that makes
 * Discard safe, and a count cannot express it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHandoffMachine, type HandoffMachine, type HandoffState } from "../../src/app/handoff-machine.ts";
import {
	classifyOutcome,
	createRunService,
	stderrTail,
	type RunOutcome,
	type RunProgress,
	type RunService,
} from "../../src/app/run-service.ts";
import type { HandoffStateRecorder } from "../../src/app/state-recorder.ts";
import { err, ok, type Result } from "../../src/domain/result.ts";
import type { Checkpoint, Draft, ModelChoice } from "../../src/domain/types.ts";
import type { Clock } from "../../src/ports/clock.ts";
import type { DiscardOutcome, Git, GitFailure } from "../../src/ports/git.ts";
import type { WorkerRunOutcome, WorkerRunRequest, WorkerRunner, WorkerUsage } from "../../src/ports/worker-runner.ts";

const DRAFT: Draft = {
	slug: "add-retry-logic",
	prompt: "Implement the retry logic in src/client.ts and run `npm test`.",
	tier: "standard",
	rationale: "Two files, fully specified, one decisive validation command.",
};

const CHOICE: ModelChoice = { provider: "bifrost-openai", model: "gpt-5.6-terra", thinking: "high" };

const CHECKPOINT: Checkpoint = {
	repositoryRoot: "/repo",
	head: "abc1234",
	statuses: [{ indexStatus: " ", worktreeStatus: "M", path: "already-dirty.ts" }],
};

const USAGE: WorkerUsage = {
	inputTokens: 100,
	outputTokens: 50,
	cacheReadTokens: 10,
	cacheWriteTokens: 5,
	cost: 0.25,
	contextTokens: 1_200,
	turns: 3,
};

const PROMPT_PATH = "/tmp/pi-handoff-add-retry-logic.md";
const CWD = "/repo";
const DIFFSTAT = " src/client.ts | 12 +++++--\n 1 file changed, 9 insertions(+), 3 deletions(-)";

/** A worker outcome that completed normally, overridable per test. */
function workerOutcome(overrides: Partial<WorkerRunOutcome> = {}): WorkerRunOutcome {
	return {
		exitCode: 0,
		report: "## Summary\nAdded retry logic.",
		usage: USAGE,
		toolResults: [],
		stopReason: "endTurn",
		errorMessage: undefined,
		stderr: "",
		aborted: false,
		...overrides,
	};
}

interface Harness {
	service: RunService;
	machine: HandoffMachine;
	recorded: HandoffState[];
	requests: WorkerRunRequest[];
	events: string[];
	progress: RunProgress[];
	/** The live-registry check, now supplied per call rather than at construction. */
	runnable: () => boolean;
}

interface HarnessOptions {
	outcome?: WorkerRunOutcome;
	/** Replaces the whole worker implementation, for abort and progress tests. */
	run?: (request: WorkerRunRequest, events: string[]) => Promise<WorkerRunOutcome>;
	checkpoint?: Result<Checkpoint, GitFailure>;
	diffstat?: Result<string, GitFailure>;
	discard?: Result<DiscardOutcome, GitFailure>;
	runnable?: boolean;
	/** Fixed millisecond readings, consumed in order, so elapsed time is deterministic. */
	msReadings?: number[];
	/** Skips Gate A's transitions, leaving the machine idle to test the refusal. */
	startIdle?: boolean;
	/** Replaces the production no-progress interval with a test-sized value. */
	noProgressThresholdMs?: number;
}

function createHarness(options: HarnessOptions = {}): Harness {
	const machine = createHandoffMachine();
	const recorded: HandoffState[] = [];
	const requests: WorkerRunRequest[] = [];
	const events: string[] = [];
	const progress: RunProgress[] = [];

	if (options.startIdle !== true) {
		machine.beginDraft("add retries");
		machine.propose(DRAFT, CHOICE);
	}

	const recorder: HandoffStateRecorder = {
		record: (state) => {
			recorded.push(state);
			events.push(`record:${state.kind}`);
		},
	};

	const runner: WorkerRunner = {
		run: async (request) => {
			requests.push(request);
			events.push("spawn");
			if (options.run !== undefined) return options.run(request, events);
			return options.outcome ?? workerOutcome();
		},
	};

	const git: Git = {
		repositoryRoot: async () => ok("/repo"),
		checkpoint: async () => {
			events.push("checkpoint");
			return options.checkpoint ?? ok(CHECKPOINT);
		},
		diffstat: async () => {
			events.push("diffstat");
			return options.diffstat ?? ok(DIFFSTAT);
		},
		discardSinceCheckpoint: async () => {
			events.push("discard");
			return options.discard ?? ok({ restoredPaths: [], removedPaths: [], skippedPaths: [] });
		},
	};

	const readings = [...(options.msReadings ?? [])];
	const clock: Clock = {
		nowIso: () => "2026-03-09T09:00:00.000Z",
		nowMs: () => readings.shift() ?? 0,
	};

	const service = createRunService({
		machine,
		runner,
		git,
		clock,
		recorder,
		...(options.noProgressThresholdMs === undefined ? {} : { noProgressThresholdMs: options.noProgressThresholdMs }),
	});

	return { service, machine, recorded, requests, events, progress, runnable: () => options.runnable ?? true };
}

/** Starts a run with the standard options, collecting progress for assertions. */
async function start(harness: Harness): Promise<RunOutcome> {
	return harness.service.start({
		promptPath: PROMPT_PATH,
		cwd: CWD,
		isChoiceRunnable: harness.runnable,
		onProgress: (update) => harness.progress.push(update),
	});
}

/** Restarts a run for a feedback iteration, with the revised prompt on disk already. */
async function restart(harness: Harness, overrides: { iteration?: number; draft?: Draft } = {}): Promise<RunOutcome> {
	return harness.service.restart({
		promptPath: PROMPT_PATH,
		cwd: CWD,
		iteration: overrides.iteration ?? 2,
		draft: overrides.draft ?? { ...DRAFT, prompt: `${DRAFT.prompt}\n\n## Review feedback (iteration 2)\n\nFix it.` },
		isChoiceRunnable: harness.runnable,
		onProgress: (update) => harness.progress.push(update),
	});
}

describe("RunService.start", () => {
	it("reaches a completed review carrying the worker's verbatim report", async () => {
		const harness = createHarness();
		const outcome = await start(harness);

		assert.equal(outcome.kind, "completed");
		assert.ok(outcome.kind === "completed");
		assert.equal(outcome.state.completion, "completed");
		assert.equal(outcome.state.report, "## Summary\nAdded retry logic.");
	});

	it("records the diffstat and usage on the review state", async () => {
		const harness = createHarness();
		const outcome = await start(harness);

		assert.ok(outcome.kind === "completed");
		assert.equal(outcome.state.diffstat, DIFFSTAT);
		assert.deepEqual(outcome.state.usage, USAGE);
	});

	it("leaves the machine reviewing after a clean run", async () => {
		const harness = createHarness();
		await start(harness);

		assert.equal(harness.machine.current().kind, "reviewing");
	});

	it("passes the approved prompt path and cwd to the worker", async () => {
		const harness = createHarness();
		await start(harness);

		assert.equal(harness.requests[0]?.promptPath, PROMPT_PATH);
		assert.equal(harness.requests[0]?.cwd, CWD);
	});

	it("spawns the worker on the approved model choice", async () => {
		const harness = createHarness();
		await start(harness);

		assert.deepEqual(harness.requests[0]?.choice, CHOICE);
	});

	it("takes the checkpoint before spawning the worker", async () => {
		const harness = createHarness();
		await start(harness);

		const checkpointIndex = harness.events.indexOf("checkpoint");
		const spawnIndex = harness.events.indexOf("spawn");
		assert.ok(checkpointIndex >= 0 && spawnIndex >= 0);
		assert.ok(checkpointIndex < spawnIndex, `checkpoint (${checkpointIndex}) must precede spawn (${spawnIndex})`);
	});

	it("records the running state before the worker finishes", async () => {
		const harness = createHarness();
		await start(harness);

		assert.equal(harness.recorded[0]?.kind, "running");
	});

	it("supplies the worker an abort signal, since the command context has none", async () => {
		const harness = createHarness();
		await start(harness);

		assert.ok(harness.requests[0]?.signal instanceof AbortSignal);
	});

	it("passes the configured no-progress interval to the worker and exposes it to the overlay", async () => {
		const harness = createHarness({ noProgressThresholdMs: 25 });
		await start(harness);

		assert.equal(harness.requests[0]?.noProgressThresholdMs, 25);
		assert.equal(harness.service.noProgressThresholdMs(), 25);
	});

	it("forwards worker progress with an elapsed reading for the widget", async () => {
		const harness = createHarness({
			msReadings: [1_000, 3_500],
			run: async (request) => {
				request.onProgress?.({
					report: "partial",
					usage: USAGE,
					toolResults: [],
					stopReason: undefined,
					errorMessage: undefined,
				});
				return workerOutcome();
			},
		});
		await start(harness);

		assert.equal(harness.progress.length, 1);
		assert.equal(harness.progress[0]?.elapsedMs, 2_500);
	});
});

describe("RunService.start refusals", () => {
	it("refuses a model that vanished from the registry between Gate A and spawn", async () => {
		const harness = createHarness({ runnable: false });
		const outcome = await start(harness);

		assert.equal(outcome.kind, "model_unavailable");
	});

	it("does not spawn a worker when the model is unavailable", async () => {
		const harness = createHarness({ runnable: false });
		await start(harness);

		assert.deepEqual(harness.requests, []);
	});

	it("does not take a checkpoint when the model is unavailable", async () => {
		const harness = createHarness({ runnable: false });
		await start(harness);

		assert.ok(!harness.events.includes("checkpoint"));
	});

	it("refuses when the working directory is not a repository", async () => {
		const harness = createHarness({
			checkpoint: err({ kind: "not_repository", detail: "/repo is not a git repository" }),
		});
		const outcome = await start(harness);

		assert.ok(outcome.kind === "checkpoint_failed");
		assert.equal(outcome.failure.kind, "not_repository");
	});

	it("refuses when the repository has no commit to anchor a checkpoint", async () => {
		const harness = createHarness({ checkpoint: err({ kind: "no_head", detail: "no HEAD" }) });
		const outcome = await start(harness);

		assert.ok(outcome.kind === "checkpoint_failed");
		assert.equal(outcome.failure.kind, "no_head");
	});

	it("does not spawn a worker when the checkpoint fails", async () => {
		const harness = createHarness({ checkpoint: err({ kind: "no_head", detail: "no HEAD" }) });
		await start(harness);

		assert.deepEqual(harness.requests, []);
	});

	it("leaves the proposal intact when a checkpoint failure refuses the run", async () => {
		const harness = createHarness({ checkpoint: err({ kind: "no_head", detail: "no HEAD" }) });
		await start(harness);

		assert.equal(harness.machine.current().kind, "proposed");
	});

	it("refuses to start from a state that has no approved proposal", async () => {
		const harness = createHarness({ startIdle: true });
		const outcome = await start(harness);

		assert.ok(outcome.kind === "refused");
		assert.equal(outcome.conflict.current, "idle");
	});
});

describe("RunService.start interruptions", () => {
	it("does not fabricate a report when the run was aborted", async () => {
		const harness = createHarness({ outcome: workerOutcome({ report: "", aborted: true, exitCode: undefined }) });
		const outcome = await start(harness);

		assert.ok(outcome.kind === "interrupted");
		assert.equal(outcome.state.report, null);
	});

	it("leaves null usage and diffstat on an interrupted state rather than zeroes", async () => {
		const harness = createHarness({ outcome: workerOutcome({ report: "", aborted: true, exitCode: undefined }) });
		const outcome = await start(harness);

		assert.ok(outcome.kind === "interrupted");
		assert.equal(outcome.state.usage, null);
		assert.equal(outcome.state.diffstat, null);
	});

	it("explains an abort in the interruption note", async () => {
		const harness = createHarness({ outcome: workerOutcome({ report: "", aborted: true, exitCode: undefined }) });
		const outcome = await start(harness);

		assert.ok(outcome.kind === "interrupted");
		assert.equal(outcome.state.interruptionNote, "The worker was stopped before it reported a result.");
	});

	it("marks an aborted run as aborted rather than merely reportless", async () => {
		const harness = createHarness({ outcome: workerOutcome({ report: "", aborted: true, exitCode: undefined }) });
		const outcome = await start(harness);

		assert.ok(outcome.kind === "interrupted");
		assert.equal(outcome.aborted, true);
	});

	it("still reads a diffstat after an interruption, since the state stores none", async () => {
		const harness = createHarness({ outcome: workerOutcome({ report: "", aborted: true, exitCode: undefined }) });
		const outcome = await start(harness);

		assert.ok(outcome.kind === "interrupted");
		assert.equal(outcome.diffstat, DIFFSTAT);
	});

	it("interrupts rather than completes when the worker fails with no report", async () => {
		const harness = createHarness({
			outcome: workerOutcome({ report: "", exitCode: 1, errorMessage: "model overloaded" }),
		});
		const outcome = await start(harness);

		assert.ok(outcome.kind === "interrupted");
		assert.equal(outcome.state.interruptionNote, "The worker failed: model overloaded");
	});

	it("reports a non-zero exit that produced nothing", async () => {
		const harness = createHarness({ outcome: workerOutcome({ report: "", exitCode: 2, stopReason: undefined }) });
		const outcome = await start(harness);

		assert.ok(outcome.kind === "interrupted");
		assert.equal(outcome.state.interruptionNote, "The worker exited with code 2 without producing a report.");
	});

	it("treats a whitespace-only report as no report at all", async () => {
		const harness = createHarness({ outcome: workerOutcome({ report: "   \n  " }) });
		const outcome = await start(harness);

		assert.equal(outcome.kind, "interrupted");
	});

	/**
	 * A killed worker often has already emitted assistant text. Treating that as a
	 * completed review would let a partial, abandoned result reach Gate B as though
	 * the worker had finished, which is the exact thing an interrupted state exists
	 * to prevent.
	 */
	it("interrupts an aborted run even when the worker had already emitted text", async () => {
		const harness = createHarness({
			outcome: workerOutcome({ report: "## Summary\nHalf-done work.", aborted: true, exitCode: undefined }),
		});
		const outcome = await start(harness);

		assert.equal(outcome.kind, "interrupted");
	});

	it("does not keep an aborted run's partial text as its report", async () => {
		const harness = createHarness({
			outcome: workerOutcome({ report: "## Summary\nHalf-done work.", aborted: true, exitCode: undefined }),
		});
		const outcome = await start(harness);

		assert.ok(outcome.kind === "interrupted");
		assert.equal(outcome.state.report, null);
	});

	it("says the partial output was discarded, since the user watched it appear", async () => {
		const harness = createHarness({
			outcome: workerOutcome({ report: "## Summary\nHalf-done work.", aborted: true, exitCode: undefined }),
		});
		const outcome = await start(harness);

		assert.ok(outcome.kind === "interrupted");
		assert.equal(
			outcome.state.interruptionNote,
			"The worker was stopped mid-run. Its partial output is not treated as a report.",
		);
	});

	/**
	 * Inverted deliberately. This case used to assert that a non-zero exit with earlier
	 * text reached Gate B as a *completed* review carrying that text as its report, and
	 * that is the bug: the adapter's report is the last assistant text it saw, not the
	 * worker's conclusion. A 2h19m run whose final message was an error reached a
	 * reviewer as a completed handoff whose whole report was a mid-task sentence about
	 * terminal width, beside a 2,816-line diff.
	 */
	it("interrupts a non-zero exit even when the worker had produced text", async () => {
		const harness = createHarness({ outcome: workerOutcome({ exitCode: 1, report: "## Summary\nPartial work." }) });
		const outcome = await start(harness);

		assert.ok(outcome.kind === "interrupted");
		assert.equal(outcome.state.report, null);
	});

	it("keeps a crashed worker's text as pre-crash output rather than dropping it", async () => {
		const harness = createHarness({ outcome: workerOutcome({ exitCode: 1, report: "## Summary\nPartial work." }) });
		const outcome = await start(harness);

		assert.ok(outcome.kind === "interrupted");
		assert.equal(outcome.state.partialReport, "## Summary\nPartial work.");
	});

	it("interrupts an error stop reason even when the worker had produced text", async () => {
		const harness = createHarness({
			outcome: workerOutcome({
				exitCode: 0,
				stopReason: "error",
				report: "The pty defaulted to 80 columns… Let me set a larger window size.",
			}),
		});
		const outcome = await start(harness);

		assert.ok(outcome.kind === "interrupted");
		assert.equal(outcome.state.report, null);
		assert.match(outcome.state.interruptionNote, /ended on an error/);
	});

	it("interrupts an error message even when the worker had produced text", async () => {
		const harness = createHarness({
			outcome: workerOutcome({ exitCode: 0, errorMessage: "context length exceeded", report: "Halfway through…" }),
		});
		const outcome = await start(harness);

		assert.ok(outcome.kind === "interrupted");
		assert.match(outcome.state.interruptionNote, /context length exceeded/);
	});

	it("says the pre-crash text is not a report, since the user watched it stream in", async () => {
		const harness = createHarness({
			outcome: workerOutcome({ exitCode: 0, stopReason: "error", report: "Mid-task sentence." }),
		});
		const outcome = await start(harness);

		assert.ok(outcome.kind === "interrupted");
		assert.match(outcome.state.interruptionNote, /pre-crash output, not as a report/);
	});

	it("retains a bounded tail of a failed worker's stderr", async () => {
		const harness = createHarness({
			outcome: workerOutcome({ exitCode: 1, report: "", stderr: "pi: fatal: provider returned 503\n" }),
		});
		const outcome = await start(harness);

		assert.ok(outcome.kind === "interrupted");
		assert.equal(outcome.state.stderrTail, "pi: fatal: provider returned 503");
	});

	it("leaves a clean run's completion untouched", async () => {
		const harness = createHarness({ outcome: workerOutcome({ exitCode: 0, stopReason: "endTurn" }) });
		const outcome = await start(harness);

		assert.ok(outcome.kind === "completed");
		assert.equal(outcome.state.report, "## Summary\nAdded retry logic.");
	});

	/** A worker that never reports usage is still a clean run; only death is not. */
	it("completes a clean run whose exit code was not reported", async () => {
		const harness = createHarness({ outcome: workerOutcome({ exitCode: undefined, stopReason: "endTurn" }) });
		const outcome = await start(harness);

		assert.equal(outcome.kind, "completed");
	});

	it("surfaces a diffstat failure instead of failing the whole run", async () => {
		const harness = createHarness({
			diffstat: err({ kind: "command_failed", command: "git diff --stat", detail: "index locked" }),
		});
		const outcome = await start(harness);

		assert.ok(outcome.kind === "completed");
		assert.equal(outcome.diffstatFailure?.kind, "command_failed");
	});

	it("leaves the diffstat empty rather than storing an error message as one", async () => {
		const harness = createHarness({
			diffstat: err({ kind: "command_failed", command: "git diff --stat", detail: "index locked" }),
		});
		const outcome = await start(harness);

		assert.ok(outcome.kind === "completed");
		assert.equal(outcome.state.diffstat, "");
	});
});

describe("RunService.abortActiveRun", () => {
	it("aborts the signal the worker is watching, which is what kills the child", async () => {
		let observed: AbortSignal | undefined;
		const harness = createHarness({
			run: async (request) => {
				observed = request.signal;
				// The real adapter resolves only after SIGTERM/SIGKILL; this stands in for that.
				return new Promise<WorkerRunOutcome>((resolve) => {
					request.signal?.addEventListener("abort", () => {
						resolve(workerOutcome({ report: "", aborted: true, exitCode: undefined }));
					});
				});
			},
		});

		const running = start(harness);
		await Promise.resolve();
		const stopped = harness.service.abortActiveRun();
		const outcome = await running;

		assert.equal(stopped, true);
		assert.equal(observed?.aborted, true);
		assert.equal(outcome.kind, "interrupted");
	});

	it("reports that nothing was stopped when no worker is running", () => {
		const harness = createHarness();

		assert.equal(harness.service.abortActiveRun(), false);
	});

	it("reports no active run once a worker has finished", async () => {
		const harness = createHarness();
		await start(harness);

		assert.equal(harness.service.isRunning(), false);
	});

	it("reports an active run while the worker is in flight", async () => {
		let release: (() => void) | undefined;
		const harness = createHarness({
			run: async () =>
				new Promise<WorkerRunOutcome>((resolve) => {
					release = () => resolve(workerOutcome());
				}),
		});

		const running = start(harness);
		await Promise.resolve();
		const duringRun = harness.service.isRunning();
		release?.();
		await running;

		assert.equal(duringRun, true);
	});
});

describe("RunService.restart", () => {
	it("runs another iteration from a pending review", async () => {
		const harness = createHarness();
		await start(harness);
		const outcome = await restart(harness);

		assert.equal(outcome.kind, "completed");
	});

	/**
	 * The whole point of reusing the checkpoint: Discard after iteration 3 must still
	 * revert iteration 1's edits. A fresh checkpoint per iteration would strand them.
	 */
	it("reuses the checkpoint taken before the first iteration", async () => {
		const harness = createHarness();
		await start(harness);
		await restart(harness);

		assert.equal(harness.events.filter((event) => event === "checkpoint").length, 1);
	});

	it("carries the original checkpoint onto the restarted run state", async () => {
		const harness = createHarness();
		await start(harness);
		let observed: Checkpoint | undefined;
		const service = harness.service;
		const restarted = service.restart({
			promptPath: PROMPT_PATH,
			cwd: CWD,
			iteration: 2,
			draft: DRAFT,
			isChoiceRunnable: () => {
				observed = harness.machine.reviewing()?.checkpoint;
				return true;
			},
		});
		await restarted;

		assert.deepEqual(observed, CHECKPOINT);
	});

	it("records the given iteration on the restarted run", async () => {
		const harness = createHarness();
		await start(harness);
		const outcome = await restart(harness, { iteration: 3 });

		assert.ok(outcome.kind === "completed");
		assert.equal(outcome.state.iteration, 3);
	});

	it("runs the worker against the revised prompt's draft", async () => {
		const harness = createHarness();
		await start(harness);
		const revised: Draft = { ...DRAFT, prompt: "Revised with feedback." };
		await restart(harness, { draft: revised });

		assert.equal(harness.machine.reviewing()?.draft.prompt, "Revised with feedback.");
	});

	it("records the running state before the restarted worker finishes", async () => {
		const harness = createHarness();
		await start(harness);
		const before = harness.recorded.length;
		await restart(harness);

		assert.equal(harness.recorded[before]?.kind, "running");
	});

	it("refuses to restart when no review is pending", async () => {
		const harness = createHarness({ startIdle: true });
		const outcome = await restart(harness);

		assert.ok(outcome.kind === "refused");
		assert.equal(outcome.conflict.current, "idle");
	});

	it("refuses to restart from a proposal that never ran", async () => {
		const harness = createHarness();
		const outcome = await restart(harness);

		assert.ok(outcome.kind === "refused");
		assert.equal(outcome.conflict.current, "proposed");
	});

	it("does not spawn a worker when the restart is refused", async () => {
		const harness = createHarness({ startIdle: true });
		await restart(harness);

		assert.deepEqual(harness.requests, []);
	});

	it("refuses a restart whose model vanished from the registry", async () => {
		const harness = createHarness();
		await start(harness);
		const outcome = await harness.service.restart({
			promptPath: PROMPT_PATH,
			cwd: CWD,
			iteration: 2,
			draft: DRAFT,
			isChoiceRunnable: () => false,
		});

		assert.equal(outcome.kind, "model_unavailable");
	});

	it("leaves the review pending when a restart is refused for an unavailable model", async () => {
		const harness = createHarness();
		await start(harness);
		await harness.service.restart({
			promptPath: PROMPT_PATH,
			cwd: CWD,
			iteration: 2,
			draft: DRAFT,
			isChoiceRunnable: () => false,
		});

		assert.equal(harness.machine.current().kind, "reviewing");
	});

	it("interrupts a restarted run that produced no report", async () => {
		const harness = createHarness({ outcome: workerOutcome({ report: "", exitCode: 1 }) });
		await start(harness);
		const outcome = await restart(harness);

		assert.equal(outcome.kind, "interrupted");
	});

	it("restarts from an interrupted review, so a crashed run can be retried", async () => {
		const harness = createHarness({ outcome: workerOutcome({ report: "", exitCode: 1 }) });
		await start(harness);
		assert.equal(harness.machine.reviewing()?.completion, "interrupted");

		const outcome = await restart(harness);
		assert.notEqual(outcome.kind, "refused");
	});
});

describe("RunService.whenSettled", () => {
	/**
	 * `session_shutdown` awaits this. Aborting only requests the kill, so a hook that
	 * returned at the abort would let Pi exit while the child still held the tree.
	 */
	it("resolves only after an aborted run has finished settling", async () => {
		let resolveWorker: (() => void) | undefined;
		const harness = createHarness({
			run: async (request) =>
				new Promise<WorkerRunOutcome>((resolve) => {
					request.signal?.addEventListener("abort", () => {
						// Stands in for the adapter's SIGTERM-then-SIGKILL delay.
						resolveWorker = () => resolve(workerOutcome({ report: "", aborted: true, exitCode: undefined }));
					});
				}),
		});

		const running = start(harness);
		await Promise.resolve();
		harness.service.abortActiveRun();

		let settled = false;
		const waiting = harness.service.whenSettled().then(() => {
			settled = true;
		});

		await Promise.resolve();
		assert.equal(settled, false, "whenSettled must not resolve while the child is still dying");

		resolveWorker?.();
		await running;
		await waiting;
		assert.equal(settled, true);
	});

	it("resolves immediately when no worker is running", async () => {
		const harness = createHarness();
		await harness.service.whenSettled();
	});

	it("resolves after a run that completed normally", async () => {
		const harness = createHarness();
		await start(harness);
		await harness.service.whenSettled();

		assert.equal(harness.service.isRunning(), false);
	});
});

describe("RunService.discard", () => {
	it("reports the paths it deliberately left alone", async () => {
		const harness = createHarness({
			discard: ok({
				restoredPaths: ["src/client.ts"],
				removedPaths: ["src/new-file.ts"],
				skippedPaths: ["already-dirty.ts"],
			}),
		});
		await start(harness);
		const discarded = await harness.service.discard(CWD);

		assert.ok(discarded.ok);
		assert.deepEqual(discarded.value.skippedPaths, ["already-dirty.ts"]);
	});

	it("reports restored and removed paths separately", async () => {
		const harness = createHarness({
			discard: ok({
				restoredPaths: ["src/client.ts"],
				removedPaths: ["src/new-file.ts"],
				skippedPaths: [],
			}),
		});
		await start(harness);
		const discarded = await harness.service.discard(CWD);

		assert.ok(discarded.ok);
		assert.deepEqual(discarded.value.restoredPaths, ["src/client.ts"]);
		assert.deepEqual(discarded.value.removedPaths, ["src/new-file.ts"]);
	});

	it("returns to idle after a successful discard", async () => {
		const harness = createHarness();
		await start(harness);
		await harness.service.discard(CWD);

		assert.equal(harness.machine.current().kind, "idle");
	});

	it("refuses to discard when HEAD moved since the checkpoint", async () => {
		const harness = createHarness({
			discard: err({ kind: "head_changed", checkpointHead: "abc1234", currentHead: "def5678" }),
		});
		await start(harness);
		const discarded = await harness.service.discard(CWD);

		assert.ok(!discarded.ok);
		assert.equal(discarded.error.kind, "head_changed");
	});

	it("stays in review when a discard is refused, so the changes remain recoverable", async () => {
		const harness = createHarness({
			discard: err({ kind: "head_changed", checkpointHead: "abc1234", currentHead: "def5678" }),
		});
		await start(harness);
		await harness.service.discard(CWD);

		assert.equal(harness.machine.current().kind, "reviewing");
	});

	it("refuses to discard with no checkpointed handoff", async () => {
		const harness = createHarness({ startIdle: true });
		const discarded = await harness.service.discard(CWD);

		assert.ok(!discarded.ok);
		assert.equal(discarded.error.kind, "conflict");
	});

	it("discards against the checkpoint taken before the run", async () => {
		const harness = createHarness();
		await start(harness);
		await harness.service.discard(CWD);

		assert.ok(harness.events.includes("discard"));
	});
});

describe("RunService.diffstat", () => {
	it("reads the diffstat for the pending review", async () => {
		const harness = createHarness();
		await start(harness);
		const result = await harness.service.diffstat(CWD);

		assert.ok(result.ok);
		assert.equal(result.value, DIFFSTAT);
	});

	it("refuses with no checkpointed handoff", async () => {
		const harness = createHarness({ startIdle: true });
		const result = await harness.service.diffstat(CWD);

		assert.ok(!result.ok);
		assert.equal(result.error.kind, "conflict");
	});
});

/**
 * The external-run path exists because "Run externally" used to return to idle:
 * the extension forgot the handoff, so the user's own worker edited a tree with no
 * checkpoint, and its result came back as a pasted message with no diffstat and no
 * Discard. These assert the two halves that fix it — a checkpoint taken with no
 * spawn, and a review that reaches Gate B the same way an internal run does.
 */
describe("RunService.startExternal", () => {
	it("takes a checkpoint, exactly as a spawned run does", async () => {
		const harness = createHarness();
		await harness.service.startExternal({ cwd: CWD });

		assert.ok(harness.events.includes("checkpoint"));
	});

	it("spawns no worker, because the user runs it themselves", async () => {
		const harness = createHarness();
		await harness.service.startExternal({ cwd: CWD });

		assert.deepEqual(harness.requests, []);
	});

	it("records a running state marked external", async () => {
		const harness = createHarness();
		const outcome = await harness.service.startExternal({ cwd: CWD });

		assert.ok(outcome.kind === "external_started");
		assert.equal(outcome.state.external, true);
		assert.equal(harness.recorded.at(-1)?.kind, "running");
	});

	/** No child process was ever created, so there is nothing for shutdown to kill. */
	it("reports no active run, so shutdown does not try to kill a process", async () => {
		const harness = createHarness();
		await harness.service.startExternal({ cwd: CWD });

		assert.equal(harness.service.isRunning(), false);
		assert.equal(harness.service.abortActiveRun(), false);
	});

	it("refuses when no checkpoint can be taken", async () => {
		const harness = createHarness({ checkpoint: err({ kind: "no_head", detail: "no HEAD" }) });
		const outcome = await harness.service.startExternal({ cwd: CWD });

		assert.equal(outcome.kind, "checkpoint_failed");
	});

	it("refuses from a state with no approved proposal", async () => {
		const harness = createHarness({ startIdle: true });
		const outcome = await harness.service.startExternal({ cwd: CWD });

		assert.ok(outcome.kind === "refused");
		assert.equal(outcome.conflict.current, "idle");
	});

	it("keeps the checkpoint reachable for Discard", async () => {
		const harness = createHarness();
		await harness.service.startExternal({ cwd: CWD });
		const discarded = await harness.service.discard(CWD);

		assert.ok(discarded.ok);
		assert.ok(harness.events.includes("discard"));
	});
});

describe("RunService.completeExternal", () => {
	/** Started separately in each case, since an external run is its own precondition. */
	async function startExternal(harness: Harness): Promise<void> {
		await harness.service.startExternal({ cwd: CWD });
	}

	it("reaches a completed review carrying the pasted report", async () => {
		const harness = createHarness();
		await startExternal(harness);
		const outcome = await harness.service.completeExternal({ cwd: CWD, report: "## Summary\nDid the work." });

		assert.ok(outcome.kind === "completed");
		assert.equal(outcome.state.report, "## Summary\nDid the work.");
	});

	it("computes the diffstat against the checkpoint, as an internal run does", async () => {
		const harness = createHarness();
		await startExternal(harness);
		const outcome = await harness.service.completeExternal({ cwd: CWD, report: "done" });

		assert.ok(outcome.kind === "completed");
		assert.equal(outcome.state.diffstat, DIFFSTAT);
	});

	/** Null, never zeroes: no child process was measured, and zeroes would claim it was free. */
	it("reports null usage rather than zeroed metrics", async () => {
		const harness = createHarness();
		await startExternal(harness);
		const outcome = await harness.service.completeExternal({ cwd: CWD, report: "done" });

		assert.ok(outcome.kind === "completed");
		assert.equal(outcome.state.usage, null);
		assert.equal(outcome.state.external, true);
	});

	/**
	 * An empty paste is allowed but is not a report: Gate B's completed branch promises
	 * one, and an empty string there renders as a worker that reported nothing.
	 */
	it("treats an empty report as interrupted rather than as an empty result", async () => {
		const harness = createHarness();
		await startExternal(harness);
		const outcome = await harness.service.completeExternal({ cwd: CWD, report: "   " });

		assert.ok(outcome.kind === "interrupted");
		assert.equal(outcome.state.report, null);
		assert.match(outcome.state.interruptionNote, /ran in another terminal and no report was supplied/);
	});

	it("still reads a diffstat when no report was supplied", async () => {
		const harness = createHarness();
		await startExternal(harness);
		const outcome = await harness.service.completeExternal({ cwd: CWD, report: "" });

		assert.ok(outcome.kind === "interrupted");
		assert.equal(outcome.diffstat, DIFFSTAT);
	});

	it("refuses when no external run is in progress", async () => {
		const harness = createHarness();
		const outcome = await harness.service.completeExternal({ cwd: CWD, report: "done" });

		assert.ok(outcome.kind === "refused");
		assert.equal(outcome.conflict.attempted, "completeExternal");
	});

	/** A child-process run settles through its own spawn path, not this one. */
	it("refuses to complete an internal run through the external path", async () => {
		const harness = createHarness();
		await start(harness);
		const outcome = await harness.service.completeExternal({ cwd: CWD, report: "done" });

		assert.equal(outcome.kind, "refused");
	});

	it("surfaces a diffstat failure instead of failing the review", async () => {
		const harness = createHarness({
			diffstat: err({ kind: "command_failed", command: "git diff --stat", detail: "index locked" }),
		});
		await startExternal(harness);
		const outcome = await harness.service.completeExternal({ cwd: CWD, report: "done" });

		assert.ok(outcome.kind === "completed");
		assert.equal(outcome.diffstatFailure?.kind, "command_failed");
	});
});

describe("stderrTail", () => {
	it("keeps a short stderr whole", () => {
		assert.equal(stderrTail("pi: fatal: boom\n"), "pi: fatal: boom");
	});

	it("keeps the end, which is where the failure is", () => {
		const tail = stderrTail(`${"x".repeat(100)}THE REAL ERROR`, 20);
		assert.match(tail, /THE REAL ERROR$/);
	});

	it("marks a clipped log so it is not mistaken for the whole one", () => {
		assert.match(stderrTail("y".repeat(100), 20), /^…/);
	});

	it("bounds the retained text", () => {
		assert.equal(stderrTail("z".repeat(5_000), 100).length, 101);
	});

	it("returns empty for a worker that wrote nothing to stderr", () => {
		assert.equal(stderrTail("   \n  "), "");
	});
});

describe("classifyOutcome", () => {
	const clean = { report: "## Summary", aborted: false, exitCode: 0, stopReason: "endTurn", errorMessage: undefined };

	it("completes a clean run with a report", () => {
		assert.deepEqual(classifyOutcome(clean), { kind: "completed" });
	});

	it("interrupts an abort even with text", () => {
		assert.equal(classifyOutcome({ ...clean, aborted: true }).kind, "interrupted");
	});

	it("interrupts an error stop reason even with text", () => {
		assert.equal(classifyOutcome({ ...clean, stopReason: "error" }).kind, "interrupted");
	});

	it("interrupts a defined error message even with text", () => {
		assert.equal(classifyOutcome({ ...clean, errorMessage: "overloaded" }).kind, "interrupted");
	});

	it("interrupts a non-zero exit even with text", () => {
		assert.equal(classifyOutcome({ ...clean, exitCode: 3 }).kind, "interrupted");
	});

	it("interrupts an empty report from an otherwise clean run", () => {
		assert.equal(classifyOutcome({ ...clean, report: "  " }).kind, "interrupted");
	});

	it("carries the pre-crash text through for retention", () => {
		const classified = classifyOutcome({ ...clean, stopReason: "error" });
		assert.ok(classified.kind === "interrupted");
		assert.equal(classified.partialReport, "## Summary");
	});
});
