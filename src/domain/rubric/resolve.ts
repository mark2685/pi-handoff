/**
 * Deterministic resolution of a drafting tier against a model-registry snapshot.
 *
 * Resolution deliberately receives plain registry data instead of querying Pi:
 * the drafting model cannot invent a concrete model, and callers can repeat the
 * same availability check immediately before spawning a child process.
 */

import type { AvailableModel, ModelChoice, Rubric, Tier } from "../types.ts";

/** A parsed canonical `provider/model-id` reference. */
export interface ModelReference {
	provider: string;
	model: string;
}

/** The normal outcome when no eligible candidate exists in the registry snapshot. */
export interface NoModelAvailable {
	kind: "none_available";
}

/** A successful tier resolution, including the registry-backed choice. */
export interface ResolvedTier {
	kind: "resolved";
	choice: ModelChoice;
}

export type TierResolution = ResolvedTier | NoModelAvailable;

/**
 * Splits a canonical model identifier on its first slash only.
 *
 * Pi model ids may contain further slashes, so splitting all separators would
 * lose part of a valid id. Invalid identifiers return `undefined` for callers
 * that need to treat malformed configuration as unavailable.
 */
export function parseModelReference(identifier: string): ModelReference | undefined {
	const separator = identifier.indexOf("/");
	if (separator <= 0 || separator === identifier.length - 1) return undefined;
	return {
		provider: identifier.slice(0, separator),
		model: identifier.slice(separator + 1),
	};
}

/** Returns whether a canonical model identifier exists in a registry snapshot. */
export function isModelAvailable(identifier: string, availableModels: readonly AvailableModel[]): boolean {
	const reference = parseModelReference(identifier);
	return (
		reference !== undefined &&
		availableModels.some((available) => available.provider === reference.provider && available.id === reference.model)
	);
}

/**
 * Resolves the first non-excluded, currently available candidate for a tier.
 *
 * A missing candidate is expected while providers are disabled or catalogs
 * change, so it is represented as a value for Gate A rather than an error.
 */
export function resolveTier(rubric: Rubric, tier: Tier, availableModels: readonly AvailableModel[]): TierResolution {
	for (const candidate of rubric.tiers[tier]) {
		if (rubric.excludeModels.includes(candidate.model) || !isModelAvailable(candidate.model, availableModels)) continue;

		const reference = parseModelReference(candidate.model);
		if (reference === undefined) continue;
		return {
			kind: "resolved",
			choice: {
				provider: reference.provider,
				model: reference.model,
				thinking: candidate.thinking,
			},
		};
	}

	return { kind: "none_available" };
}
