/**
 * Shipped model-tier rubric for first use and config recovery.
 *
 * The drafting model chooses only a tier; this ordered mapping keeps concrete
 * model selection deterministic, reviewable, and independent of model output.
 */

import type { Rubric } from "../types.ts";

export const DEFAULT_RUBRIC: Rubric = {
	tiers: {
		routine: [
			{ model: "bifrost-openai/gpt-5.6-luna", thinking: "medium" },
			{ model: "bifrost/claude-sonnet-5", thinking: "medium" },
		],
		standard: [
			{ model: "bifrost-openai/gpt-5.6-terra", thinking: "high" },
			{ model: "bifrost/claude-sonnet-5", thinking: "high" },
		],
		hard: [
			{ model: "bifrost/claude-opus-5", thinking: "high" },
			{ model: "bifrost-openai/gpt-5.6-terra", thinking: "xhigh" },
		],
		frontier: [{ model: "bifrost/claude-fable-5-1", thinking: "xhigh" }],
	},
	maxIterations: 3,
	excludeModels: ["bifrost/claude-3-haiku", "bifrost/claude-opus-4-8"],
};
