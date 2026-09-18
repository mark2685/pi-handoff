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

/**
 * The answer given for a question the model left without a recommendation.
 *
 * Phrased as a delegation rather than a refusal, and it closes the question
 * explicitly ("do not ask again"), because the drafting prompt treats answered
 * `Q:`/`A:` pairs as decided — an answer that merely declined to choose would
 * invite the same question next round, which is the loop this option exists to
 * break.
 */
export const USE_BEST_JUDGEMENT_ANSWER = "Use your best judgement; do not ask again.";

/**
 * Folds every open question into an answer without asking the user.
 *
 * Reached from "Proceed with recommended answers" once a drafting model has spent
 * three rounds asking (four rounds and thirty-five minutes to Gate A, in the case
 * that motivated this). A recommendation is taken as the answer; a question with
 * no usable recommendation — free text, or choices the model would not rank — is
 * delegated back with `USE_BEST_JUDGEMENT_ANSWER`.
 *
 * `normalizeDraftQuestion` has already dropped any recommendation that does not
 * select a real choice, so an out-of-range index cannot reach this and be read as
 * an answer of `undefined`.
 */
export function buildRecommendedAnswers(
	questions: readonly DraftQuestion[],
): { question: DraftQuestion; answer: string }[] {
	return questions.map((question) => {
		const normalized = normalizeDraftQuestion(question);
		const recommended = normalized.recommended === undefined ? undefined : normalized.choices?.[normalized.recommended];
		return {
			question,
			answer: recommended ?? USE_BEST_JUDGEMENT_ANSWER,
		};
	});
}
