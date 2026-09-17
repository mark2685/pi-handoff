/**
 * The NEEDS INPUT gate: shown instead of Gate A when a draft leaves decisions
 * open. Its formatter remains pure so structured questions are inspectable
 * without a TUI; the overlay only renders it and resolves a stable menu id.
 */

import { Container, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DraftQuestion } from "../domain/types.ts";
import { needsInputMenu, type NeedsInputOptionId } from "./menus.ts";

export interface NeedsInputView {
	slug: string;
	promptPath: string;
	/** Structured questions, or one fallback question extracted from prose. */
	questions: DraftQuestion[];
}

/** The maximum number of question lines a non-scrolling gate can display legibly. */
const MAX_QUESTION_LINES = 40;

/** Renders a question independently so the same text can be capped without losing menu chrome. */
function formatQuestion(question: DraftQuestion, index: number): string[] {
	const lines = [`${index + 1}. ${question.question}`];
	if (question.context !== undefined) lines.push(`   ${question.context}`);
	for (const [choiceIndex, choice] of (question.choices ?? []).entries()) {
		const recommendation = question.recommended === choiceIndex ? " (recommended)" : "";
		lines.push(`   ${String.fromCharCode(65 + choiceIndex)}. ${choice}${recommendation}`);
	}
	return lines;
}

/**
 * Builds the gate's summary lines. The cap protects the non-scrolling shell even
 * for the prose fallback, whose model-authored extraction is necessarily looser.
 */
export function formatNeedsInputSummary(view: NeedsInputView): string[] {
	const questionLines = view.questions.flatMap(formatQuestion);
	const truncated = questionLines.length > MAX_QUESTION_LINES;

	return [
		`The draft for "${view.slug}" left decisions open and cannot run until they are answered.`,
		`Prompt:    ${view.promptPath}`,
		"",
		...questionLines.slice(0, MAX_QUESTION_LINES),
		...(truncated ? [`Questions truncated after ${MAX_QUESTION_LINES} lines; see ${view.promptPath}.`] : []),
	];
}

/** Renders the NEEDS INPUT gate and resolves undefined when the user dismisses it. */
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
