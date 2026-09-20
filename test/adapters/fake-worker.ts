/**
 * Hermetic stand-in for Pi's NDJSON worker mode.
 *
 * Adapter and end-to-end tests share this script so they exercise the real child-process
 * runner without invoking Pi, credentials, a model, or the network.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

const FIRST_USAGE = {
	input: 10,
	output: 20,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 37,
	cost: { total: 0.01 },
};

const SECOND_USAGE = {
	input: 7,
	output: 8,
	cacheRead: 9,
	cacheWrite: 10,
	totalTokens: 34,
	cost: { total: 0.02 },
};

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { total: 0 },
};

export const FAKE_WORKER_SOURCE = `
import { writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const promptArg = args.find((argument) => argument.startsWith("@"));
const scenario = promptArg ? path.basename(promptArg.slice(1), ".md") : "unknown";

function send(event) {
	process.stdout.write(JSON.stringify(event) + "\\n");
}

function assistant(text, usage, stopReason = "stop", errorMessage) {
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		usage,
		stopReason,
	};
	if (errorMessage !== undefined) message.errorMessage = errorMessage;
	return { type: "message_end", message };
}

const firstUsage = ${JSON.stringify(FIRST_USAGE)};
const secondUsage = ${JSON.stringify(SECOND_USAGE)};
const zeroUsage = ${JSON.stringify(ZERO_USAGE)};

if (scenario.includes("capture-args")) {
	send(assistant(JSON.stringify(args), zeroUsage));
} else if (scenario === "normal") {
	send(assistant("Inspecting the implementation.", firstUsage, "toolUse"));
	send({
		type: "tool_result_end",
		message: {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "read",
			content: [{ type: "text", text: "source contents" }],
			isError: false,
		},
	});
	send(assistant("Implementation complete.", secondUsage));
} else if (scenario === "mutates-scratch") {
	writeFileSync(path.join(process.cwd(), "worker-edit.txt"), "worker edit\\n", "utf8");
	writeFileSync(path.join(process.cwd(), "worker-created.txt"), "worker created\\n", "utf8");
	send(assistant("Scratch-repository mutation complete.", zeroUsage));
} else if (scenario === "split") {
	const line = JSON.stringify(assistant("Split event report.", firstUsage)) + "\\n";
	const splitAt = Math.floor(line.length / 2);
	process.stdout.write(line.slice(0, splitAt));
	setTimeout(() => process.stdout.write(line.slice(splitAt)), 25);
} else if (scenario === "activity") {
	send({ type: "agent_start" });
	send({ type: "turn_start" });
	send({ type: "message_start", message: { role: "assistant", content: [] } });
	send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Reasoning" } });
	send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Working" } });
	send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", id: "tool-activity", toolName: "bash" } });
	send({ type: "tool_execution_start", toolCallId: "tool-activity", toolName: "bash", args: {} });
	send({ type: "tool_execution_update", toolCallId: "tool-activity", toolName: "bash", args: {}, partialResult: {} });
	send({ type: "tool_execution_end", toolCallId: "tool-activity", toolName: "bash", result: {}, isError: false });
	send({
		type: "message_end",
		message: {
			role: "toolResult",
			toolCallId: "tool-activity",
			toolName: "bash",
			content: [{ type: "text", text: "done" }],
			isError: false,
		},
	});
	send(assistant("Activity report.", firstUsage));
	send({ type: "agent_end", messages: [] });
} else if (scenario === "stalled") {
	writeFileSync(path.join(process.cwd(), "stalled.pid"), String(process.pid), "utf8");
	setTimeout(() => send(assistant("Worker eventually finished.", zeroUsage)), 500);
} else if (scenario === "watchdog-reset") {
	setTimeout(() => send({ type: "agent_start" }), 100);
	setTimeout(() => send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Still working" } }), 400);
	setTimeout(() => send(assistant("Frequent events prevented a stall.", zeroUsage)), 700);
} else if (scenario === "failing") {
	process.stderr.write("worker exploded\\n");
	send(assistant("Partial report before failure.", firstUsage, "error", "provider failed"));
	process.exitCode = 17;
} else if (scenario === "malformed") {
	process.stdout.write("not JSON\\n{not valid JSON}\\n");
	send(assistant("Report after malformed progress.", firstUsage));
} else if (scenario === "stubborn") {
	process.on("SIGTERM", () => {});
	send(assistant(String(process.pid), zeroUsage, "toolUse"));
	setInterval(() => {}, 1_000);
} else {
	process.stderr.write("unknown fake-worker scenario\\n");
	process.exitCode = 2;
}
`;

/** Writes the fake Pi executable into a temporary test-only directory. */
export async function writeFakeWorker(directory: string): Promise<string> {
	const fakeWorkerPath = path.join(directory, "fake-worker.mjs");
	await writeFile(fakeWorkerPath, FAKE_WORKER_SOURCE, "utf8");
	return fakeWorkerPath;
}
