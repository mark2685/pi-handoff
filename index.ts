/**
 * Pi Handoff: keeps the current session as reviewer while an isolated child Pi
 * session implements an approved handoff.
 *
 * This file is the composition root. It will construct adapters and services,
 * then register the command and lifecycle hooks. All behavior lives in `src/`:
 *
 *   src/domain/       pure handoff rules, no IO or Pi imports
 *   src/ports/        interfaces for everything outside the process
 *   src/adapters/     filesystem, shell, and child-process implementations
 *   src/persistence/  schemas and storage-boundary validation
 *   src/app/          handoff state machine and services
 *   src/presentation/ gates, widgets, and model picker
 *   src/prompts/      drafting and review prompt text
 *   src/commands/     /handoff argument parsing and dispatch
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function handoff(pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Draft and run a review-preserving implementation handoff.",
		handler: async (args, ctx) => {
			if (args.trim() === "status") {
				ctx.ui.notify("Handoff: idle", "info");
				return;
			}

			ctx.ui.notify(`Handoff: subcommand not implemented yet (${args.trim() || "none"})`, "info");
		},
	});
}
