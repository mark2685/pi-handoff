/**
 * The NEEDS INPUT gate: shown instead of Gate A when a draft leaves decisions
 * open.
 *
 * Split the same way as Gate A and Gate B. `formatNeedsInputSummary` is pure and
 * returns the lines shown above the option list, so what the gate says is
 * unit-testable without a TUI. `openNeedsInputGate` only renders those lines with
 * a `ctx.ui.custom` component and resolves the chosen option id.
 *
 * The gate deliberately shows only the extracted questions, never the whole
 * drafted prompt: that is the fix this gate exists to make. The full prompt
 * remains available at `promptPath` and through Edit.
 */

import { Container, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { needsInputMenu, type NeedsInputOptionId } from "./menus.ts";

export interface NeedsInputView {
	slug: string;
	promptPath: string;
	/** The extracted NEEDS INPUT questions, as returned by `extractNeedsInput`. */
	questions: string;
}

/**
 * Builds the gate's summary lines.
 *
 * The opening line explains why Gate A did not open, because a user landing
 * here mid-flow has no other cue that the draft was rejected rather than lost.
 */
export function formatNeedsInputSummary(view: NeedsInputView): string[] {
	return [
		`The draft for "${view.slug}" left decisions open and cannot run until they are answered.`,
		`Prompt:    ${view.promptPath}`,
		"",
		...view.questions.split("\n"),
	];
}

/**
 * Renders the NEEDS INPUT gate and resolves the selected option.
 *
 * Resolves undefined when the user dismisses the gate, which callers treat the
 * same as Cancel.
 */
export async function openNeedsInputGate(
	ctx: ExtensionContext,
	view: NeedsInputView,
): Promise<NeedsInputOptionId | undefined> {
	const options = needsInputMenu();
	const items: SelectItem[] = options.map((option) => ({
		value: option.id,
		label: option.label,
		...(option.description === undefined ? {} : { description: option.description }),
	}));

	return ctx.ui.custom<NeedsInputOptionId | undefined>((_tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("warning", theme.bold("Handoff needs input")), 1, 0));
		container.addChild(new Spacer(1));
		for (const line of formatNeedsInputSummary(view)) {
			// An empty Text renders zero lines, so a blank separator must be a Spacer.
			if (line === "") {
				container.addChild(new Spacer(1));
				continue;
			}
			container.addChild(new Text(theme.fg("text", line), 1, 0));
		}
		container.addChild(new Spacer(1));

		const list = new SelectList(items, items.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("dim", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("dim", text),
		});
		list.onSelect = (item) => done(item.value as NeedsInputOptionId);
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
