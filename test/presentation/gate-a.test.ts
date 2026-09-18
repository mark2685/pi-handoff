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
import {
	GATE_A_COMMON_FIXED_ROWS,
	GATE_A_LARGEST_FIXED_ROWS,
	formatGateASummary,
	promptPreviewLimit,
} from "../../src/presentation/gate-a.ts";
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

	it("parses a leading model override with optional scope", () => {
		assert.deepEqual(parseHandoffCommand("--model bifrost/claude-opus-5:high fix the retry path"), {
			kind: "draft",
			modelOverride: "bifrost/claude-opus-5:high",
			scope: "fix the retry path",
		});
		assert.deepEqual(parseHandoffCommand("--model=bifrost/claude-opus-5"), {
			kind: "draft",
			modelOverride: "bifrost/claude-opus-5",
			scope: "",
		});
	});

	it("warns about a missing model value without drafting", () => {
		assert.deepEqual(parseHandoffCommand("--model"), {
			kind: "usage",
			message: "Usage: /handoff --model <provider/model-id[:thinking]> [scope…]",
		});
	});

	it("leaves a --model mention in ordinary scope prose", () => {
		assert.deepEqual(parseHandoffCommand("document why --model is useful"), {
			kind: "draft",
			scope: "document why --model is useful",
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

	/**
	 * Reported as awaiting the user rather than as work in progress here: nothing in
	 * this session is running, and the next move is theirs.
	 */
	it("reports an external run as waiting on the other terminal", () => {
		const state: HandoffState = {
			kind: "running",
			draft: DRAFT,
			choice: CHOICE,
			iteration: 1,
			startedAt: "2026-01-01T00:00:00.000Z",
			checkpoint: CHECKPOINT,
			external: true,
		};
		const status = formatHandoffStatus(state);
		assert.match(status, /add-retry-logic running in another terminal/);
		assert.match(status, /when it finishes to review it here/);
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

	it("shows the resolved model, its change-model hint, and the exact launch command", () => {
		const lines = formatGateASummary(view);
		assert.ok(lines.includes('Model:     bifrost-openai/gpt-5.6-terra:high — change with "Change model" below'));
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

	it("puts the goal and definition of done above the unchanged preview", () => {
		const draft: Draft = {
			...DRAFT,
			bluf: "Add retries so transient failures recover.",
			definitionOfDone: ["Retries are bounded", "Focused tests pass"],
		};
		const lines = formatGateASummary({ ...view, draft });
		const blufIndex = lines.indexOf("Goal: Add retries so transient failures recover.");
		const previewIndex = lines.indexOf("Prompt preview:");
		assert.deepEqual(lines.slice(blufIndex, previewIndex), [
			"Goal: Add retries so transient failures recover.",
			"Definition of done:",
			"  - Retries are bounded",
			"  - Focused tests pass",
			"",
		]);
		assert.deepEqual(lines.slice(previewIndex + 1), ["Line 1", "Line 2"]);
	});

	it("renders stable fallbacks when an older draft has no metadata", () => {
		const lines = formatGateASummary(view);
		assert.ok(lines.includes("Goal: (not provided by the drafting model)"));
		assert.ok(lines.includes("Definition of done: (not provided by the drafting model)"));
	});

	it("marks a command-line model override", () => {
		const lines = formatGateASummary({ ...view, choice: { ...CHOICE, overrideSource: "command_line" } });
		assert.ok(
			lines.includes('Model:     bifrost-openai/gpt-5.6-terra:high (from --model) — change with "Change model" below'),
		);
	});

	it("truncates a long prompt and points at the option that shows the rest", () => {
		const long: Draft = { ...DRAFT, prompt: Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n") };
		const lines = formatGateASummary({ ...view, draft: long });
		assert.ok(lines.includes('… 8 more lines — choose "View full prompt" to read all of it'));
		assert.equal(lines.includes("L19"), false);
	});

	it("uses the available rows for the prompt preview while retaining its signpost", () => {
		const long: Draft = {
			...DRAFT,
			prompt: Array.from({ length: 100 }, (_, index) => `L${index}`).join("\n"),
			bluf: "Keep the gate action visible.",
			definitionOfDone: ["One", "Two", "Three"],
		};
		const lines = formatGateASummary({ ...view, draft: long }, 30);
		assert.ok(lines.includes('… 98 more lines — choose "View full prompt" to read all of it'));
		assert.ok(lines.length + gateAMenu(true).length + 5 <= 30);
	});

	it("uses the three-row floor at short heights and restores the historical cap when it fits", () => {
		assert.deepEqual(
			[24, 30, 40].map((rows) => promptPreviewLimit(rows, GATE_A_COMMON_FIXED_ROWS)),
			[3, 3, 12],
		);
		assert.deepEqual(
			[24, 30, 40].map((rows) => promptPreviewLimit(rows, GATE_A_LARGEST_FIXED_ROWS)),
			[3, 3, 10],
		);
	});

	it("preserves the historical formatter output when terminal rows are omitted", () => {
		const long: Draft = { ...DRAFT, prompt: Array.from({ length: 20 }, (_, index) => `L${index}`).join("\n") };
		assert.deepEqual(
			formatGateASummary({ ...view, draft: long }),
			formatGateASummary({ ...view, draft: long }, undefined),
		);
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

	it("labels a leftovers-originated draft and keeps its rationale above metadata", () => {
		const draft: Draft = { ...DRAFT, bluf: "Fix the remaining nits.", definitionOfDone: ["Nits are fixed"] };
		const lines = formatGateASummary({ ...view, draft, leftovers: { acceptedSlug: "add-retry-logic" } });
		assert.ok(lines.includes("Follow-up: leftovers of `add-retry-logic`"));
		assert.ok(lines.indexOf("Rationale: Two files, fully specified.") < lines.indexOf("Goal: Fix the remaining nits."));
	});
});

describe("gateAMenu", () => {
	it("offers the designed options in order, with Run and review beside Run", () => {
		assert.deepEqual(
			gateAMenu(true).map((option) => option.id),
			["run", "run_and_review", "view", "edit", "model", "external", "cancel"],
		);
	});

	it("marks Run and review as blocked whenever Run is", () => {
		assert.equal(gateAMenu(false)[1]?.label, "Run and review (blocked: choose an available model first)");
	});

	it("labels Run plainly when a model is available", () => {
		assert.equal(gateAMenu(true)[0]?.label, "Run");
	});

	it("marks Run as blocked when no model is available", () => {
		assert.equal(gateAMenu(false)[0]?.label, "Run (blocked: choose an available model first)");
	});

	it("puts Cancel first for a leftovers draft with no definition of done", () => {
		assert.equal(gateAMenu(true, { cancelFirst: true })[0]?.id, "cancel");
	});
});

describe("selectOption", () => {
	it("resolves a chosen label back to its stable id", async () => {
		const chosen = await selectOption(async (_title, options) => options[5], "Gate A", gateAMenu(true));
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
