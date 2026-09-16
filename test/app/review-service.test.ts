/**
 * Behavioral tests for Gate B's decisions.
 *
 * Three of these exist because of specific ways this can go wrong rather than to
 * cover the happy path.
 *
 * Accept must record the idle state, not just reach it. A reset without a record
 * leaves the last persisted entry saying a review is pending, so a resumed session
 * rehydrates an accepted handoff back into `reviewing` — and its Discard would
 * revert work the user already accepted.
 *
 * The iteration bound must be refused by the service, not only greyed out in the
 * menu, and the refusal must land before anything is written or transitioned.
 *
 * A prompt-write failure must leave the machine in `reviewing`. The worker reads
 * the file, so a machine that moved to `running` against an unwritten prompt would
 * spawn a worker with stale instructions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHandoffMachine, type HandoffMachine, type HandoffState } from "../../src/app/handoff-machine.ts";
import { createReviewService, type ReviewService } from "../../src/app/review-service.ts";
import { createRunService, type RunService } from "../../src/app/run-service.ts";
import type { HandoffReportEntry, HandoffReportRecorder, HandoffStateRecorder } from "../../src/app/state-recorder.ts";
import { err, ok, type Result } from "../../src/domain/result.ts";
import type { Checkpoint, Draft, ModelChoice } from "../../src/domain/types.ts";
import type { Clock } from "../../src/ports/clock.ts";
import type { Git } from "../../src/ports/git.ts";
import type { PromptFileWriter, PromptWriteFailure } from "../../src/ports/prompt-file-writer.ts";
import type { WorkerRunner, WorkerRunOutcome, WorkerUsage } from "../../src/ports/worker-runner.ts";

const DRAFT: Draft = {
	slug: "add-retry-logic",
	prompt: "# Add retry logic\n\nImplement the retry logic in src/client.ts and run `npm test`.",
	tier: "standard",
	rationale: "Two files, fully specified.",
};

const CHOICE: ModelChoice = { provider: "bifrost-openai", model: "gpt-5.6-terra", thinking: "high" };

const CHECKPOINT: Checkpoint = {
	repositoryRoot: "/repo",
	head: "abc1234",
	statuses: [],
};

const USAGE: WorkerUsage = {
	inputTokens: 100,
	outputTokens: 50,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cost: 0.25,
	contextTokens: 1_200,
	turns: 3,
};

const CWD = "/repo";
const DIFFSTAT = " src/client.ts | 12 +++++--";
const REPORT = "## Summary\nAdded retry logic.";
const PROMPT_PATH = "/tmp/pi-handoff-add-retry-logic.md";

interface Harness {
	service: ReviewService;
	runService: RunService;
	machine: HandoffMachine;
	recorded: HandoffState[];
	reports: HandoffReportEntry[];
	writes: { path: string; contents: string }[];
	events: string[];
}

interface HarnessOptions {
	maxIterations?: number;
	write?: Result<void, PromptWriteFailure>;
	/** Leaves the machine idle so the no-review refusals can be asserted. */
	startIdle?: boolean;
	/** Reaches an interrupted review instead of a completed one. */
	interrupted?: boolean;
}

function createHarness(options: HarnessOptions = {}): Harness {
	const machine = createHandoffMachine();
	const recorded: HandoffState[] = [];
	const reports: HandoffReportEntry[] = [];
	const writes: { path: string; contents: string }[] = [];
	const events: string[] = [];

	const recorder: HandoffStateRecorder = {
		record: (state) => {
			recorded.push(state);
			events.push(`record:${state.kind}`);
		},
	};

	const reportRecorder: HandoffReportRecorder = {
		record: (entry) => {
			reports.push(entry);
			events.push("report");
		},
	};

	const promptWriter: PromptFileWriter = {
		write: async (path, contents) => {
			writes.push({ path, contents });
			events.push("write");
			return options.write ?? ok(undefined);
		},
	};

	const workerOutcome: WorkerRunOutcome = {
		exitCode: 0,
		report: REPORT,
		usage: USAGE,
		toolResults: [],
		stopReason: "endTurn",
		errorMessage: undefined,
		stderr: "",
		aborted: false,
	};

	const runner: WorkerRunner = {
		run: async () => {
			events.push("spawn");
			return options.interrupted === true ? { ...workerOutcome, report: "", exitCode: 1 } : workerOutcome;
		},
	};

	const git: Git = {
		repositoryRoot: async () => ok("/repo"),
		checkpoint: async () => ok(CHECKPOINT),
		diffstat: async () => ok(DIFFSTAT),
		discardSinceCheckpoint: async () => ok({ restoredPaths: [], removedPaths: [], skippedPaths: [] }),
	};

	const clock: Clock = {
		nowIso: () => "2026-03-09T09:00:00.000Z",
		nowMs: () => 0,
	};

	const runService = createRunService({ machine, runner, git, clock, recorder });

	const service = createReviewService({
		machine,
		runService,
		promptWriter,
		reportRecorder,
		recorder,
		clock,
		maxIterations: options.maxIterations ?? 3,
	});

	return { service, runService, machine, recorded, reports, writes, events };
}

/** Drives the machine to a pending review, which is Gate B's precondition. */
async function reachReview(harness: Harness): Promise<void> {
	harness.machine.beginDraft("add retries");
	harness.machine.propose(DRAFT, CHOICE);
	await harness.runService.start({ promptPath: PROMPT_PATH, cwd: CWD, isChoiceRunnable: () => true });
}

/** Drives the machine to a pending review at a specific iteration. */
async function reachReviewAtIteration(harness: Harness, iteration: number): Promise<void> {
	await reachReview(harness);
	for (let next = 2; next <= iteration; next += 1) {
		await harness.runService.restart({
			promptPath: PROMPT_PATH,
			cwd: CWD,
			iteration: next,
			draft: DRAFT,
			isChoiceRunnable: () => true,
		});
	}
}

describe("ReviewService.accept", () => {
	it("returns to idle", async () => {
		const harness = createHarness();
		await reachReview(harness);
		harness.service.accept();

		assert.equal(harness.machine.current().kind, "idle");
	});

	/**
	 * The safety property. Without this record, the last persisted entry still says
	 * `reviewing`, so a resumed session would offer to Discard accepted work.
	 */
	it("records the idle state, so a resumed session cannot discard accepted work", async () => {
		const harness = createHarness();
		await reachReview(harness);
		harness.service.accept();

		assert.equal(harness.recorded.at(-1)?.kind, "idle");
	});

	it("records the accepted report in the transcript", async () => {
		const harness = createHarness();
		await reachReview(harness);
		harness.service.accept();

		assert.equal(harness.reports[0]?.report, REPORT);
	});

	it("records the model and iteration alongside the report", async () => {
		const harness = createHarness();
		await reachReview(harness);
		harness.service.accept();

		assert.equal(harness.reports[0]?.model, "bifrost-openai/gpt-5.6-terra:high");
		assert.equal(harness.reports[0]?.iteration, 1);
	});

	it("records the report before resetting, so the reset cannot lose it", async () => {
		const harness = createHarness();
		await reachReview(harness);
		harness.service.accept();

		const reportIndex = harness.events.indexOf("report");
		const idleIndex = harness.events.lastIndexOf("record:idle");
		assert.ok(reportIndex >= 0 && idleIndex >= 0);
		assert.ok(reportIndex < idleIndex);
	});

	it("reports that no report was recorded for an interrupted run", async () => {
		const harness = createHarness({ interrupted: true });
		await reachReview(harness);
		const accepted = harness.service.accept();

		assert.ok(accepted.ok);
		assert.equal(accepted.value.reportRecorded, false);
	});

	it("records no report entry for an interrupted run", async () => {
		const harness = createHarness({ interrupted: true });
		await reachReview(harness);
		harness.service.accept();

		assert.deepEqual(harness.reports, []);
	});

	it("still records the idle state when an interrupted run is accepted", async () => {
		const harness = createHarness({ interrupted: true });
		await reachReview(harness);
		harness.service.accept();

		assert.equal(harness.recorded.at(-1)?.kind, "idle");
	});

	it("refuses to accept with no pending review", () => {
		const harness = createHarness();
		const accepted = harness.service.accept();

		assert.ok(!accepted.ok);
		assert.equal(accepted.error.kind, "conflict");
	});
});

describe("ReviewService review turn", () => {
	it("arms the review turn on a completed review", async () => {
		const harness = createHarness();
		await reachReview(harness);
		const armed = harness.service.beginReview();

		assert.ok(armed.ok);
		assert.equal(armed.value.awaitingReviewTurn, true);
	});

	it("records the armed state so a restart does not lose the arm's absence", async () => {
		const harness = createHarness();
		await reachReview(harness);
		harness.service.beginReview();

		assert.equal(harness.recorded.at(-1)?.kind, "reviewing");
	});

	it("refuses to arm a review turn for an interrupted run, which has no report", async () => {
		const harness = createHarness({ interrupted: true });
		await reachReview(harness);
		const armed = harness.service.beginReview();

		assert.ok(!armed.ok);
	});

	it("clears the arm, which is what makes a second agent_end inert", async () => {
		const harness = createHarness();
		await reachReview(harness);
		harness.service.beginReview();
		const cleared = harness.service.clearReview();

		assert.ok(cleared.ok);
		assert.equal(cleared.value.awaitingReviewTurn, false);
	});

	it("captures reviewer text and its parsed verdict while clearing the arm", async () => {
		const harness = createHarness();
		await reachReview(harness);
		harness.service.beginReview();
		const cleared = harness.service.clearReview("The timeout path needs coverage.\nVerdict: fix\n");

		assert.ok(cleared.ok);
		assert.deepEqual(cleared.value.review, {
			iteration: 1,
			verdict: "fix",
			text: "The timeout path needs coverage.\nVerdict: fix\n",
		});
	});

	it("keeps captured text with an unparseable verdict", async () => {
		const harness = createHarness();
		await reachReview(harness);
		harness.service.beginReview();
		const cleared = harness.service.clearReview("I cannot make a recommendation.");

		assert.ok(cleared.ok);
		assert.deepEqual(cleared.value.review, { iteration: 1, text: "I cannot make a recommendation." });
	});

	it("keeps the review pending after the arm is cleared", async () => {
		const harness = createHarness();
		await reachReview(harness);
		harness.service.beginReview();
		harness.service.clearReview();

		assert.equal(harness.machine.current().kind, "reviewing");
	});

	it("refuses to clear an arm with no pending review", () => {
		const harness = createHarness();
		const cleared = harness.service.clearReview();

		assert.ok(!cleared.ok);
	});
});

describe("ReviewService.buildReviewMessage", () => {
	it("includes the worker's report verbatim", async () => {
		const harness = createHarness();
		await reachReview(harness);
		const reviewing = harness.machine.reviewing();
		assert.ok(reviewing);
		const message = harness.service.buildReviewMessage(reviewing);

		assert.ok(message.includes(REPORT));
	});

	it("includes the diffstat", async () => {
		const harness = createHarness();
		await reachReview(harness);
		const reviewing = harness.machine.reviewing();
		assert.ok(reviewing);

		assert.ok(harness.service.buildReviewMessage(reviewing).includes(DIFFSTAT.trim()));
	});

	it("states the iteration under review", async () => {
		const harness = createHarness();
		await reachReview(harness);
		const reviewing = harness.machine.reviewing();
		assert.ok(reviewing);

		assert.ok(harness.service.buildReviewMessage(reviewing).includes("iteration 1"));
	});

	it("asks for the one-line verdict that the reopened gate sits under", async () => {
		const harness = createHarness();
		await reachReview(harness);
		const reviewing = harness.machine.reviewing();
		assert.ok(reviewing);
		const message = harness.service.buildReviewMessage(reviewing);

		assert.ok(message.includes("Verdict:"));
		assert.ok(message.includes("accept"));
		assert.ok(message.includes("fix"));
		assert.ok(message.includes("discard"));
	});

	it("tells the reviewer not to edit files, which would escape the checkpoint", async () => {
		const harness = createHarness();
		await reachReview(harness);
		const reviewing = harness.machine.reviewing();
		assert.ok(reviewing);

		assert.ok(harness.service.buildReviewMessage(reviewing).includes("Do not edit"));
	});

	/** The prompt is on disk and can be huge; inlining it would spend the context this protects. */
	it("references the prompt by path rather than pasting it", async () => {
		const harness = createHarness();
		await reachReview(harness);
		const reviewing = harness.machine.reviewing();
		assert.ok(reviewing);
		const message = harness.service.buildReviewMessage(reviewing);

		assert.ok(message.includes(PROMPT_PATH));
		assert.ok(!message.includes("Implement the retry logic in src/client.ts"));
	});

	it("explains the absence of a report for an interrupted run", async () => {
		const harness = createHarness({ interrupted: true });
		await reachReview(harness);
		const reviewing = harness.machine.reviewing();
		assert.ok(reviewing);

		assert.ok(harness.service.buildReviewMessage(reviewing).includes("produced no report"));
	});
});

describe("ReviewService.feedbackAllowance", () => {
	it("allows feedback on the first of three iterations", async () => {
		const harness = createHarness();
		await reachReview(harness);

		assert.equal(harness.service.feedbackAllowance()?.allowed, true);
	});

	it("refuses feedback once the last iteration is under review", async () => {
		const harness = createHarness();
		await reachReviewAtIteration(harness, 3);

		assert.equal(harness.service.feedbackAllowance()?.allowed, false);
	});

	it("reports the numbers the refusal message needs", async () => {
		const harness = createHarness();
		await reachReviewAtIteration(harness, 3);

		assert.deepEqual(harness.service.feedbackAllowance(), { allowed: false, iteration: 3, maxIterations: 3 });
	});

	it("reports nothing with no pending review", () => {
		const harness = createHarness();

		assert.equal(harness.service.feedbackAllowance(), undefined);
	});
});

describe("ReviewService.sendFeedback", () => {
	it("runs the next iteration", async () => {
		const harness = createHarness();
		await reachReview(harness);
		const sent = await harness.service.sendFeedback({
			feedback: "Handle the timeout case too.",
			cwd: CWD,
			isChoiceRunnable: () => true,
		});

		assert.ok(sent.ok);
		assert.equal(sent.value.kind, "completed");
	});

	it("increments the iteration", async () => {
		const harness = createHarness();
		await reachReview(harness);
		const sent = await harness.service.sendFeedback({
			feedback: "Handle the timeout case too.",
			cwd: CWD,
			isChoiceRunnable: () => true,
		});

		assert.ok(sent.ok && sent.value.kind === "completed");
		assert.equal(sent.value.state.iteration, 2);
	});

	it("appends the feedback to the prompt file the worker reads", async () => {
		const harness = createHarness();
		await reachReview(harness);
		await harness.service.sendFeedback({
			feedback: "Handle the timeout case too.",
			cwd: CWD,
			isChoiceRunnable: () => true,
		});

		assert.equal(harness.writes[0]?.path, PROMPT_PATH);
		assert.ok(harness.writes[0]?.contents.includes("## Review feedback (iteration 2)"));
		assert.ok(
			harness.writes[0]?.contents.includes(
				"This is iteration 2. The working tree already contains the previous iteration's changes against checkpoint `abc1234`; do not start over and do not revert them unless the feedback below says to.",
			),
		);
		assert.ok(harness.writes[0]?.contents.includes("Handle the timeout case too."));
	});

	it("keeps the approved prompt above the appended feedback", async () => {
		const harness = createHarness();
		await reachReview(harness);
		await harness.service.sendFeedback({
			feedback: "Handle the timeout case too.",
			cwd: CWD,
			isChoiceRunnable: () => true,
		});

		assert.ok(harness.writes[0]?.contents.startsWith("# Add retry logic"));
	});

	it("carries the revised prompt onto the restarted state", async () => {
		const harness = createHarness();
		await reachReview(harness);
		await harness.service.sendFeedback({
			feedback: "Handle the timeout case too.",
			cwd: CWD,
			isChoiceRunnable: () => true,
		});

		assert.ok(harness.machine.reviewing()?.draft.prompt.includes("Handle the timeout case too."));
	});

	it("writes the prompt before spawning the worker", async () => {
		const harness = createHarness();
		await reachReview(harness);
		harness.events.length = 0;
		await harness.service.sendFeedback({
			feedback: "Handle the timeout case too.",
			cwd: CWD,
			isChoiceRunnable: () => true,
		});

		const writeIndex = harness.events.indexOf("write");
		const spawnIndex = harness.events.indexOf("spawn");
		assert.ok(writeIndex >= 0 && spawnIndex >= 0);
		assert.ok(writeIndex < spawnIndex);
	});
});

describe("ReviewService.sendFeedback refusals", () => {
	/** The bound is the design's non-negotiable; the menu label is only a hint. */
	it("refuses at exactly the iteration bound", async () => {
		const harness = createHarness();
		await reachReviewAtIteration(harness, 3);
		const sent = await harness.service.sendFeedback({
			feedback: "One more thing.",
			cwd: CWD,
			isChoiceRunnable: () => true,
		});

		assert.ok(!sent.ok);
		assert.equal(sent.error.kind, "bound_reached");
	});

	it("reports the iteration numbers in the bound refusal", async () => {
		const harness = createHarness();
		await reachReviewAtIteration(harness, 3);
		const sent = await harness.service.sendFeedback({
			feedback: "One more thing.",
			cwd: CWD,
			isChoiceRunnable: () => true,
		});

		assert.ok(!sent.ok && sent.error.kind === "bound_reached");
		assert.equal(sent.error.iteration, 3);
		assert.equal(sent.error.maxIterations, 3);
	});

	it("allows the second-to-last iteration, so the bound is not off by one", async () => {
		const harness = createHarness();
		await reachReviewAtIteration(harness, 2);
		const sent = await harness.service.sendFeedback({
			feedback: "One more thing.",
			cwd: CWD,
			isChoiceRunnable: () => true,
		});

		assert.ok(sent.ok);
	});

	it("writes nothing when the bound refuses the iteration", async () => {
		const harness = createHarness();
		await reachReviewAtIteration(harness, 3);
		harness.writes.length = 0;
		await harness.service.sendFeedback({
			feedback: "One more thing.",
			cwd: CWD,
			isChoiceRunnable: () => true,
		});

		assert.deepEqual(harness.writes, []);
	});

	it("leaves the review pending when the bound refuses the iteration", async () => {
		const harness = createHarness();
		await reachReviewAtIteration(harness, 3);
		await harness.service.sendFeedback({
			feedback: "One more thing.",
			cwd: CWD,
			isChoiceRunnable: () => true,
		});

		assert.equal(harness.machine.current().kind, "reviewing");
	});

	it("refuses blank feedback", async () => {
		const harness = createHarness();
		await reachReview(harness);
		const sent = await harness.service.sendFeedback({ feedback: "   \n ", cwd: CWD, isChoiceRunnable: () => true });

		assert.ok(!sent.ok);
		assert.equal(sent.error.kind, "empty_feedback");
	});

	it("writes nothing for blank feedback, so no empty section reaches the prompt", async () => {
		const harness = createHarness();
		await reachReview(harness);
		await harness.service.sendFeedback({ feedback: "   \n ", cwd: CWD, isChoiceRunnable: () => true });

		assert.deepEqual(harness.writes, []);
	});

	it("treats a verdict-only submission as empty after normalization", async () => {
		const harness = createHarness();
		await reachReview(harness);
		harness.writes.length = 0;
		harness.events.length = 0;
		const sent = await harness.service.sendFeedback({
			feedback: "**Verdict:** fix",
			cwd: CWD,
			isChoiceRunnable: () => true,
		});

		assert.ok(!sent.ok);
		assert.equal(sent.error.kind, "empty_feedback");
		assert.deepEqual(harness.writes, []);
		assert.ok(!harness.events.includes("spawn"));
		assert.equal(harness.machine.reviewing()?.iteration, 1);
	});

	/** The worker reads the file, so a machine that moved anyway would run a stale prompt. */
	it("leaves the machine reviewing when the prompt file cannot be rewritten", async () => {
		const harness = createHarness({
			write: err({ kind: "write_failed", path: PROMPT_PATH, detail: "read-only filesystem" }),
		});
		await reachReview(harness);
		await harness.service.sendFeedback({ feedback: "Fix it.", cwd: CWD, isChoiceRunnable: () => true });

		assert.equal(harness.machine.current().kind, "reviewing");
	});

	it("reports the write failure rather than spawning a worker", async () => {
		const harness = createHarness({
			write: err({ kind: "write_failed", path: PROMPT_PATH, detail: "read-only filesystem" }),
		});
		await reachReview(harness);
		harness.events.length = 0;
		const sent = await harness.service.sendFeedback({ feedback: "Fix it.", cwd: CWD, isChoiceRunnable: () => true });

		assert.ok(!sent.ok);
		assert.equal(sent.error.kind, "write_failed");
		assert.ok(!harness.events.includes("spawn"));
	});

	it("refuses feedback with no pending review", async () => {
		const harness = createHarness();
		const sent = await harness.service.sendFeedback({ feedback: "Fix it.", cwd: CWD, isChoiceRunnable: () => true });

		assert.ok(!sent.ok);
		assert.equal(sent.error.kind, "conflict");
	});

	it("passes the model check through to the restart", async () => {
		const harness = createHarness();
		await reachReview(harness);
		const sent = await harness.service.sendFeedback({
			feedback: "Fix it.",
			cwd: CWD,
			isChoiceRunnable: () => false,
		});

		assert.ok(sent.ok);
		assert.equal(sent.value.kind, "model_unavailable");
	});

	it("allows feedback from an interrupted review, so a crashed run can be retried", async () => {
		const harness = createHarness({ interrupted: true });
		await reachReview(harness);
		const sent = await harness.service.sendFeedback({
			feedback: "It crashed; try again.",
			cwd: CWD,
			isChoiceRunnable: () => true,
		});

		assert.ok(sent.ok);
		assert.notEqual(sent.value.kind, "refused");
	});
});
