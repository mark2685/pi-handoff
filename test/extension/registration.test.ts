/**
 * Contract tests for the extension entry point.
 *
 * These load the real `index.ts` and drive it through a stub `ExtensionAPI`,
 * pinning the registration surface: one command, no tools, and exactly the four
 * lifecycle hooks the design's §4 names.
 *
 * The review-turn assertions are the important ones. `agent_end` and
 * `agent_settled` fire on every ordinary turn in every session, including sessions
 * with no handoff, so they are tested for inertness rather than for their effect: no
 * UI, no state change, and no session entry unless a Review here turn armed them.
 *
 * Their split is asserted end to end here, because only the entry point wires it:
 * `agent_end` captures the review and opens nothing, and `agent_settled` reopens
 * Gate B without being awaited. The reopen is therefore observed after a flush
 * rather than on the handler's own promise. `agent_end` can also fire more than once
 * per prompt, since `_runAgentPrompt` loops on auto-retry, so the last capture is
 * the one that reaches the gate.
 *
 * The non-interactive assertions matter beyond registration: `npm run smoke` runs
 * `/handoff status` headlessly, so status must not touch a TUI surface, and
 * drafting must refuse cleanly instead of hanging on a gate that cannot open.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import handoff from "../../index.ts";
import { HANDOFF_COMMAND, HANDOFF_COMMAND_NAME } from "../../src/commands/parse.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-handoff-registration-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

after(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(testAgentDir, { recursive: true, force: true });
});

interface RegisteredCommand {
	name: string;
	description?: string;
	handler: (args: string, ctx: unknown) => unknown;
}

interface Recorder {
	api: ExtensionAPI;
	commands: Map<string, RegisteredCommand>;
	tools: unknown[];
	hooks: Map<string, unknown[]>;
	entries: { customType: string; data?: unknown }[];
	messages: { content: string; options?: unknown }[];
}

/** Builds a stub ExtensionAPI that records everything the extension registers. */
function createRecorder(): Recorder {
	const commands = new Map<string, RegisteredCommand>();
	const tools: unknown[] = [];
	const hooks = new Map<string, unknown[]>();
	const entries: { customType: string; data?: unknown }[] = [];
	const messages: { content: string; options?: unknown }[] = [];

	const api = {
		registerCommand(name: string, options: Omit<RegisteredCommand, "name">) {
			commands.set(name, { name, ...options });
		},
		registerTool(tool: unknown) {
			tools.push(tool);
		},
		on(event: string, handler: unknown) {
			hooks.set(event, [...(hooks.get(event) ?? []), handler]);
		},
		appendEntry(customType: string, data?: unknown) {
			entries.push({ customType, data });
		},
		sendUserMessage(content: string, options?: unknown) {
			messages.push({ content, options });
		},
	} as unknown as ExtensionAPI;

	return { api, commands, tools, hooks, entries, messages };
}

/** Invokes the single handler registered for an event, failing if there is not exactly one. */
async function fireHook(recorder: Recorder, event: string, eventPayload: unknown, ctx: unknown): Promise<void> {
	const handlers = recorder.hooks.get(event);
	assert.ok(handlers, `no handler registered for ${event}`);
	assert.equal(handlers.length, 1, `expected exactly one ${event} handler`);
	await (handlers[0] as (event: unknown, ctx: unknown) => unknown)(eventPayload, ctx);
}

/**
 * Lets work a handler launched but did not await reach its next suspension point.
 *
 * The reopen is deliberately detached, so there is no promise to await from out here;
 * that is the property under test, not a shortcut.
 */
async function flush(): Promise<void> {
	for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A resumable session holding a completed run whose review is pending and unarmed.
 *
 * Shared because it is the only starting point from which `/handoff` can arm a review
 * turn, and both the follow-up delivery test and the capture/reopen tests need to
 * start there rather than from idle.
 */
const COMPLETED_REVIEW_BRANCH = [
	{
		type: "custom",
		customType: "handoff-state",
		data: {
			kind: "reviewing",
			completion: "completed",
			draft: { slug: "add-retries", prompt: "Do it.", tier: "standard", rationale: "Because." },
			choice: { provider: "bifrost", model: "claude-sonnet-5", thinking: "high" },
			iteration: 1,
			checkpoint: { repositoryRoot: "/repo", head: "abc1234", statuses: [] },
			report: "Did it.",
			diffstat: " 1 file changed",
			usage: {
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cost: 0,
				contextTokens: 1,
				turns: 1,
			},
			awaitingReviewTurn: false,
		},
	},
];

/** The shape `agent_end` carries a reviewer's text in, as the real event's messages do. */
function assistantMessage(text: string) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

interface Notification {
	message: string;
	level?: string;
}

/** Builds a context whose mode and model are configurable, recording notifications. */
interface CommandContextOptions {
	mode?: string;
	hasModel?: boolean;
	branch?: unknown[];
	customResult?: unknown;
	/** Consumed one per overlay, for flows that render more than one gate. */
	customResults?: unknown[];
}

function createCommandContext(options: CommandContextOptions = {}) {
	const notifications: Notification[] = [];
	const uiCalls: string[] = [];
	const ctx = {
		mode: options.mode ?? "print",
		hasUI: false,
		cwd: "/repo",
		model: options.hasModel === true ? { provider: "bifrost", id: "claude-sonnet-5" } : undefined,
		modelRegistry: {
			getAvailable: () => [{ provider: "bifrost", id: "claude-sonnet-5" }],
		},
		sessionManager: {
			getBranch: () => options.branch ?? [],
		},
		ui: {
			notify: (message: string, level?: string) => {
				notifications.push({ message, ...(level === undefined ? {} : { level }) });
			},
			setEditorText: () => {},
			// Any of these firing from a lifecycle hook in an idle session is the bug the
			// agent_end tests exist to catch, so they record rather than render.
			select: async () => {
				uiCalls.push("select");
				return undefined;
			},
			custom: async () => {
				uiCalls.push("custom");
				return options.customResults === undefined ? options.customResult : options.customResults.shift();
			},
			editor: async () => {
				uiCalls.push("editor");
				return undefined;
			},
		},
	};
	return { ctx, notifications, uiCalls };
}

describe("extension registration", () => {
	let recorder: Recorder;

	beforeEach(() => {
		recorder = createRecorder();
		handoff(recorder.api);
	});

	it("registers exactly one command named handoff", () => {
		assert.equal(HANDOFF_COMMAND_NAME, "handoff");
		assert.equal(HANDOFF_COMMAND, "/handoff");
		assert.deepEqual([...recorder.commands.keys()], ["handoff"]);
	});

	it("describes the command for the slash-command list", () => {
		assert.equal(
			recorder.commands.get(HANDOFF_COMMAND_NAME)?.description,
			"Draft and run a review-preserving implementation handoff.",
		);
	});

	it("registers no tools", () => {
		assert.equal(recorder.tools.length, 0);
	});

	it("registers exactly the four lifecycle hooks the design names", () => {
		assert.deepEqual([...recorder.hooks.keys()].sort(), [
			"agent_end",
			"agent_settled",
			"session_shutdown",
			"session_start",
		]);
	});

	it("registers one handler per hook, so no gate can open twice", () => {
		for (const [event, handlers] of recorder.hooks) {
			assert.equal(handlers.length, 1, `${event} must have exactly one handler`);
		}
	});

	it("appends no session entries at registration time", () => {
		assert.deepEqual(recorder.entries, []);
	});

	it("reports idle for /handoff status", async () => {
		const command = recorder.commands.get(HANDOFF_COMMAND_NAME);
		assert.ok(command);
		const { ctx, notifications } = createCommandContext();
		await command.handler("status", ctx);
		assert.deepEqual(notifications, [{ message: "Handoff: idle", level: "info" }]);
	});

	it("reports status without appending an entry", async () => {
		const command = recorder.commands.get(HANDOFF_COMMAND_NAME);
		assert.ok(command);
		const { ctx } = createCommandContext();
		await command.handler("status", ctx);
		assert.deepEqual(recorder.entries, []);
	});

	it("refuses drafting outside interactive mode instead of opening a gate", async () => {
		const command = recorder.commands.get(HANDOFF_COMMAND_NAME);
		assert.ok(command);
		const { ctx, notifications } = createCommandContext({ hasModel: true });
		await command.handler("add retries", ctx);
		assert.deepEqual(notifications, [
			{
				message: `${HANDOFF_COMMAND} requires interactive mode; use ${HANDOFF_COMMAND} status elsewhere`,
				level: "error",
			},
		]);
	});

	it("refuses drafting in a TUI session with no model selected", async () => {
		const command = recorder.commands.get(HANDOFF_COMMAND_NAME);
		assert.ok(command);
		const { ctx, notifications } = createCommandContext({ mode: "tui", hasModel: false });
		await command.handler("add retries", ctx);
		assert.deepEqual(notifications, [
			{ message: "No model is selected, so a handoff cannot be drafted", level: "error" },
		]);
	});

	it("reports subcommands owned by later tasks as unimplemented", async () => {
		const command = recorder.commands.get(HANDOFF_COMMAND_NAME);
		assert.ok(command);
		const { ctx, notifications } = createCommandContext();
		await command.handler("abort", ctx);
		await command.handler("config", ctx);
		assert.deepEqual(notifications, [
			{ message: `${HANDOFF_COMMAND} abort is not implemented yet`, level: "info" },
			{ message: `${HANDOFF_COMMAND} config is not implemented yet`, level: "info" },
		]);
	});
});

describe("session_start rehydration", () => {
	let recorder: Recorder;

	beforeEach(() => {
		recorder = createRecorder();
		handoff(recorder.api);
	});

	it("leaves a session with no handoff entries idle", async () => {
		const command = recorder.commands.get(HANDOFF_COMMAND_NAME);
		assert.ok(command);
		const { ctx, notifications } = createCommandContext();
		await fireHook(recorder, "session_start", { type: "session_start", reason: "startup" }, ctx);
		await command.handler("status", ctx);

		assert.deepEqual(notifications, [{ message: "Handoff: idle", level: "info" }]);
	});

	it("opens no UI while restoring", async () => {
		const { ctx, uiCalls, notifications } = createCommandContext();
		await fireHook(recorder, "session_start", { type: "session_start", reason: "resume" }, ctx);

		assert.deepEqual(uiCalls, []);
		assert.deepEqual(notifications, []);
	});

	/** A worker cannot survive a restart, so a persisted `running` entry must come back as a review. */
	it("downgrades an interrupted worker run to a pending review", async () => {
		const command = recorder.commands.get(HANDOFF_COMMAND_NAME);
		assert.ok(command);
		const branch = [
			{
				type: "custom",
				customType: "handoff-state",
				data: {
					kind: "running",
					draft: { slug: "add-retries", prompt: "Do it.", tier: "standard", rationale: "Because." },
					choice: { provider: "bifrost", model: "claude-sonnet-5", thinking: "high" },
					iteration: 1,
					startedAt: "2026-03-09T09:00:00.000Z",
					checkpoint: { repositoryRoot: "/repo", head: "abc1234", statuses: [] },
				},
			},
		];
		const { ctx, notifications } = createCommandContext({ branch });
		await fireHook(recorder, "session_start", { type: "session_start", reason: "resume" }, ctx);
		await command.handler("status", ctx);

		assert.match(notifications[0]?.message ?? "", /review interrupted for add-retries/);
	});

	it("resets a new session even when the previous one held a handoff", async () => {
		const command = recorder.commands.get(HANDOFF_COMMAND_NAME);
		assert.ok(command);
		const { ctx: resumed } = createCommandContext({
			branch: [
				{
					type: "custom",
					customType: "handoff-state",
					data: {
						kind: "running",
						draft: { slug: "add-retries", prompt: "Do it.", tier: "standard", rationale: "Because." },
						choice: { provider: "bifrost", model: "claude-sonnet-5", thinking: "high" },
						iteration: 1,
						startedAt: "2026-03-09T09:00:00.000Z",
						checkpoint: { repositoryRoot: "/repo", head: "abc1234", statuses: [] },
					},
				},
			],
		});
		await fireHook(recorder, "session_start", { type: "session_start", reason: "resume" }, resumed);

		// A "new" session's branch is empty, which is what returns the machine to idle.
		const { ctx: fresh, notifications } = createCommandContext();
		await fireHook(recorder, "session_start", { type: "session_start", reason: "new" }, fresh);
		await command.handler("status", fresh);

		assert.deepEqual(notifications, [{ message: "Handoff: idle", level: "info" }]);
	});

	it("delivers Review here as a follow-up and arms the next review turn", async () => {
		const command = recorder.commands.get(HANDOFF_COMMAND_NAME);
		assert.ok(command);
		const { ctx } = createCommandContext({ mode: "tui", branch: COMPLETED_REVIEW_BRANCH, customResult: "review" });
		await fireHook(recorder, "session_start", { type: "session_start", reason: "resume" }, ctx);
		await command.handler("", ctx);

		const message = recorder.messages[0];
		assert.ok(message);
		assert.deepEqual(message.options, { expandPromptTemplates: false, deliverAs: "followUp" });
		assert.equal((recorder.entries.at(-1)?.data as { awaitingReviewTurn?: boolean }).awaitingReviewTurn, true);
	});
});

describe("session_shutdown cleanup", () => {
	let recorder: Recorder;

	beforeEach(() => {
		recorder = createRecorder();
		handoff(recorder.api);
	});

	it("returns without doing anything when no worker is running", async () => {
		const { ctx, uiCalls, notifications } = createCommandContext();
		await fireHook(recorder, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		assert.deepEqual(uiCalls, []);
		assert.deepEqual(notifications, []);
	});

	/** State must survive: the recorded `running` entry is what session_start downgrades. */
	it("appends no session entry, so the running entry stays the recovery record", async () => {
		const { ctx } = createCommandContext();
		await fireHook(recorder, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		assert.deepEqual(recorder.entries, []);
	});
});

describe("review-turn capture and reopen", () => {
	let recorder: Recorder;

	beforeEach(() => {
		recorder = createRecorder();
		handoff(recorder.api);
	});

	/** Arms a review turn the way Review here does, leaving Gate B's first render behind. */
	async function armReviewTurn(options: { customResults: unknown[] }) {
		const command = recorder.commands.get(HANDOFF_COMMAND_NAME);
		assert.ok(command);
		const context = createCommandContext({
			mode: "tui",
			branch: COMPLETED_REVIEW_BRANCH,
			customResults: options.customResults,
		});
		await fireHook(recorder, "session_start", { type: "session_start", reason: "resume" }, context.ctx);
		await command.handler("", context.ctx);
		assert.deepEqual(context.uiCalls, ["custom"], "Review here's own gate");
		return context;
	}

	/** Both hooks fire on every turn of every session; inertness is their main requirement. */
	it("opens no UI when the machine is idle", async () => {
		const { ctx, uiCalls, notifications } = createCommandContext({ mode: "tui" });
		await fireHook(recorder, "agent_end", { type: "agent_end", messages: [] }, ctx);
		await fireHook(recorder, "agent_settled", { type: "agent_settled" }, ctx);
		await flush();

		assert.deepEqual(uiCalls, []);
		assert.deepEqual(notifications, []);
	});

	it("changes no state when the machine is idle", async () => {
		const command = recorder.commands.get(HANDOFF_COMMAND_NAME);
		assert.ok(command);
		const { ctx, notifications } = createCommandContext({ mode: "tui" });
		await fireHook(recorder, "agent_end", { type: "agent_end", messages: [] }, ctx);
		await fireHook(recorder, "agent_settled", { type: "agent_settled" }, ctx);
		await flush();
		await command.handler("status", ctx);

		assert.deepEqual(notifications, [{ message: "Handoff: idle", level: "info" }]);
	});

	it("appends no session entry when the machine is idle", async () => {
		const { ctx } = createCommandContext({ mode: "tui" });
		await fireHook(recorder, "agent_end", { type: "agent_end", messages: [] }, ctx);
		await fireHook(recorder, "agent_settled", { type: "agent_settled" }, ctx);
		await flush();

		assert.deepEqual(recorder.entries, []);
	});

	/**
	 * The end-to-end shape of the split. `agent_end` may not open anything: Pi awaits
	 * extension `agent_end` handlers before the listener that clears its `Working`
	 * spinner runs, so a gate opened there would sit under a spinner that cannot clear.
	 */
	it("captures in agent_end and reopens Gate B from agent_settled, exactly once", async () => {
		const { ctx, uiCalls } = await armReviewTurn({ customResults: ["review", "dismiss"] });

		await fireHook(recorder, "agent_end", { type: "agent_end", messages: [] }, ctx);
		await flush();
		assert.deepEqual(uiCalls, ["custom"], "agent_end opens nothing");

		await fireHook(recorder, "agent_settled", { type: "agent_settled" }, ctx);
		await flush();
		assert.deepEqual(uiCalls, ["custom", "custom"], "the settle reopens one gate");

		// A repeated settle for the same turn must not stack another.
		await fireHook(recorder, "agent_settled", { type: "agent_settled" }, ctx);
		await flush();
		assert.deepEqual(uiCalls, ["custom", "custom"]);
	});

	/**
	 * The property the split exists for, pinned at the entry point. Every other settle test
	 * resolves its gate at once, so an `index.ts` handler that awaited the reopen would
	 * pass them all; this one keeps the reopened gate open and requires the hook itself
	 * to have settled first, racing it against a flush so a regression fails, not hangs.
	 */
	it("settles the agent_settled hook while the reopened gate is still open", async () => {
		let release: ((value: unknown) => void) | undefined;
		const held = new Promise((resolve) => {
			release = resolve;
		});
		const { ctx, uiCalls } = await armReviewTurn({ customResults: ["review", held] });
		await fireHook(recorder, "agent_end", { type: "agent_end", messages: [] }, ctx);

		try {
			const hook = fireHook(recorder, "agent_settled", { type: "agent_settled" }, ctx).then(() => "hook");
			const first = await Promise.race([hook, flush().then(() => "flush")]);

			assert.equal(first, "hook", "the hook must not wait on the gate it opened");
			await flush();
			assert.deepEqual(uiCalls, ["custom", "custom"], "the reopened gate is still on screen");
		} finally {
			release?.("dismiss");
			await flush();
		}
	});

	/** An auto-retried prompt ends more than once, and the review is the last attempt's. */
	it("reopens once with the last capture when a retried prompt ends twice", async () => {
		const { ctx, uiCalls } = await armReviewTurn({ customResults: ["review", "dismiss"] });

		await fireHook(recorder, "agent_end", { type: "agent_end", messages: [assistantMessage("Partial.")] }, ctx);
		await fireHook(
			recorder,
			"agent_end",
			{ type: "agent_end", messages: [assistantMessage("The retry got there.")] },
			ctx,
		);
		await fireHook(recorder, "agent_settled", { type: "agent_settled" }, ctx);
		await flush();

		assert.deepEqual(uiCalls, ["custom", "custom"]);
		const recorded = recorder.entries.at(-1)?.data as { review?: { text?: string } };
		assert.equal(recorded.review?.text, "The retry got there.");
	});

	/**
	 * A capture cannot outlive the session it was taken in, or it reopens a stale gate.
	 *
	 * The replacement session arms a review turn of its own, so the arm check passes and
	 * the dropped capture is the only thing standing between it and a gate showing the
	 * previous session's review. A replacement that merely reset to idle would be
	 * stopped by the arm check alone and prove nothing about `session_start`.
	 */
	it("reopens nothing from a capture taken before the session was replaced", async () => {
		const previous = await armReviewTurn({ customResults: ["review", "dismiss"] });
		await fireHook(
			recorder,
			"agent_end",
			{ type: "agent_end", messages: [assistantMessage("The previous session's review.")] },
			previous.ctx,
		);

		const replacement = await armReviewTurn({ customResults: ["review", "dismiss"] });
		const entriesBefore = recorder.entries.length;
		await fireHook(recorder, "agent_settled", { type: "agent_settled" }, replacement.ctx);
		await flush();

		assert.deepEqual(previous.uiCalls, ["custom"]);
		assert.deepEqual(replacement.uiCalls, ["custom"], "only the replacement's own Review here gate");
		assert.equal(recorder.entries.length, entriesBefore, "no stale review was persisted");
	});

	it("reopens nothing when the session shuts down between the two events", async () => {
		const { ctx, uiCalls } = await armReviewTurn({ customResults: ["review", "dismiss"] });
		await fireHook(recorder, "agent_end", { type: "agent_end", messages: [] }, ctx);

		await fireHook(recorder, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
		await fireHook(recorder, "agent_settled", { type: "agent_settled" }, ctx);
		await flush();

		assert.deepEqual(uiCalls, ["custom"]);
	});

	/**
	 * A dismissed gate leaves the review pending with the flag down. Ordinary turns
	 * after that must not reopen it, which is what makes the follow-up question in
	 * §5.5 possible.
	 */
	it("opens no UI while reviewing with the review arm clear", async () => {
		const { ctx, uiCalls, notifications } = createCommandContext({ mode: "tui", branch: COMPLETED_REVIEW_BRANCH });
		await fireHook(recorder, "session_start", { type: "session_start", reason: "resume" }, ctx);
		await fireHook(recorder, "agent_end", { type: "agent_end", messages: [] }, ctx);
		await fireHook(recorder, "agent_settled", { type: "agent_settled" }, ctx);
		await flush();

		assert.deepEqual(uiCalls, []);
		assert.deepEqual(notifications, []);
	});

	/** Rehydration forces the flag down, so a restart cannot resurrect an armed turn. */
	it("opens no UI for a restored review whose entry claimed an armed turn", async () => {
		const branch = [
			{
				type: "custom",
				customType: "handoff-state",
				data: {
					kind: "reviewing",
					completion: "completed",
					draft: { slug: "add-retries", prompt: "Do it.", tier: "standard", rationale: "Because." },
					choice: { provider: "bifrost", model: "claude-sonnet-5", thinking: "high" },
					iteration: 1,
					checkpoint: { repositoryRoot: "/repo", head: "abc1234", statuses: [] },
					report: "Did it.",
					diffstat: " 1 file changed",
					usage: {
						inputTokens: 1,
						outputTokens: 1,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						cost: 0,
						contextTokens: 1,
						turns: 1,
					},
					awaitingReviewTurn: true,
				},
			},
		];
		const { ctx, uiCalls } = createCommandContext({ mode: "tui", branch });
		await fireHook(recorder, "session_start", { type: "session_start", reason: "resume" }, ctx);
		await fireHook(recorder, "agent_end", { type: "agent_end", messages: [] }, ctx);

		assert.deepEqual(uiCalls, []);
	});

	it("injects no message of its own", async () => {
		const { ctx } = createCommandContext({ mode: "tui" });
		await fireHook(recorder, "agent_end", { type: "agent_end", messages: [] }, ctx);

		assert.deepEqual(recorder.messages, []);
	});
});

/**
 * The external-run state, driven through the real entry point.
 *
 * This is the path that had no state at all: "Run externally" returned to idle, so
 * the extension forgot the handoff and the user's worker edited a tree with no
 * checkpoint, no diffstat, and no Discard. These assert the recorded state is
 * visible to `/handoff status`, that `/handoff` offers the review-now gate for it,
 * and that shutdown does not try to kill a process that was never a child here.
 */
describe("external run recovery", () => {
	let recorder: Recorder;

	const EXTERNAL_BRANCH = [
		{
			type: "custom",
			customType: "handoff-state",
			data: {
				kind: "running",
				draft: { slug: "add-retries", prompt: "Do it.", tier: "standard", rationale: "Because." },
				choice: { provider: "bifrost", model: "claude-sonnet-5", thinking: "high" },
				iteration: 1,
				startedAt: "2026-03-09T09:00:00.000Z",
				checkpoint: { repositoryRoot: "/repo", head: "abc1234", statuses: [] },
				external: true,
			},
		},
	];

	beforeEach(() => {
		recorder = createRecorder();
		handoff(recorder.api);
	});

	/**
	 * The one state that survives a restart as itself. Its worker is in another
	 * terminal that this session's death did not touch, so downgrading it to an
	 * interrupted review would discard a run that may still be in flight.
	 */
	it("keeps an external run in progress across a restart", async () => {
		const command = recorder.commands.get(HANDOFF_COMMAND_NAME);
		assert.ok(command);
		const { ctx, notifications } = createCommandContext({ branch: EXTERNAL_BRANCH });
		await fireHook(recorder, "session_start", { type: "session_start", reason: "resume" }, ctx);
		await command.handler("status", ctx);

		assert.match(notifications[0]?.message ?? "", /running in another terminal/);
	});

	it("tells the user how to bring the result back", async () => {
		const command = recorder.commands.get(HANDOFF_COMMAND_NAME);
		assert.ok(command);
		const { ctx, notifications } = createCommandContext({ branch: EXTERNAL_BRANCH });
		await fireHook(recorder, "session_start", { type: "session_start", reason: "resume" }, ctx);
		await command.handler("status", ctx);

		assert.match(notifications[0]?.message ?? "", /when it finishes to review it here/);
	});

	it("offers the review-now gate when /handoff is run while it is in flight", async () => {
		const command = recorder.commands.get(HANDOFF_COMMAND_NAME);
		assert.ok(command);
		const { ctx, uiCalls } = createCommandContext({ mode: "tui", branch: EXTERNAL_BRANCH });
		await fireHook(recorder, "session_start", { type: "session_start", reason: "resume" }, ctx);
		await command.handler("", ctx);

		// A select, not a drafting call: the gate asks what to do with the run in flight.
		assert.deepEqual(uiCalls, ["select"]);
	});

	it("leaves the run in place when the gate is dismissed", async () => {
		const command = recorder.commands.get(HANDOFF_COMMAND_NAME);
		assert.ok(command);
		const { ctx, notifications } = createCommandContext({ mode: "tui", branch: EXTERNAL_BRANCH });
		await fireHook(recorder, "session_start", { type: "session_start", reason: "resume" }, ctx);
		await command.handler("", ctx);
		await command.handler("status", ctx);

		assert.match(notifications.at(-1)?.message ?? "", /running in another terminal/);
	});

	it("warns that a supplied scope was ignored rather than drafting over the run", async () => {
		const command = recorder.commands.get(HANDOFF_COMMAND_NAME);
		assert.ok(command);
		const { ctx, notifications } = createCommandContext({ mode: "tui", branch: EXTERNAL_BRANCH });
		await fireHook(recorder, "session_start", { type: "session_start", reason: "resume" }, ctx);
		await command.handler("something else entirely", ctx);

		assert.match(notifications[0]?.message ?? "", /already running in another terminal/);
		assert.equal(notifications[0]?.level, "warning");
	});

	/** No child process was ever this session's, so there is nothing to kill. */
	it("does not try to kill a worker for an external run on shutdown", async () => {
		const { ctx, uiCalls, notifications } = createCommandContext({ branch: EXTERNAL_BRANCH });
		await fireHook(recorder, "session_start", { type: "session_start", reason: "resume" }, ctx);
		await fireHook(recorder, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		assert.deepEqual(uiCalls, []);
		assert.deepEqual(notifications, []);
		assert.deepEqual(recorder.entries, []);
	});

	it("opens no UI from a review turn while an external run is in flight", async () => {
		const { ctx, uiCalls } = createCommandContext({ mode: "tui", branch: EXTERNAL_BRANCH });
		await fireHook(recorder, "session_start", { type: "session_start", reason: "resume" }, ctx);
		await fireHook(recorder, "agent_end", { type: "agent_end", messages: [] }, ctx);
		await fireHook(recorder, "agent_settled", { type: "agent_settled" }, ctx);
		await flush();

		assert.deepEqual(uiCalls, []);
	});
});
