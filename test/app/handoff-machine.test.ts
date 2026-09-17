import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
	createHandoffMachine,
	HANDOFF_STATE_ENTRY_TYPE,
	rehydrateHandoffState,
	rehydrateLatestHandoffState,
	serializeHandoffState,
	type HandoffCompletedReviewingState,
	type HandoffConflict,
	type HandoffMachine,
	type HandoffRunningState,
} from "../../src/app/handoff-machine.ts";
import type { Result } from "../../src/domain/result.ts";
import type { Checkpoint, Draft, ModelChoice } from "../../src/domain/types.ts";
import type { WorkerUsage } from "../../src/ports/worker-runner.ts";
import { validateHandoffState } from "../../src/persistence/schemas.ts";

const draft: Draft = {
	slug: "add-handoff-state",
	prompt: "Implement the handoff state machine and run the tests.",
	tier: "standard",
	rationale: "The work is narrow but spans state and persistence.",
};

const choice: ModelChoice = {
	provider: "bifrost",
	model: "claude-sonnet-5",
	thinking: "high",
};

const checkpoint: Checkpoint = {
	repositoryRoot: "/repo",
	head: "a1b2c3d4",
	statuses: [
		{ indexStatus: "M", worktreeStatus: " ", path: "src/existing.ts" },
		{ indexStatus: "?", worktreeStatus: "?", path: "notes before handoff.md" },
	],
};

const usage: WorkerUsage = {
	inputTokens: 100,
	outputTokens: 200,
	cacheReadTokens: 300,
	cacheWriteTokens: 400,
	cost: 0.12,
	contextTokens: 500,
	turns: 2,
};

function startInput(iteration = 0) {
	return { iteration, startedAt: "2026-03-16T12:00:00.000Z", checkpoint };
}

function completedRun(machine: HandoffMachine): HandoffCompletedReviewingState {
	machine.beginDraft("state persistence");
	machine.propose(draft, choice);
	machine.startRun(startInput());
	const result = machine.completeRun({ report: "Implemented it.", diffstat: " 2 files changed", usage });
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

function assertConflict(result: Result<unknown, HandoffConflict>, current: string, attempted: string, message: string) {
	assert.deepEqual(result, { ok: false, error: { kind: "conflict", current, attempted, message } });
}

let machine: HandoffMachine;

beforeEach(() => {
	machine = createHandoffMachine();
});

describe("handoff machine", () => {
	it("starts idle with no state-specific accessor values", () => {
		assert.deepEqual(machine.current(), { kind: "idle" });
		assert.equal(machine.draft(), undefined);
		assert.equal(machine.choice(), undefined);
		assert.equal(machine.running(), undefined);
		assert.equal(machine.reviewing(), undefined);
	});

	it("begins drafting from idle", () => {
		const result = machine.beginDraft("persist session state");
		assert.deepEqual(result, { ok: true, value: { kind: "drafting", scope: "persist session state" } });
		assert.deepEqual(machine.current(), { kind: "drafting", scope: "persist session state" });
	});

	it("replaces the scope while drafting without changing the phase", () => {
		machine.beginDraft("original scope");
		const result = machine.replaceDraftScope("answered scope\n\n## Answers\n\nQ: Which?\nA: This");

		assert.deepEqual(result, {
			ok: true,
			value: { kind: "drafting", scope: "answered scope\n\n## Answers\n\nQ: Which?\nA: This" },
		});
		assert.deepEqual(machine.current(), result.ok ? result.value : undefined);
	});

	it("refuses replacing the scope outside drafting", () => {
		assertConflict(
			machine.replaceDraftScope("scope"),
			"idle",
			"replaceDraftScope",
			"A draft scope can be replaced only while drafting",
		);
	});

	it("proposes a drafted handoff", () => {
		machine.beginDraft("persist session state");
		const result = machine.propose(draft, choice);
		assert.deepEqual(result, { ok: true, value: { kind: "proposed", draft, choice } });
		assert.deepEqual(machine.draft(), draft);
		assert.deepEqual(machine.choice(), choice);
	});

	it("updates an editable proposal", () => {
		machine.beginDraft("persist session state");
		machine.propose(draft, choice);
		const revised = { ...draft, prompt: "Use the revised prompt." };
		const result = machine.updateProposal(revised, { ...choice, thinking: "xhigh" });
		assert.deepEqual(result, {
			ok: true,
			value: { kind: "proposed", draft: revised, choice: { ...choice, thinking: "xhigh" } },
		});
	});

	it("starts a worker run from a proposed handoff", () => {
		machine.beginDraft("persist session state");
		machine.propose(draft, choice);
		const result = machine.startRun(startInput());
		const expected: HandoffRunningState = { kind: "running", draft, choice, ...startInput() };
		assert.deepEqual(result, { ok: true, value: expected });
		assert.deepEqual(machine.running(), expected);
		assert.equal(machine.reviewing(), undefined);
	});

	it("records a completed worker run for Gate B", () => {
		const result = completedRun(machine);
		assert.deepEqual(result, {
			kind: "reviewing",
			completion: "completed",
			draft,
			choice,
			iteration: 0,
			checkpoint,
			report: "Implemented it.",
			diffstat: " 2 files changed",
			usage,
			awaitingReviewTurn: false,
		});
	});

	it("arms Review here only for a completed worker result", () => {
		completedRun(machine);
		const result = machine.beginReviewTurn();
		assert.deepEqual(result, {
			ok: true,
			value: {
				kind: "reviewing",
				completion: "completed",
				draft,
				choice,
				iteration: 0,
				checkpoint,
				report: "Implemented it.",
				diffstat: " 2 files changed",
				usage,
				awaitingReviewTurn: true,
			},
		});
	});

	it("clears the Review here arm while retaining the pending review", () => {
		completedRun(machine);
		machine.beginReviewTurn();
		const result = machine.clearReviewTurn();
		assert.equal(result.ok, true);
		assert.deepEqual(machine.reviewing(), {
			kind: "reviewing",
			completion: "completed",
			draft,
			choice,
			iteration: 0,
			checkpoint,
			report: "Implemented it.",
			diffstat: " 2 files changed",
			usage,
			awaitingReviewTurn: false,
		});
	});

	it("starts a feedback iteration from review with the revised prompt", () => {
		completedRun(machine);
		const revised = { ...draft, prompt: "Fix the review findings." };
		const result = machine.restartRun({ ...startInput(1), draft: revised, choice });
		assert.deepEqual(result, {
			ok: true,
			value: { kind: "running", draft: revised, choice, ...startInput(1) },
		});
	});

	/**
	 * An interrupted review has no report, so Review here is refused there. Feedback is
	 * not: re-running after a crash is exactly what a user wants from that state, and
	 * the checkpoint it carries is what makes the retry safe.
	 */
	it("starts a feedback iteration from an interrupted review", () => {
		machine.restore(rehydrateHandoffState({ kind: "running", draft, choice, ...startInput() }));
		const result = machine.restartRun({ ...startInput(2), draft, choice });
		assert.equal(result.ok, true);
		assert.equal(machine.running()?.iteration, 2);
	});

	it("resets from every active state", () => {
		const enterStates = [
			() => machine.beginDraft("scope"),
			() => {
				machine.beginDraft("scope");
				machine.propose(draft, choice);
			},
			() => {
				machine.beginDraft("scope");
				machine.propose(draft, choice);
				machine.startRun(startInput());
			},
			() => completedRun(machine),
		];
		for (const enter of enterStates) {
			machine.reset();
			enter();
			machine.reset();
			assert.deepEqual(machine.current(), { kind: "idle" });
		}
	});

	it("refuses a new handoff while a worker is running and identifies the conflict", () => {
		machine.beginDraft("scope");
		machine.propose(draft, choice);
		machine.startRun(startInput());
		const result = machine.beginDraft("another scope");
		assert.deepEqual(result, {
			ok: false,
			error: {
				kind: "conflict",
				current: "running",
				attempted: "beginDraft",
				message: "Cannot start a handoff while it is running",
			},
		});
		assert.equal(machine.current().kind, "running");
	});

	it("requires resolving a pending review before another handoff can start", () => {
		completedRun(machine);
		assert.deepEqual(machine.beginDraft("another scope"), {
			ok: false,
			error: {
				kind: "conflict",
				current: "reviewing",
				attempted: "beginDraft",
				message: "Discard or accept the pending review before starting a new handoff",
			},
		});
	});

	it("refuses a proposal unless drafting is active", () => {
		assert.deepEqual(machine.propose(draft, choice), {
			ok: false,
			error: {
				kind: "conflict",
				current: "idle",
				attempted: "propose",
				message: "A handoff must be drafting before it can be proposed",
			},
		});
	});

	it("refuses proposal edits outside Gate A", () => {
		assertConflict(
			machine.updateProposal(draft, choice),
			"idle",
			"updateProposal",
			"No proposed handoff is available to update",
		);
	});

	it("refuses a worker start before Gate A proposes a handoff", () => {
		assertConflict(
			machine.startRun(startInput()),
			"idle",
			"startRun",
			"A worker can start only from an approved handoff proposal",
		);
	});

	it("refuses a feedback run outside Gate B", () => {
		assertConflict(
			machine.restartRun({ ...startInput(1), draft, choice }),
			"idle",
			"restartRun",
			"Worker feedback can be sent only while a review is pending",
		);
	});

	it("refuses worker completion without an active worker", () => {
		assertConflict(
			machine.completeRun({ report: "", diffstat: "", usage }),
			"idle",
			"completeRun",
			"No worker run is active to complete",
		);
	});

	it("refuses Review here for an interrupted worker", () => {
		machine.restore(rehydrateHandoffState({ kind: "running", draft, choice, ...startInput() }));
		assertConflict(
			machine.beginReviewTurn(),
			"reviewing",
			"beginReviewTurn",
			"Review here requires a completed worker report",
		);
	});

	it("refuses clearing a review arm outside Gate B", () => {
		assertConflict(machine.clearReviewTurn(), "idle", "clearReviewTurn", "No review turn is awaiting completion");
	});

	it("restores a validated state", () => {
		const state: HandoffRunningState = { kind: "running", draft, choice, ...startInput() };
		machine.restore(state);
		assert.deepEqual(machine.current(), state);
	});
});

describe("handoff session persistence", () => {
	it("serializes a completed review through JSON without losing its checkpoint", () => {
		const state = completedRun(machine);
		const serialized = serializeHandoffState(state);
		const roundTripped = JSON.parse(JSON.stringify(serialized)) as unknown;
		assert.deepEqual(roundTripped, serialized);
		assert.deepEqual(roundTripped, {
			kind: "reviewing",
			completion: "completed",
			draft,
			choice,
			iteration: 0,
			checkpoint,
			report: "Implemented it.",
			diffstat: " 2 files changed",
			usage,
			awaitingReviewTurn: false,
		});
	});

	it("validates, JSON-round-trips, and rehydrates a serialized state", () => {
		const serialized = serializeHandoffState(completedRun(machine));
		const decoded = JSON.parse(JSON.stringify(serialized)) as unknown;
		const validated = validateHandoffState(decoded);
		if (!validated.ok) throw new Error(validated.error.detail);
		assert.deepEqual(rehydrateHandoffState(validated.value), serialized);
	});

	it("downgrades drafting to idle on rehydration", () => {
		assert.deepEqual(rehydrateHandoffState({ kind: "drafting", scope: "scope" }), { kind: "idle" });
	});

	it("keeps a drafting state with a persisted needs-input envelope on rehydration", () => {
		const pending = {
			kind: "drafting" as const,
			scope: "scope",
			pendingDraft: { draft, promptPath: "/tmp/pi-handoff-draft.md" },
		};
		assert.deepEqual(rehydrateHandoffState(pending), pending);
	});

	it("downgrades proposed to idle on rehydration", () => {
		assert.deepEqual(rehydrateHandoffState({ kind: "proposed", draft, choice }), { kind: "idle" });
	});

	it("downgrades a running worker to an explicitly interrupted review", () => {
		assert.deepEqual(rehydrateHandoffState({ kind: "running", draft, choice, ...startInput() }), {
			kind: "reviewing",
			completion: "interrupted",
			draft,
			choice,
			iteration: 0,
			checkpoint,
			report: null,
			diffstat: null,
			usage: null,
			interruptionNote: "The worker was interrupted because this Pi session restarted.",
			awaitingReviewTurn: false,
		});
	});

	it("keeps a completed review while clearing its stale Review here arm", () => {
		const state = completedRun(machine);
		const armed = { ...state, awaitingReviewTurn: true };
		assert.deepEqual(rehydrateHandoffState(armed), { ...armed, awaitingReviewTurn: false });
	});

	it("keeps an interrupted review while clearing its stale Review here arm", () => {
		const state = rehydrateHandoffState({ kind: "running", draft, choice, ...startInput() });
		if (state.kind !== "reviewing" || state.completion !== "interrupted") throw new Error("expected interruption");
		const armed = { ...state, awaitingReviewTurn: true };
		assert.deepEqual(rehydrateHandoffState(armed), { ...armed, awaitingReviewTurn: false });
	});

	it("treats a malformed handoff entry as no resumable state", () => {
		assert.equal(
			rehydrateLatestHandoffState([
				{ type: "custom", customType: HANDOFF_STATE_ENTRY_TYPE, data: { kind: "running" } },
			]),
			undefined,
		);
	});

	it("treats a handoff entry without data as no resumable state", () => {
		assert.equal(rehydrateLatestHandoffState([{ type: "custom", customType: HANDOFF_STATE_ENTRY_TYPE }]), undefined);
	});

	it("uses the last valid handoff entry on a session branch", () => {
		const first = serializeHandoffState({ kind: "drafting", scope: "stale" });
		const last = serializeHandoffState({ kind: "running", draft, choice, ...startInput(2) });
		assert.deepEqual(
			rehydrateLatestHandoffState([
				{ type: "custom", customType: HANDOFF_STATE_ENTRY_TYPE, data: first },
				{ type: "message", data: { ignored: true } },
				{ type: "custom", customType: HANDOFF_STATE_ENTRY_TYPE, data: last },
			]),
			rehydrateHandoffState(last),
		);
	});

	/**
	 * Session data is decoded from disk, so a sparse or truncated branch is a
	 * possible input. Rehydration that throws on one would fail the restore it
	 * exists to perform, so a null is skipped rather than dereferenced.
	 */
	it("skips a null entry rather than throwing during rehydration", () => {
		const state = serializeHandoffState({ kind: "running", draft, choice, ...startInput(1) });
		const entries = [
			null,
			{ type: "custom", customType: HANDOFF_STATE_ENTRY_TYPE, data: state },
		] as unknown as Parameters<typeof rehydrateLatestHandoffState>[0];

		assert.deepEqual(rehydrateLatestHandoffState(entries), rehydrateHandoffState(state));
	});

	it("treats a branch of only null entries as no resumable state", () => {
		const entries = [null, undefined] as unknown as Parameters<typeof rehydrateLatestHandoffState>[0];

		assert.equal(rehydrateLatestHandoffState(entries), undefined);
	});
});

describe("handoff run interruption", () => {
	/**
	 * An abort or a reportless worker failure must not fabricate a report, and must
	 * not return to idle either: the worker may already have edited the tree, and
	 * only the checkpoint held by `reviewing` can undo that.
	 */
	it("ends a run with no report as an interrupted review", () => {
		machine.beginDraft("interrupted run");
		machine.propose(draft, choice);
		machine.startRun(startInput());

		const result = machine.interruptRun("The worker was stopped before it reported a result.");

		assert.ok(result.ok);
		assert.equal(result.value.completion, "interrupted");
	});

	it("uses null rather than empty strings for the unavailable review fields", () => {
		machine.beginDraft("interrupted run");
		machine.propose(draft, choice);
		machine.startRun(startInput());

		const result = machine.interruptRun("stopped");

		assert.ok(result.ok);
		assert.equal(result.value.report, null);
		assert.equal(result.value.diffstat, null);
		assert.equal(result.value.usage, null);
	});

	it("keeps the checkpoint so the worker's changes remain discardable", () => {
		machine.beginDraft("interrupted run");
		machine.propose(draft, choice);
		machine.startRun(startInput());

		const result = machine.interruptRun("stopped");

		assert.ok(result.ok);
		assert.deepEqual(result.value.checkpoint, checkpoint);
	});

	it("records the supplied note", () => {
		machine.beginDraft("interrupted run");
		machine.propose(draft, choice);
		machine.startRun(startInput());

		const result = machine.interruptRun("The worker failed: model overloaded");

		assert.ok(result.ok);
		assert.equal(result.value.interruptionNote, "The worker failed: model overloaded");
	});

	it("refuses to interrupt when no worker is running", () => {
		assertConflict(machine.interruptRun("stopped"), "idle", "interruptRun", "No worker run is active to interrupt");
	});

	it("produces a state that survives its own schema validation", () => {
		machine.beginDraft("interrupted run");
		machine.propose(draft, choice);
		machine.startRun(startInput());
		const result = machine.interruptRun("stopped");
		assert.ok(result.ok);

		assert.ok(validateHandoffState(serializeHandoffState(result.value)).ok);
	});
});
