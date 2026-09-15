/**
 * Model selection for Gate A's Change model option.
 *
 * Adapted from Phase Runner's picker: labels are only ever labels, and the
 * selection is resolved by index in the list that produced it rather than by
 * parsing a display string back into provider and model. That matters more here
 * than there, because a mis-parsed label would become the `--model` argument of
 * a spawned worker.
 *
 * Only models from `getAvailable()` are offered, which is what guarantees a
 * user-chosen model passes the same registry check as a tier-resolved one.
 */

import type { Api } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelChoice, ThinkingLevel } from "../domain/types.ts";

/** Thinking levels offered, most commonly useful first. */
const THINKING_LEVELS: readonly ThinkingLevel[] = ["high", "medium", "low", "minimal", "off", "xhigh", "max"];

/** Level used when the user dismisses the thinking-level prompt after picking a model. */
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";

/** Renders a model as `provider/id — Name`. */
export function formatAvailableModel(model: Model<Api>): string {
	const name = model.name && model.name !== model.id ? ` — ${model.name}` : "";
	return `${model.provider}/${model.id}${name}`;
}

/**
 * Prompts for a model and a thinking level.
 *
 * Returns undefined when no models are available or the user cancels the model
 * step; cancelling only the thinking step keeps the model with a default level.
 */
export async function pickModel(ctx: ExtensionContext, title: string): Promise<ModelChoice | undefined> {
	const models = ctx.modelRegistry.getAvailable();
	if (models.length === 0) {
		ctx.ui.notify("No authenticated models are available", "warning");
		return undefined;
	}

	const labels = models.map(formatAvailableModel);
	const chosenLabel = await ctx.ui.select(title, labels);
	if (!chosenLabel) return undefined;

	// Resolve by label position rather than re-parsing the display string.
	const selected = models[labels.indexOf(chosenLabel)];
	if (!selected) return undefined;

	const thinking = await ctx.ui.select("Thinking level", [...THINKING_LEVELS]);
	return {
		provider: selected.provider,
		model: selected.id,
		thinking: (thinking as ThinkingLevel | undefined) ?? DEFAULT_THINKING_LEVEL,
	};
}
