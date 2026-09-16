/**
 * Argument parsing for `/handoff`.
 *
 * Kept pure and separate from dispatch so subcommand recognition is testable
 * without a Pi context. Anything that is not a known subcommand is treated as
 * handoff scope rather than an error, because `/handoff also update the docs` is
 * the primary way the command is used and must not be mistaken for a typo'd
 * subcommand.
 */

/**
 * The slash-command name the extension registers.
 *
 * Temporarily `handoff-v2` rather than `handoff`, so the `~/.pi/agent/prompts/handoff.md`
 * template stays reachable as `/handoff` while the extension is tested side by side.
 * Extension commands shadow prompt templates of the same name, so the two cannot
 * coexist under one name. Every user-facing mention of the command goes through
 * `HANDOFF_COMMAND` so flipping this back is a one-line change.
 */
export const HANDOFF_COMMAND_NAME = "handoff-v2";

/** The command as typed, with its leading slash, for messages shown to the user. */
export const HANDOFF_COMMAND = `/${HANDOFF_COMMAND_NAME}`;

/** A recognized `/handoff` invocation. */
export type HandoffCommand =
	/** Draft a handoff, optionally narrowed by user-supplied scope. */
	| { kind: "draft"; scope: string }
	/** Show the current handoff state. */
	| { kind: "status" }
	/** Subcommands that are recognized but not implemented in this slice. */
	| { kind: "unimplemented"; name: string };

/** Subcommands that exist in the design but are owned by later tasks. */
const UNIMPLEMENTED_SUBCOMMANDS = new Set(["abort", "config"]);

/** Parses raw command arguments into an intent. */
export function parseHandoffCommand(args: string): HandoffCommand {
	const trimmed = args.trim();
	if (trimmed === "status") return { kind: "status" };
	if (UNIMPLEMENTED_SUBCOMMANDS.has(trimmed)) return { kind: "unimplemented", name: trimmed };
	return { kind: "draft", scope: trimmed };
}
