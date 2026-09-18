/**
 * The NEEDS INPUT gate loop, kept separate from command dispatch so its answer
 * sequence can be exercised with a scripted UI. It never submits a partial
 * sequence: scope is assembled only after every dialog returns an answer.
 *
 * From the third round the gate also offers to end the questioning outright,
 * folding in every recommendation at once. That exists because the questioning is
 * not always convergent — one observed handoff spent four rounds and thirty-five
 * minutes before reaching Gate A, one round of it taking twenty-two minutes — and
 * past a couple of rounds the model's own recommendations are worth more than
 * another dialog.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DraftNeedsInput, DraftOutcome, DraftReady, DraftService } from "../app/draft-service.ts";
import { buildRecommendedAnswers, formatNeedsInputAnswers } from "../domain/draft/questions.ts";
import { extractNeedsInput } from "../domain/draft/parse.ts";
import { appendNeedsInputAnswers } from "../domain/draft/scope.ts";
import type { DraftQuestion } from "../domain/types.ts";
import { openNeedsInputGate } from "../presentation/needs-input-gate.ts";
import { openTextViewer } from "../presentation/text-viewer.ts";
import { NEEDS_INPUT_ANSWERS_HEADING } from "../prompts/drafting-prompt.ts";

/** Outcome resolved once the gate loop cannot act on the current draft itself. */
export type NeedsInputFlowResult =
	{ kind: "cancelled" } | { kind: "rescoped"; scope: string } | { kind: "ready"; view: DraftReady };

/** The old prose signal is represented as one question so the interaction remains uniform. */
function questionsFor(draft: DraftNeedsInput["draft"]): DraftQuestion[] {
	return draft.questions !== undefined && draft.questions.length > 0
		? draft.questions
		: [{ question: extractNeedsInput(draft.prompt) }];
}

/** Keeps the orientation visible after the gate is replaced by an answer dialog. */
function questionPrompt(question: DraftQuestion): string {
	return question.context === undefined ? question.question : `${question.question}\n${question.context}`;
}

/** Asks exactly one question. Undefined means cancel the whole round, not just this answer. */
async function answerQuestion(
	ctx: ExtensionContext,
	question: DraftQuestion,
	index: number,
): Promise<string | undefined> {
	const choices = question.choices ?? [];
	const prompt = questionPrompt(question);
	if (choices.length === 0) {
		return ctx.ui.input(`Answer question ${index + 1}: ${prompt}`, "");
	}

	const ordered = choices.map((choice, choiceIndex) => ({ choice, choiceIndex }));
	if (question.recommended !== undefined) {
		const recommended = ordered.splice(question.recommended, 1)[0];
		if (recommended !== undefined) ordered.unshift(recommended);
	}
	const options = [
		...ordered.map(({ choice, choiceIndex }) => ({
			label: `${choice}${question.recommended === choiceIndex ? " (recommended)" : ""}`,
			answer: choice,
		})),
		{ label: "Other (type an answer)", answer: undefined },
	];
	const selected = await ctx.ui.select(
		`Question ${index + 1}: ${prompt}`,
		options.map((option) => option.label),
	);
	if (selected === undefined) return undefined;
	const selectedOption = options.find((option) => option.label === selected);
	if (selectedOption?.answer === undefined)
		return ctx.ui.input(`Other answer for question ${index + 1}: ${prompt}`, "");
	return selectedOption.answer;
}

/** Reports a drafting-stage terminal outcome that can defensively surface after manual edit. */
function reportTerminalOutcome(ctx: ExtensionContext, outcome: DraftOutcome): void {
	if (outcome.kind === "write_failed") {
		ctx.ui.notify(`Could not write the handoff prompt to ${outcome.failure.path}: ${outcome.failure.detail}`, "error");
	}
}

/** Drives the gate until answers re-scope, an edit reaches Gate A, or the user cancels. */
export async function runNeedsInputFlow(
	ctx: ExtensionContext,
	service: DraftService,
	initial: DraftNeedsInput,
	scope: string,
): Promise<NeedsInputFlowResult> {
	let current = initial;

	for (;;) {
		const questions = questionsFor(current.draft);
		const round = service.needsInputRound();
		const selected = await openNeedsInputGate(ctx, {
			slug: current.draft.slug,
			promptPath: current.promptPath,
			questions,
			round,
		});

		if (selected === undefined || selected === "cancel") {
			service.abandon();
			ctx.ui.notify(`Handoff cancelled. Prompt left at ${current.promptPath}`, "info");
			return { kind: "cancelled" };
		}

		if (selected === "view") {
			// A real read-only surface, rather than an editor whose edits are silently dropped.
			await openTextViewer(ctx, `Draft prompt — ${current.draft.slug} (read-only)`, current.draft.prompt);
			continue;
		}

		if (selected === "proceed") {
			// Every question is answered at once: recommendations where the model gave one,
			// delegated judgement everywhere else. Both forms are ordinary answers by the time
			// they reach scope, so the drafting prompt's "already decided" rule closes them.
			const answered = formatNeedsInputAnswers(buildRecommendedAnswers(questions));
			ctx.ui.notify(
				`Proceeding with the recommended answers for round ${round}; the draft will not ask these again.`,
				"info",
			);
			return { kind: "rescoped", scope: appendNeedsInputAnswers(scope, NEEDS_INPUT_ANSWERS_HEADING, answered) };
		}

		if (selected === "answer") {
			const answers: { question: DraftQuestion; answer: string }[] = [];
			let cancelled = false;
			for (const [index, question] of questions.entries()) {
				const answer = await answerQuestion(ctx, question, index);
				if (answer === undefined) {
					cancelled = true;
					break;
				}
				if (answer.trim() === "") {
					ctx.ui.notify("An answer is required before the draft can be re-created; the gate has reopened.", "warning");
					cancelled = true;
					break;
				}
				answers.push({ question, answer });
			}
			if (cancelled) continue;
			const answered = formatNeedsInputAnswers(answers);
			return { kind: "rescoped", scope: appendNeedsInputAnswers(scope, NEEDS_INPUT_ANSWERS_HEADING, answered) };
		}

		const edited = await ctx.ui.editor("Edit handoff prompt", current.draft.prompt);
		if (edited === undefined) continue;
		const continued = await service.continueWithPrompt(edited);
		if (!continued.ok) {
			ctx.ui.notify(continued.error.message, "warning");
			continue;
		}
		if (continued.value.kind === "needs_input") {
			ctx.ui.notify(
				"The draft still leaves decisions open; answer them or finish the prompt before continuing.",
				"warning",
			);
			current = continued.value;
			continue;
		}
		if (continued.value.kind === "ready") return { kind: "ready", view: continued.value };
		reportTerminalOutcome(ctx, continued.value);
		return { kind: "cancelled" };
	}
}
