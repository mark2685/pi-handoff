/**
 * Argument parsing for `/handoff`.
 *
 * Kept pure and separate from dispatch so subcommand recognition is testable
 * without a Pi context. Anything that is not a known subcommand is treated as
 * handoff scope rather than an error, because `/handoff also update the docs` is
 * the primary way the command is used and must not be mistaken for a typo'd
 * subcommand.
 */

/** The slash-command name the extension registers. */
export const HANDOFF_COMMAND_NAME = "handoff";

/** The command as typed, with its leading slash, for messages shown to the user. */
export const HANDOFF_COMMAND = `/${HANDOFF_COMMAND_NAME}`;

/** A recognized `/handoff` invocation. */
export type HandoffCommand =
	/** Draft a handoff, optionally narrowed by user-supplied scope. */
	| { kind: "draft"; scope: string; modelOverride?: string }
	/** Report command usage without beginning a drafting call. */
	| { kind: "usage"; message: string }
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

	// Flags are intentionally recognized only at the start. A task whose ordinary
	// prose mentions `--model` remains scope text rather than silently changing the
	// worker that will run it.
	if (trimmed === "--model") return modelUsage();
	if (trimmed.startsWith("--model=")) return parseModelAssignment(trimmed.slice("--model=".length));
	if (trimmed.startsWith("--model ") || trimmed.startsWith("--model\t")) {
		return parseModelAssignment(trimmed.slice("--model".length).trimStart());
	}

	return { kind: "draft", scope: trimmed };
}

function parseModelAssignment(value: string): HandoffCommand {
	const [spec, ...scopeWords] = value.split(/\s+/);
	if (spec === undefined || spec === "") return modelUsage();
	return { kind: "draft", modelOverride: spec, scope: scopeWords.join(" ") };
}

function modelUsage(): HandoffCommand {
	return { kind: "usage", message: "Usage: /handoff --model <provider/model-id[:thinking]> [scope…]" };
}
