/**
 * Tests for the single launch-command builder.
 *
 * The exact command string is a contract: the user pastes it into a terminal,
 * and a later Gate B must offer the identical command. These assert the whole
 * string rather than its parts so a quoting or flag change cannot pass quietly.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLaunchCommand, formatModelChoice, formatModelReference } from "../../src/domain/draft/launch.ts";
import { buildPromptPath } from "../../src/domain/draft/slug.ts";
import type { ModelChoice } from "../../src/domain/types.ts";

const CHOICE: ModelChoice = { provider: "bifrost-openai", model: "gpt-5.6-terra", thinking: "high" };

describe("formatModelChoice", () => {
	it("joins provider, model, and thinking level with Pi's shorthand", () => {
		assert.equal(formatModelChoice(CHOICE), "bifrost-openai/gpt-5.6-terra:high");
	});

	it("keeps a model id that contains slashes intact", () => {
		const nested: ModelChoice = { provider: "openrouter", model: "anthropic/claude-sonnet-5", thinking: "medium" };
		assert.equal(formatModelChoice(nested), "openrouter/anthropic/claude-sonnet-5:medium");
	});
});

describe("formatModelReference", () => {
	it("omits the thinking level", () => {
		assert.equal(formatModelReference(CHOICE), "bifrost-openai/gpt-5.6-terra");
	});
});

describe("buildLaunchCommand", () => {
	it("builds the documented command exactly", () => {
		const command = buildLaunchCommand(CHOICE, "/tmp/pi-handoff-add-retry-logic.md");
		assert.equal(command, 'pi --model "bifrost-openai/gpt-5.6-terra:high" @/tmp/pi-handoff-add-retry-logic.md');
	});

	it("matches the path that buildPromptPath produces for the same slug", () => {
		const command = buildLaunchCommand(CHOICE, buildPromptPath("Add Retry Logic"));
		assert.equal(command, 'pi --model "bifrost-openai/gpt-5.6-terra:high" @/tmp/pi-handoff-add-retry-logic.md');
	});

	it("quotes the model so the colon cannot be parsed by a shell", () => {
		const command = buildLaunchCommand(CHOICE, "/tmp/pi-handoff-x.md");
		assert.match(command, /--model "[^"]+:high"/);
	});
});
