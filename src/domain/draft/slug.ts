/**
 * Filesystem-safe names for temporary handoff prompts.
 *
 * Draft slugs originate in model output, so every path builder normalizes its
 * input instead of trusting a caller to have done so. The result is a simple
 * basename segment and never supplies a path separator or dot-prefixed name.
 */

/** Maximum length of the model-derived part of a handoff prompt filename. */
export const MAX_SLUG_LENGTH = 64;

/** Used when an input contains no characters safe for a prompt filename. */
export const FALLBACK_SLUG = "handoff";

/** Directory where later adapters write prompts before Gate A. */
export const HANDOFF_TEMP_DIR = "/tmp";

/** Stable filename prefix shared by prompt creation and external fallback. */
export const HANDOFF_PROMPT_PREFIX = "pi-handoff-";

/** Stable filename extension for handoff prompts. */
export const HANDOFF_PROMPT_EXTENSION = ".md";

/** Converts arbitrary text into a bounded, lowercase filesystem-safe slug. */
export function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[`'"]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LENGTH)
		.replace(/^-+|-+$/g, "");
	return slug || FALLBACK_SLUG;
}

/** Builds the full temporary prompt path from an untrusted model-provided slug. */
export function buildPromptPath(slug: string): string {
	return `${HANDOFF_TEMP_DIR}/${HANDOFF_PROMPT_PREFIX}${slugify(slug)}${HANDOFF_PROMPT_EXTENSION}`;
}
