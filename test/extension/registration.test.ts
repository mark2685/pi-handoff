/**
 * Contract tests for the scaffold extension entry point.
 *
 * These load the real `index.ts` and drive it through a stub `ExtensionAPI`,
 * ensuring the initial registration surface stays deliberately small.
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
}

/** Builds a stub ExtensionAPI that records everything the extension registers. */
function createRecorder(): Recorder {
	const commands = new Map<string, RegisteredCommand>();
	const tools: unknown[] = [];
	const hooks = new Map<string, unknown[]>();

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
	} as unknown as ExtensionAPI;

	return { api, commands, tools, hooks };
}

function createCommandContext() {
	const notifications: { message: string; level?: string }[] = [];
	const ctx = {
		ui: {
			notify: (message: string, level?: string) => {
				notifications.push({ message, ...(level === undefined ? {} : { level }) });
			},
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

	it("registers no tools or lifecycle hooks", () => {
		assert.equal(recorder.tools.length, 0);
		assert.equal(recorder.hooks.size, 0);
	});

	it("handles /handoff status without throwing", async () => {
		const command = recorder.commands.get("handoff");
		assert.ok(command);
		const { ctx, notifications } = createCommandContext();
		await command.handler("status", ctx);
		assert.deepEqual(notifications, [{ message: "Handoff: idle", level: "info" }]);
	});
});
