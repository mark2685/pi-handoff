/**
 * Contract tests for the extension entry point.
 *
 * These load the real `index.ts` and drive it through a stub `ExtensionAPI`,
 * pinning the registration surface. T7 adds the drafting path, so the surface is
 * still one command with no tools and no lifecycle hooks: `session_start`
 * rehydration and `session_shutdown` cleanup belong to a later task, and
 * registering a hook early would fire handoff logic in sessions that have none.
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
}

/** Builds a stub ExtensionAPI that records everything the extension registers. */
function createRecorder(): Recorder {
	const commands = new Map<string, RegisteredCommand>();
	const tools: unknown[] = [];
	const hooks = new Map<string, unknown[]>();
	const entries: { customType: string; data?: unknown }[] = [];

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
	} as unknown as ExtensionAPI;

	return { api, commands, tools, hooks, entries };
}

interface Notification {
	message: string;
	level?: string;
}

/** Builds a context whose mode and model are configurable, recording notifications. */
function createCommandContext(options: { mode?: string; hasModel?: boolean } = {}) {
	const notifications: Notification[] = [];
	const ctx = {
		mode: options.mode ?? "print",
		hasUI: false,
		cwd: "/repo",
		model: options.hasModel === true ? { provider: "bifrost", id: "claude-sonnet-5" } : undefined,
		modelRegistry: {
			getAvailable: () => [{ provider: "bifrost", id: "claude-sonnet-5" }],
		},
		sessionManager: {
			getBranch: () => [],
		},
		ui: {
			notify: (message: string, level?: string) => {
				notifications.push({ message, ...(level === undefined ? {} : { level }) });
			},
			setEditorText: () => {},
		},
	};
	return { ctx, notifications };
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

	it("registers no lifecycle hooks, which a later task adds for rehydration", () => {
		assert.equal(recorder.hooks.size, 0);
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
