/**
 * Tests for the pure parts of the handoff command surface.
 *
 * Argument parsing, status rendering, Gate A's summary, and menu resolution are
 * all pure, so the decisions they encode are asserted here rather than through an
 * overlay. Gate A's blocked-Run presentation is included because "Run is visibly
 * blocked" is a design requirement, not a cosmetic detail.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HandoffState } from "../../src/app/handoff-machine.ts";
import { parseHandoffCommand } from "../../src/commands/parse.ts";
import { formatHandoffStatus } from "../../src/commands/status.ts";
import type { Checkpoint, Draft, ModelChoice } from "../../src/domain/types.ts";
import { formatGateASummary } from "../../src/presentation/gate-a.ts";
import { gateAMenu, selectOption, unparseableMenu } from "../../src/presentation/menus.ts";

const DRAFT: Draft = {
	slug: "add-retry-logic",
	prompt: "Line 1\nLine 2",
	tier: "standard",
	rationale: "Two files, fully specified.",
};

const CHOICE: ModelChoice = { provider: "bifrost-openai", model: "gpt-5.6-terra", thinking: "high" };

const CHECKPOINT: Checkpoint = { repositoryRoot: "/repo", head: "abc1234", statuses: [] };

describe("parseHandoffCommand", () => {
	it("recognizes status", () => {
		assert.deepEqual(parseHandoffCommand("status"), { kind: "status" });
	});

	it("ignores surrounding whitespace", () => {
		assert.deepEqual(parseHandoffCommand("  status  "), { kind: "status" });
	});

	it("recognizes subcommands owned by later tasks", () => {
		assert.deepEqual(parseHandoffCommand("abort"), { kind: "unimplemented", name: "abort" });
		assert.deepEqual(parseHandoffCommand("config"), { kind: "unimplemented", name: "config" });
	});

	it("treats empty arguments as an unscoped draft", () => {
		assert.deepEqual(parseHandoffCommand(""), { kind: "draft", scope: "" });
	});

	it("treats free text as handoff scope rather than a bad subcommand", () => {
		assert.deepEqual(parseHandoffCommand("also update the docs"), { kind: "draft", scope: "also update the docs" });
	});

	it("does not mistake scope beginning with a subcommand word for that subcommand", () => {
		assert.deepEqual(parseHandoffCommand("config the retry policy"), {
			kind: "draft",
			scope: "config the retry policy",
		});
	});
});

describe("formatHandoffStatus", () => {
	it("reports idle", () => {
		assert.equal(formatHandoffStatus({ kind: "idle" }), "Handoff: idle");
	});

	it("reports drafting with scope", () => {
		assert.equal(formatHandoffStatus({ kind: "drafting", scope: "add retries" }), "Handoff: drafting (add retries)");
	});

	it("reports drafting without scope", () => {
		assert.equal(formatHandoffStatus({ kind: "drafting", scope: "" }), "Handoff: drafting");
	});

	it("reports a proposal with its model and prompt path", () => {
		const state: HandoffState = { kind: "proposed", draft: DRAFT, choice: CHOICE };
		assert.equal(
			formatHandoffStatus(state),
			"Handoff: proposed add-retry-logic on bifrost-openai/gpt-5.6-terra:high (/tmp/pi-handoff-add-retry-logic.md)",
		);
	});

	it("reports a running worker with its iteration", () => {
		const state: HandoffState = {
			kind: "running",
			draft: DRAFT,
			choice: CHOICE,
			iteration: 2,
			startedAt: "2026-01-01T00:00:00.000Z",
			checkpoint: CHECKPOINT,
		};
		assert.equal(
			formatHandoffStatus(state),
			"Handoff: running add-retry-logic on bifrost-openai/gpt-5.6-terra:high, iteration 2",
		);
	});

	it("reports an interrupted review with its note", () => {
		const state: HandoffState = {
			kind: "reviewing",
			completion: "interrupted",
			draft: DRAFT,
			choice: CHOICE,
			iteration: 1,
			checkpoint: CHECKPOINT,
			report: null,
			diffstat: null,
			usage: null,
			interruptionNote: "The worker was interrupted.",
			awaitingReviewTurn: false,
		};
		assert.equal(
			formatHandoffStatus(state),
			"Handoff: review interrupted for add-retry-logic — The worker was interrupted.",
		);
	});
});

describe("formatGateASummary", () => {
	const view = { draft: DRAFT, choice: CHOICE, promptPath: "/tmp/pi-handoff-add-retry-logic.md", runnable: true };

	it("shows the resolved model and the exact launch command", () => {
		const lines = formatGateASummary(view);
		assert.ok(lines.includes("Model:     bifrost-openai/gpt-5.6-terra:high"));
		assert.ok(
			lines.includes('Command:   pi --model "bifrost-openai/gpt-5.6-terra:high" @/tmp/pi-handoff-add-retry-logic.md'),
		);
	});

	it("shows the tier, rationale, and prompt path", () => {
		const lines = formatGateASummary(view);
		assert.ok(lines.includes("Tier:      standard"));
		assert.ok(lines.includes("Rationale: Two files, fully specified."));
		assert.ok(lines.includes("Prompt:    /tmp/pi-handoff-add-retry-logic.md"));
	});

	it("includes the prompt body as a preview", () => {
		const lines = formatGateASummary(view);
		assert.ok(lines.includes("Line 1"));
		assert.ok(lines.includes("Line 2"));
	});

	it("truncates a long prompt and says how much is hidden", () => {
		const long: Draft = { ...DRAFT, prompt: Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n") };
		const lines = formatGateASummary({ ...view, draft: long });
		assert.ok(lines.includes("… 8 more lines"));
		assert.equal(lines.includes("L19"), false);
	});

	it("explains the missing model instead of leaving the field blank", () => {
		const lines = formatGateASummary({ ...view, choice: undefined, runnable: false });
		assert.ok(lines.includes('Model:     none available for tier "standard" — choose one to enable Run'));
	});

	it("offers no launch command when no model is chosen", () => {
		const lines = formatGateASummary({ ...view, choice: undefined, runnable: false });
		assert.ok(lines.includes("Command:   available once a model is chosen"));
		assert.equal(
			lines.some((line) => line.includes("pi --model")),
			false,
		);
	});
});

describe("gateAMenu", () => {
	it("offers exactly the five designed options in order", () => {
		assert.deepEqual(
			gateAMenu(true).map((option) => option.id),
			["run", "edit", "model", "external", "cancel"],
		);
	});

	it("labels Run plainly when a model is available", () => {
		assert.equal(gateAMenu(true)[0]?.label, "Run");
	});

	it("marks Run as blocked when no model is available", () => {
		assert.equal(gateAMenu(false)[0]?.label, "Run (blocked: choose an available model first)");
	});
});

describe("selectOption", () => {
	it("resolves a chosen label back to its stable id", async () => {
		const chosen = await selectOption(async (_title, options) => options[3], "Gate A", gateAMenu(true));
		assert.equal(chosen, "external");
	});

	it("returns undefined when the user cancels", async () => {
		const chosen = await selectOption(async () => undefined, "Gate A", gateAMenu(true));
		assert.equal(chosen, undefined);
	});

	it("returns undefined for an unrecognized label", async () => {
		const chosen = await selectOption(async () => "Not a real option", "Gate A", unparseableMenu());
		assert.equal(chosen, undefined);
	});

	it("resolves the retry option", async () => {
		const chosen = await selectOption(async (_title, options) => options[0], "Retry?", unparseableMenu());
		assert.equal(chosen, "retry");
	});
});
