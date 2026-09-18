/**
 * Human-readable rendering of handoff state for `/handoff status`.
 *
 * Pure so it can be asserted directly, and so status keeps working in
 * non-interactive modes: `npm run smoke` runs `/handoff status` headlessly, and
 * that path must never depend on TUI surfaces.
 */

import { formatModelChoice } from "../domain/draft/launch.ts";
import { buildPromptPath } from "../domain/draft/slug.ts";
import type { HandoffState } from "../app/handoff-machine.ts";
import { HANDOFF_COMMAND } from "./parse.ts";

/** Formats one line describing the active handoff. */
export function formatHandoffStatus(state: HandoffState): string {
	switch (state.kind) {
		case "idle":
			return "Handoff: idle";
		case "drafting":
			return state.scope ? `Handoff: drafting (${state.scope})` : "Handoff: drafting";
		case "proposed":
			return `Handoff: proposed ${state.draft.slug} on ${formatModelChoice(state.choice)} (${buildPromptPath(state.draft.slug)})`;
		case "running":
			// An external run is reported as awaiting the user, not as work in progress here:
			// nothing in this session is running, and the next step is theirs to take.
			return state.external === true
				? `Handoff: ${state.draft.slug} running in another terminal on ${formatModelChoice(state.choice)} — run \`${HANDOFF_COMMAND}\` when it finishes to review it here`
				: `Handoff: running ${state.draft.slug} on ${formatModelChoice(state.choice)}, iteration ${state.iteration}`;
		case "reviewing":
			return state.completion === "completed"
				? `Handoff: awaiting review of ${state.draft.slug}, iteration ${state.iteration}`
				: `Handoff: review interrupted for ${state.draft.slug} — ${state.interruptionNote}`;
	}
}
