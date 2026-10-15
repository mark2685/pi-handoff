/**
 * The questions gate: shown instead of the launch gate when a draft leaves
 * decisions open. `questionsGateContent` is pure so structured questions are
 * inspectable without a TUI; the gate frame renders it and resolves a stable menu id.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DraftQuestion } from "../domain/types.ts";
import { QUESTIONS_GATE_TITLE } from "../domain/vocabulary.ts";
import { openGate, type GateBlock, type GateSpec } from "./gate-frame.ts";
import { questionsGateMenu, type QuestionsGateOptionId } from "./menus.ts";

export interface QuestionsGateView {
	slug: string;
	promptPath: string;
	/** Structured questions, or one fallback question extracted from prose. */
	questions: DraftQuestion[];
	/**
	 * Which round of questions this is, counted from 1.
	 *
	 * Shown to the user and used to decide whether the gate offers to end the
	 * questioning by taking the model's own recommendations.
	 */
	round?: number;
}

/** Renders a question independently so the same text reads the same in the gate and in tests. */
function formatQuestion(question: DraftQuestion, index: number): string[] {
	const lines = [`${index + 1}. ${question.question}`];
	if (question.context !== undefined) lines.push(`   Context: ${question.context}`);
	for (const [choiceIndex, choice] of (question.choices ?? []).entries()) {
		const recommendation = question.recommended === choiceIndex ? " (recommended)" : "";
		lines.push(`   ${String.fromCharCode(65 + choiceIndex)}. ${choice}${recommendation}`);
	}
	return lines;
}

/** Header and the questions block the frame fits. */
export interface QuestionsGateContent {
	header: string[];
	blocks: GateBlock<QuestionsGateOptionId>[];
}

/**
 * Builds the gate's header and its one block, the questions.
 *
 * The round is stated from the second round onward. A user four rounds deep has
 * no other way to see that the model keeps asking rather than converging, which is
 * the signal that the Proceed option exists to act on. The questions are a block so
 * a prose-fallback extraction, which is necessarily looser, can be long without
 * pushing the menu off the screen; the frame shortens it and says so.
 */
export function questionsGateContent(view: QuestionsGateView): QuestionsGateContent {
	const round = view.round ?? 1;
	return {
		header: [
			`The draft for "${view.slug}" left decisions open and cannot run until they are answered.`,
			...(round > 1 ? [`Round:     ${round} of questions for this handoff`] : []),
			`Prompt:    ${view.promptPath}`,
		],
		blocks: [
			{
				id: "questions",
				label: "questions",
				text: view.questions.flatMap(formatQuestion).join("\n"),
			},
		],
	};
}

/** Everything the gate says, untruncated, for callers and tests without a terminal. */
export function formatQuestionsGateSummary(view: QuestionsGateView): string[] {
	const { header, blocks } = questionsGateContent(view);
	return [...header, ...blocks.flatMap((entry) => ["", ...entry.text.split("\n")])];
}

/** The questions gate as a spec the frame can fit. */
export function questionsGateSpec(view: QuestionsGateView): GateSpec<QuestionsGateOptionId> {
	const { header, blocks } = questionsGateContent(view);
	return {
		title: QUESTIONS_GATE_TITLE,
		tone: "warning",
		header,
		menu: questionsGateMenu({ round: view.round ?? 1 }),
		blocks,
		hint: "↑↓ navigate   enter select   esc cancel",
	};
}

/** Renders the questions gate and resolves undefined when the user dismisses it. */
export async function openQuestionsGate(
	ctx: ExtensionContext,
	view: QuestionsGateView,
): Promise<QuestionsGateOptionId | undefined> {
	return openGate(ctx, questionsGateSpec(view));
}
