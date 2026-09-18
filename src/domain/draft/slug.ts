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

/**
 * Matches a trailing iteration or round counter on a slug.
 *
 * The drafting prompt forbids these outright; this is the belt to that braces.
 * The drafting call is fed a transcript that may already contain earlier review
 * rounds, so a model that keeps counting produces slugs like
 * `tg-feedback-command-iteration-1` for what the extension is about to run as
 * iteration 2. The extension owns the real number, so a model-supplied one is
 * always removed rather than trusted — a wrong number on the prompt filename is
 * worse than none, because the filename is what the reviewer greps for.
 *
 * Only a *trailing* counter is stripped, and only when a name survives it, so
 * `iteration-cache-fix` and a slug that is nothing but `iteration-2` are left
 * alone rather than mangled into a fallback.
 *
 * The words are deliberately restricted to the four that can only mean a counter.
 * `v` and `pass` were tried and removed: they mangle real task names, turning
 * `upgrade-next-v16` into `upgrade-next`, `migrate-api-v2` into `migrate-api`, and
 * `first-pass-3` into `first`. A version number is part of what the work is, and
 * silently deleting it is a worse failure than leaving a stray counter, which the
 * prompt rule already prevents in the normal case.
 */
const TRAILING_ITERATION_SUFFIX = /-(?:iteration|iter|round|attempt)-?\d+$/;

/**
 * Removes a trailing iteration counter a drafting model added to a slug.
 *
 * Applied repeatedly, since a model that appends one counter sometimes appends
 * two (`-round-2-iteration-1`).
 */
export function stripIterationSuffix(slug: string): string {
	let stripped = slug;
	for (;;) {
		const next = stripped.replace(TRAILING_ITERATION_SUFFIX, "");
		// Keeps a slug that is only a counter, rather than emptying it into the fallback.
		if (next === stripped || next === "") return stripped;
		stripped = next;
	}
}

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
	return stripIterationSuffix(slug) || FALLBACK_SLUG;
}

/** Builds the full temporary prompt path from an untrusted model-provided slug. */
export function buildPromptPath(slug: string): string {
	return `${HANDOFF_TEMP_DIR}/${HANDOFF_PROMPT_PREFIX}${slugify(slug)}${HANDOFF_PROMPT_EXTENSION}`;
}
