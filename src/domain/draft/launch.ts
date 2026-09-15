/**
 * The one place that builds the worker launch command.
 *
 * Run externally puts this string on the clipboard, and a later Gate B and any
 * help text must offer the identical command. Formatting it in a single pure
 * function keeps the `provider/model:thinking` shorthand and the `@file` initial
 * message from drifting between the copied command and the spawned child.
 */

import type { ModelChoice } from "../types.ts";

/** Formats a resolved choice as Pi's `--model` shorthand, including the thinking level. */
export function formatModelChoice(choice: ModelChoice): string {
	return `${choice.provider}/${choice.model}:${choice.thinking}`;
}

/** Formats a resolved choice as a bare `provider/model` reference, without a thinking level. */
export function formatModelReference(choice: ModelChoice): string {
	return `${choice.provider}/${choice.model}`;
}

/**
 * Builds the terminal command that runs an approved handoff prompt.
 *
 * The model shorthand is quoted because it contains a colon, and the prompt path
 * is passed as an `@file` initial message so the worker receives exactly the
 * approved prompt rather than a re-typed summary of it.
 */
export function buildLaunchCommand(choice: ModelChoice, promptPath: string): string {
	return `pi --model "${formatModelChoice(choice)}" @${promptPath}`;
}
