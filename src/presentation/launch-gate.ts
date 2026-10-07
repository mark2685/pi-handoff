/**
 * The launch gate: the approval surface for a drafted handoff.
 *
 * Split in two. `launchGateContent` is pure and owns what the gate says — the
 * header that identifies the handoff, and the prompt as a block — so the content,
 * including how a blocked Run and a missing model are presented, is unit-testable.
 * `openLaunchGate` hands that to the gate frame, which decides how much of the
 * prompt fits below the menu; this module makes no height decisions of its own.
 *
 * The prompt is a block rather than header because observed prompts run to 165
 * lines, written as paragraphs that wrap to several rows each. A gate that renders a
 * whole prompt pushes its own options off the screen, so the full text belongs on
 * the viewer View full prompt opens, and the preview's job is only to identify what
 * is about to run.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildLaunchCommand, formatModelChoice } from "../domain/draft/launch.ts";
import type { Draft, ModelChoice } from "../domain/types.ts";
import { LAUNCH_GATE_TITLE } from "../domain/vocabulary.ts";
import { openGate, type GateBlock, type GateSpec } from "./gate-frame.ts";
import { launchGateMenu, type LaunchGateOptionId } from "./menus.ts";

export interface LaunchGateView {
	draft: Draft;
	/** Undefined when the tier resolved to no available model. */
	choice: ModelChoice | undefined;
	promptPath: string;
	/** False when Run must be refused because no registry-backed model is selected. */
	runnable: boolean;
	/** Present only for the transient result gate leftovers path. */
	leftovers?: { acceptedSlug: string };
}

/** Header and prompt-preview block the frame fits. */
export interface LaunchGateContent {
	header: string[];
	blocks: GateBlock<LaunchGateOptionId>[];
}

/**
 * Builds the gate's header and its one block, the prompt preview.
 *
 * The model line states the blocked reason inline rather than omitting the model,
 * because an empty field reads as a rendering bug while an explicit sentence
 * tells the user what to do next. The prompt is a block rather than header because
 * it is the one thing here that is routinely longer than the screen; everything
 * above it is what identifies the handoff and must stay put.
 */
export function launchGateContent(view: LaunchGateView): LaunchGateContent {
	const modelLine =
		view.choice === undefined
			? `Model:     none available for tier "${view.draft.tier}" — choose one to enable Run`
			: `Model:     ${formatModelChoice(view.choice)}${view.choice.overrideSource === "command_line" ? " (from --model)" : ""} — change with "Change model" below`;

	const launchLine =
		view.choice === undefined
			? "Command:   available once a model is chosen"
			: `Command:   ${buildLaunchCommand(view.choice, view.promptPath)}`;

	const goalLines =
		view.draft.bluf === undefined ? ["Goal: (not provided by the drafting model)"] : [`Goal: ${view.draft.bluf}`];
	const definitionOfDoneLines =
		view.draft.definitionOfDone === undefined
			? ["Definition of done: (not provided by the drafting model)"]
			: ["Definition of done:", ...view.draft.definitionOfDone.map((condition) => `  - ${condition}`)];

	return {
		header: [
			`Handoff:   ${view.draft.slug}`,
			...(view.leftovers === undefined ? [] : [`Follow-up: leftovers of \`${view.leftovers.acceptedSlug}\``]),
			`Tier:      ${view.draft.tier}`,
			modelLine,
			`Rationale: ${view.draft.rationale}`,
			`Prompt:    ${view.promptPath}`,
			launchLine,
			"",
			...goalLines,
			...definitionOfDoneLines,
		],
		blocks: [
			{
				id: "prompt",
				label: "prompt preview",
				heading: "Prompt preview:",
				text: view.draft.prompt,
				viewerOption: "view",
			},
		],
	};
}

/** Everything the gate says, untruncated, for callers and tests without a terminal. */
export function formatLaunchGateSummary(view: LaunchGateView): string[] {
	const { header, blocks } = launchGateContent(view);
	return [...header, ...blocks.flatMap((entry) => ["", entry.heading ?? "", ...entry.text.split("\n")])];
}

/** The launch gate as a spec the frame can fit. */
export function launchGateSpec(view: LaunchGateView): GateSpec<LaunchGateOptionId> {
	const { header, blocks } = launchGateContent(view);
	return {
		title: LAUNCH_GATE_TITLE,
		header,
		menu: launchGateMenu(view.runnable, {
			cancelFirst: view.leftovers !== undefined && (view.draft.definitionOfDone?.length ?? 0) === 0,
		}),
		blocks,
		hint: "↑↓ navigate   enter select   esc cancel",
	};
}

/**
 * Renders the launch gate and resolves the selected option.
 *
 * Resolves undefined when the user dismisses the gate, which callers treat the
 * same as Cancel.
 */
export async function openLaunchGate(
	ctx: ExtensionContext,
	view: LaunchGateView,
): Promise<LaunchGateOptionId | undefined> {
	return openGate(ctx, launchGateSpec(view));
}
