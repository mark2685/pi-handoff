/**
 * Core data types for Pi Handoff's model-tier rubric.
 *
 * This module is pure: it must not import `node:*` modules, Pi APIs, or any
 * adapter. Keeping model identifiers as plain data lets resolution be tested
 * against a registry snapshot without requiring a live Pi session.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type Tier = "routine" | "standard" | "hard" | "frontier";

/** A concrete model candidate assigned to one rubric tier, in priority order. */
export interface ModelCandidate {
	/** Canonical `provider/model-id` identifier passed to Pi's `--model` flag. */
	model: string;
	thinking: ThinkingLevel;
}

/** The global, user-editable mapping from drafting tiers to model candidates. */
export interface Rubric {
	tiers: {
		routine: ModelCandidate[];
		standard: ModelCandidate[];
		hard: ModelCandidate[];
		frontier: ModelCandidate[];
	};
	maxIterations: number;
	excludeModels: string[];
}

/** A model reported by Pi's live registry, represented without a Pi dependency. */
export interface AvailableModel {
	provider: string;
	id: string;
}

/** A resolved registry-backed choice ready to become `--model` and `--thinking` arguments. */
export interface ModelChoice {
	provider: string;
	model: string;
	thinking: ThinkingLevel;
}
