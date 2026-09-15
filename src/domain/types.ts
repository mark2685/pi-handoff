/**
 * Core data types for Pi Handoff's model-tier rubric.
 *
 * This module is pure: it must not import `node:*` modules, Pi APIs, or any
 * adapter. Keeping model identifiers as plain data lets resolution be tested
 * against a registry snapshot without requiring a live Pi session.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type Tier = "routine" | "standard" | "hard" | "frontier";

/** One path reported by Git's machine-readable porcelain status at checkpoint time. */
export interface CheckpointPathStatus {
	/** Index state from the first status column, retained to distinguish staged user work. */
	indexStatus: string;
	/** Working-tree state from the second status column. */
	worktreeStatus: string;
	/** Repository-root-relative destination path, without porcelain quoting or escaping. */
	path: string;
	/** Source path when Git reports a rename or copy; absent for ordinary status records. */
	originalPath?: string;
}

/**
 * Serializable snapshot that limits Discard to changes made after an approved
 * handoff starts. `statuses` records every dirty path, including untracked
 * files, while `head` anchors restoration to the exact pre-worker tree.
 */
export interface Checkpoint {
	repositoryRoot: string;
	head: string;
	statuses: CheckpointPathStatus[];
}

/** A validated drafting-model envelope ready for rubric resolution and Gate A. */
export interface Draft {
	/** Model-provided filename hint; callers normalize it before using a path. */
	slug: string;
	/** Self-contained implementation instructions handed to the isolated worker. */
	prompt: string;
	/** Complexity tier resolved deterministically against the live model registry. */
	tier: Tier;
	/** Human-readable explanation displayed alongside the recommended model. */
	rationale: string;
}

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
