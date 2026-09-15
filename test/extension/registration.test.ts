/**
 * Contract tests for the extension entry point.
 *
 * These load the real `index.ts` and drive it through a stub `ExtensionAPI`,
 * pinning the registration surface: one command, no tools, and exactly the three
 * lifecycle hooks the design's §4 names.
 *
 * The `agent_end` assertions are the important ones. That hook fires on every
 * ordinary turn in every session, including sessions with no handoff, so it is
 * tested for inertness rather than for its effect: no UI, no state change, and no
 * session entry unless a Review here turn armed it. `agent_end` can also fire more
 * than once per prompt, since `_runAgentPrompt` loops on auto-retry, which is why
 * the arm flag is cleared before a gate opens rather than after.
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
				return options.customResult;
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
		assert.deepEqual([...recorder.commands.keys()], ["handoff"]);
	});

	it("describes the command for the slash-command list", () => {
		assert.equal(
			recorder.commands.get("handoff")?.description,
			"Draft and run a review-preserving implementation handoff.",
		);
	});

	it("registers no tools", () => {
		assert.equal(recorder.tools.length, 0);
	});

	it("registers exactly the three lifecycle hooks the design names", () => {
		assert.deepEqual([...recorder.hooks.keys()].sort(), ["agent_end", "session_shutdown", "session_start"]);
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
		const command = recorder.commands.get("handoff");
		assert.ok(command);
		const { ctx, notifications } = createCommandContext();
		await command.handler("status", ctx);
		assert.deepEqual(notifications, [{ message: "Handoff: idle", level: "info" }]);
	});

	it("reports status without appending an entry", async () => {
		const command = recorder.commands.get("handoff");
		assert.ok(command);
		const { ctx } = createCommandContext();
		await command.handler("status", ctx);
		assert.deepEqual(recorder.entries, []);
	});

	it("refuses drafting outside interactive mode instead of opening a gate", async () => {
		const command = recorder.commands.get("handoff");
		assert.ok(command);
		const { ctx, notifications } = createCommandContext({ hasModel: true });
		await command.handler("add retries", ctx);
		assert.deepEqual(notifications, [
			{ message: "/handoff requires interactive mode; use /handoff status elsewhere", level: "error" },
		]);
	});

	it("refuses drafting in a TUI session with no model selected", async () => {
		const command = recorder.commands.get("handoff");
		assert.ok(command);
		const { ctx, notifications } = createCommandContext({ mode: "tui", hasModel: false });
		await command.handler("add retries", ctx);
		assert.deepEqual(notifications, [
			{ message: "No model is selected, so a handoff cannot be drafted", level: "error" },
		]);
	});

	it("reports subcommands owned by later tasks as unimplemented", async () => {
		const command = recorder.commands.get("handoff");
		assert.ok(command);
		const { ctx, notifications } = createCommandContext();
		await command.handler("abort", ctx);
		await command.handler("config", ctx);
		assert.deepEqual(notifications, [
			{ message: "/handoff abort is not implemented yet", level: "info" },
			{ message: "/handoff config is not implemented yet", level: "info" },
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
		const command = recorder.commands.get("handoff");
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
		const command = recorder.commands.get("handoff");
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
		const command = recorder.commands.get("handoff");
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
		const command = recorder.commands.get("handoff");
		assert.ok(command);
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
					awaitingReviewTurn: false,
				},
			},
		];
		const { ctx } = createCommandContext({ mode: "tui", branch, customResult: "review" });
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

describe("agent_end reopen", () => {
	let recorder: Recorder;

	beforeEach(() => {
		recorder = createRecorder();
		handoff(recorder.api);
	});

	/** This hook fires on every turn of every session; inertness is its main requirement. */
	it("opens no UI when the machine is idle", async () => {
		const { ctx, uiCalls, notifications } = createCommandContext({ mode: "tui" });
		await fireHook(recorder, "agent_end", { type: "agent_end", messages: [] }, ctx);

		assert.deepEqual(uiCalls, []);
		assert.deepEqual(notifications, []);
	});

	it("changes no state when the machine is idle", async () => {
		const command = recorder.commands.get("handoff");
		assert.ok(command);
		const { ctx, notifications } = createCommandContext({ mode: "tui" });
		await fireHook(recorder, "agent_end", { type: "agent_end", messages: [] }, ctx);
		await command.handler("status", ctx);

		assert.deepEqual(notifications, [{ message: "Handoff: idle", level: "info" }]);
	});

	it("appends no session entry when the machine is idle", async () => {
		const { ctx } = createCommandContext({ mode: "tui" });
		await fireHook(recorder, "agent_end", { type: "agent_end", messages: [] }, ctx);

		assert.deepEqual(recorder.entries, []);
	});

	/**
	 * A dismissed gate leaves the review pending with the flag down. Ordinary turns
	 * after that must not reopen it, which is what makes the follow-up question in
	 * §5.5 possible.
	 */
	it("opens no UI while reviewing with the review arm clear", async () => {
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
					awaitingReviewTurn: false,
				},
			},
		];
		const { ctx, uiCalls, notifications } = createCommandContext({ mode: "tui", branch });
		await fireHook(recorder, "session_start", { type: "session_start", reason: "resume" }, ctx);
		await fireHook(recorder, "agent_end", { type: "agent_end", messages: [] }, ctx);

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
