/**
 * Gate A: the approval surface for a drafted handoff.
 *
 * Split deliberately in two. `formatGateASummary` is pure and returns the lines
 * shown above the option list, so the content of the gate — including how a
 * blocked Run and a missing model are presented — is unit-testable. The
 * `openGateA` shell only renders those lines with a `ctx.ui.custom` component and
 * resolves the chosen option id, because an overlay's key handling is not
 * practically testable and should therefore hold no decisions.
 *
 * The prompt preview stays bounded at twelve lines even though observed prompts
 * run to 165. A gate that renders a whole prompt pushes its own options off the
 * screen, so the full text belongs on the separate scrollable surface View full
 * prompt opens, and the preview's job is only to identify what is about to run.
 */

import { Container, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildLaunchCommand, formatModelChoice } from "../domain/draft/launch.ts";
import type { Draft, ModelChoice } from "../domain/types.ts";
import { gateAMenu, type GateAOptionId } from "./menus.ts";

/** Lines of the prompt body shown inside the gate before it is truncated. */
const PROMPT_PREVIEW_LINES = 12;

/** A shortened preview still needs enough context to identify the prompt. */
const MIN_PROMPT_PREVIEW_ROWS = 3;

/** Gate title, three spacers, and the footer below the select list. */
const GATE_A_CHROME_ROWS = 5;

/** Gate A always exposes all seven actions in its SelectList. */
const GATE_A_MENU_ROWS = 7;

/**
 * Largest Gate A reservation: 18 non-preview summary rows (follow-up, override,
 * and five definition-of-done items), seven menu rows, and five chrome rows.
 */
export const GATE_A_LARGEST_FIXED_ROWS = 30;

/** Common Gate A reservation: 15 non-preview summary rows, seven menu rows, and chrome. */
export const GATE_A_COMMON_FIXED_ROWS = 27;

export interface GateAView {
	draft: Draft;
	/** Undefined when the tier resolved to no available model. */
	choice: ModelChoice | undefined;
	promptPath: string;
	/** False when Run must be refused because no registry-backed model is selected. */
	runnable: boolean;
	/** Present only for the transient Gate B leftovers path. */
	leftovers?: { acceptedSlug: string };
}

/**
 * Chooses Gate A's preview footprint from the rows left after fixed content.
 *
 * A shortened preview reserves one of its rows for the `… N more lines` signpost;
 * the three-row floor therefore shows two prompt lines plus that signpost. At the
 * historical maximum the twelve prompt lines and its signpost are retained exactly
 * as before, preserving the output for callers that omit `terminalRows`.
 */
export function promptPreviewLimit(terminalRows: number, fixedRows = GATE_A_LARGEST_FIXED_ROWS): number {
	const available = Math.floor(terminalRows) - fixedRows;
	if (available >= PROMPT_PREVIEW_LINES + 1) return PROMPT_PREVIEW_LINES;
	return Math.max(MIN_PROMPT_PREVIEW_ROWS, Math.min(PROMPT_PREVIEW_LINES - 1, available));
}

/** Truncates the prompt body to a bounded preview, noting how much was hidden. */
function previewPrompt(prompt: string, limit: number): string[] {
	const lines = prompt.split("\n");
	if (lines.length <= limit) return lines;
	// At the historical maximum retain its twelve body lines plus the existing
	// signpost. A constrained cap is a rendered-row budget, so reserve one row for
	// the signpost itself rather than letting it push the final menu option away.
	const bodyLines = limit === PROMPT_PREVIEW_LINES ? limit : Math.max(1, limit - 1);
	const hidden = lines.length - bodyLines;
	// Names the option that shows the rest, so the truncation is a signpost rather
	// than a dead end the user has to guess their way out of.
	return [
		...lines.slice(0, bodyLines),
		`… ${hidden} more line${hidden === 1 ? "" : "s"} — choose "View full prompt" to read all of it`,
	];
}

/**
 * Builds the gate's summary lines.
 *
 * The model line states the blocked reason inline rather than omitting the model,
 * because an empty field reads as a rendering bug while an explicit sentence
 * tells the user what to do next.
 */
export function formatGateASummary(view: GateAView, terminalRows?: number): string[] {
	const modelLine =
		view.choice === undefined
			? `Model:     none available for tier "${view.draft.tier}" — choose one to enable Run`
			: `Model:     ${formatModelChoice(view.choice)}${view.choice.overrideSource === "command_line" ? " (from --model)" : ""} — change with \"Change model\" below`;

	const launchLine =
		view.choice === undefined
			? "Command:   available once a model is chosen"
			: `Command:   ${buildLaunchCommand(view.choice, view.promptPath)}`;

	const blufLines =
		view.draft.bluf === undefined ? ["Goal: (not provided by the drafting model)"] : [`Goal: ${view.draft.bluf}`];
	const definitionOfDoneLines =
		view.draft.definitionOfDone === undefined
			? ["Definition of done: (not provided by the drafting model)"]
			: ["Definition of done:", ...view.draft.definitionOfDone.map((condition) => `  - ${condition}`)];

	const fixedLines = [
		`Handoff:   ${view.draft.slug}`,
		...(view.leftovers === undefined ? [] : [`Follow-up: leftovers of \`${view.leftovers.acceptedSlug}\``]),
		`Tier:      ${view.draft.tier}`,
		modelLine,
		`Rationale: ${view.draft.rationale}`,
		`Prompt:    ${view.promptPath}`,
		launchLine,
		"",
		...blufLines,
		...definitionOfDoneLines,
		"",
		"Prompt preview:",
	];
	const fixedRows = Math.max(GATE_A_COMMON_FIXED_ROWS, fixedLines.length + GATE_A_MENU_ROWS + GATE_A_CHROME_ROWS);
	const limit = terminalRows === undefined ? PROMPT_PREVIEW_LINES : promptPreviewLimit(terminalRows, fixedRows);
	return [...fixedLines, ...previewPrompt(view.draft.prompt, limit)];
}

/**
 * Renders Gate A and resolves the selected option.
 *
 * Resolves undefined when the user dismisses the gate, which callers treat the
 * same as Cancel.
 */
export async function openGateA(ctx: ExtensionContext, view: GateAView): Promise<GateAOptionId | undefined> {
	const options = gateAMenu(view.runnable, {
		cancelFirst: view.leftovers !== undefined && (view.draft.definitionOfDone?.length ?? 0) === 0,
	});
	const items: SelectItem[] = options.map((option) => ({
		value: option.id,
		label: option.label,
		...(option.description === undefined ? {} : { description: option.description }),
	}));

	return ctx.ui.custom<GateAOptionId | undefined>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Handoff ready for approval")), 1, 0));
		container.addChild(new Spacer(1));
		for (const line of formatGateASummary(view, tui.terminal.rows)) {
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
