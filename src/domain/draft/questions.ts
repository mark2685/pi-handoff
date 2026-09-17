/**
 * Normalization and scope rendering for the drafting envelope's open questions.
 *
 * The model is allowed to miscount a recommendation without losing an otherwise
 * valid draft. Keeping that repair here lets persistence and command code share
 * one pure definition of a usable recommendation and of the scope transcript.
 */

import type { DraftQuestion } from "../types.ts";

/** Drops a recommendation that cannot select one of the question's choices. */
export function normalizeDraftQuestion(question: DraftQuestion): DraftQuestion {
	const { recommended, ...withoutRecommendation } = question;
	const hasRecommendation =
		recommended !== undefined &&
		question.choices !== undefined &&
		recommended >= 0 &&
		recommended < question.choices.length;
	return {
		...withoutRecommendation,
		...(hasRecommendation ? { recommended } : {}),
	};
}

/** Normalizes every question independently without changing their authored order. */
export function normalizeDraftQuestions(questions: readonly DraftQuestion[]): DraftQuestion[] {
	return questions.map(normalizeDraftQuestion);
}

/**
 * Renders answers in an unambiguous transcript that the next drafting pass can
 * treat as decisions. The questions are deliberately restated: only scope and
 * the conversation are available to that pass, not the discarded envelope.
 */
export function formatNeedsInputAnswers(answers: readonly { question: DraftQuestion; answer: string }[]): string {
	return answers.map(({ question, answer }) => `Q: ${question.question}\nA: ${answer.trim()}`).join("\n\n");
}
