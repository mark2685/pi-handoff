/**
 * Gate A: the approval surface for a drafted handoff.
 *
 * Split deliberately in two. `formatGateASummary` is pure and returns the lines
 * shown above the option list, so the content of the gate — including how a
 * blocked Run and a missing model are presented — is unit-testable. The
 * `openGateA` shell only renders those lines with a `ctx.ui.custom` component and
 * resolves the chosen option id, because an overlay's key handling is not
 * practically testable and should therefore hold no decisions.
 */

import { Container, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildLaunchCommand, formatModelChoice } from "../domain/draft/launch.ts";
import type { Draft, ModelChoice } from "../domain/types.ts";
import { gateAMenu, type GateAOptionId } from "./menus.ts";

/** Lines of the prompt body shown inside the gate before it is truncated. */
const PROMPT_PREVIEW_LINES = 12;

export interface GateAView {
	draft: Draft;
	/** Undefined when the tier resolved to no available model. */
	choice: ModelChoice | undefined;
	promptPath: string;
	/** False when Run must be refused because no registry-backed model is selected. */
	runnable: boolean;
}

/** Truncates the prompt body to a bounded preview, noting how much was hidden. */
function previewPrompt(prompt: string): string[] {
	const lines = prompt.split("\n");
	if (lines.length <= PROMPT_PREVIEW_LINES) return lines;
	const hidden = lines.length - PROMPT_PREVIEW_LINES;
	return [...lines.slice(0, PROMPT_PREVIEW_LINES), `… ${hidden} more line${hidden === 1 ? "" : "s"}`];
}

/**
 * Builds the gate's summary lines.
 *
 * The model line states the blocked reason inline rather than omitting the model,
 * because an empty field reads as a rendering bug while an explicit sentence
 * tells the user what to do next.
 */
export function formatGateASummary(view: GateAView): string[] {
	const modelLine =
		view.choice === undefined
			? `Model:     none available for tier "${view.draft.tier}" — choose one to enable Run`
			: `Model:     ${formatModelChoice(view.choice)}`;

	const launchLine =
		view.choice === undefined
			? "Command:   available once a model is chosen"
			: `Command:   ${buildLaunchCommand(view.choice, view.promptPath)}`;

	return [
		`Handoff:   ${view.draft.slug}`,
		`Tier:      ${view.draft.tier}`,
		modelLine,
		`Rationale: ${view.draft.rationale}`,
		`Prompt:    ${view.promptPath}`,
		launchLine,
		"",
		"Prompt preview:",
		...previewPrompt(view.draft.prompt),
	];
}

/**
 * Renders Gate A and resolves the selected option.
 *
 * Resolves undefined when the user dismisses the gate, which callers treat the
 * same as Cancel.
 */
export async function openGateA(ctx: ExtensionContext, view: GateAView): Promise<GateAOptionId | undefined> {
	const options = gateAMenu(view.runnable);
	const items: SelectItem[] = options.map((option) => ({
		value: option.id,
		label: option.label,
		...(option.description === undefined ? {} : { description: option.description }),
	}));

	return ctx.ui.custom<GateAOptionId | undefined>((_tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Handoff ready for approval")), 1, 0));
		container.addChild(new Spacer(1));
		for (const line of formatGateASummary(view)) {
			// An empty Text renders zero lines, so a blank separator must be a Spacer.
			if (line === "") {
				container.addChild(new Spacer(1));
				continue;
			}
			container.addChild(new Text(theme.fg(line.startsWith("…") ? "dim" : "text", line), 1, 0));
		}
		container.addChild(new Spacer(1));

		const list = new SelectList(items, items.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("dim", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("dim", text),
		});
		list.onSelect = (item) => done(item.value as GateAOptionId);
		list.onCancel = () => done(undefined);
		container.addChild(list);

		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate   enter select   esc cancel"), 1, 0));

		// SelectList owns key handling; forwarding keeps the container focusable.
		const focusable = container as Container & { handleInput?: (data: string) => void };
		focusable.handleInput = (data: string) => list.handleInput(data);
		return focusable;
	});
}
