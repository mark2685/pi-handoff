/**
 * Menu definitions for the handoff gates.
 *
 * Options pair a stable id with a display label and resolve selections back by
 * index, following Phase Runner's convention. Branching on the label itself
 * means rewording an entry silently changes behavior, and Gate A's labels carry
 * live data such as the model name, so index resolution is the only safe form.
 */

export interface MenuOption<Id extends string> {
	id: Id;
	label: string;
	/** Shown beneath the label where the surface supports it. */
	description?: string;
}

/** Presents options through an injected selector and resolves the choice to its id. */
export async function selectOption<Id extends string>(
	select: (title: string, options: string[]) => Promise<string | undefined>,
	title: string,
	options: readonly MenuOption<Id>[],
): Promise<Id | undefined> {
	const labels = options.map((option) => option.label);
	const choice = await select(title, labels);
	if (!choice) return undefined;
	return options[labels.indexOf(choice)]?.id;
}

export type GateAOptionId = "run" | "run_and_review" | "view" | "edit" | "model" | "external" | "cancel";

/**
 * Builds Gate A's options.
 *
 * Run is present but disabled-looking when no registry-backed model exists, so
 * the blocked state is visible rather than silently missing; the caller refuses
 * the action and explains why.
 *
 * "Run and review" is a separate option rather than a default or a config flag.
 * Every completed run in the observed sessions ended with the user choosing
 * Review here, several minutes after the worker finished, so the combined option
 * removes a step that was never actually a decision — while plain Run stays
 * byte-for-byte what it was, for the case where the user wants to look at the
 * diffstat before spending reviewing context.
 *
 * View full prompt sits directly after the run options because the gate can only
 * preview twelve lines of a prompt that is routinely over a hundred, and
 * approving unseen text is the one thing this gate exists to prevent.
 */
export function gateAMenu(runnable: boolean, options: { cancelFirst?: boolean } = {}): MenuOption<GateAOptionId>[] {
	const cancel = { id: "cancel" as const, label: "Cancel" };
	return [
		...(options.cancelFirst === true ? [cancel] : []),
		{
			id: "run",
			label: runnable ? "Run" : "Run (blocked: choose an available model first)",
		},
		{
			id: "run_and_review",
			label: runnable ? "Run and review" : "Run and review (blocked: choose an available model first)",
			description: "Runs the worker, then starts the review here automatically when it finishes",
		},
		{ id: "view", label: "View full prompt" },
		{ id: "edit", label: "Edit prompt" },
		{ id: "model", label: "Change model" },
		{ id: "external", label: "Run externally (copy command)" },
		...(options.cancelFirst === true ? [] : [cancel]),
	];
}

export type UnparseableOptionId = "retry" | "cancel";

/** Builds the menu shown when the drafting response could not be parsed. */
export function unparseableMenu(): MenuOption<UnparseableOptionId>[] {
	return [
		{ id: "retry", label: "Retry drafting" },
		{ id: "cancel", label: "Cancel" },
	];
}

export type NeedsInputOptionId = "answer" | "proceed" | "edit" | "view" | "cancel";

/**
 * Builds the menu shown when a draft contains open decisions.
 *
 * Answer comes first because it is the path back into an automated re-draft;
 * Edit is the manual escape hatch for a user who would rather resolve the
 * marker by hand than restate answers as scope.
 *
 * `round` gates the Proceed option, which appears only from the third round. Two
 * rounds of questions is a model converging; four rounds and thirty-five minutes
 * before Gate A, as observed, is a model stalling, and at that point taking its
 * own recommendations is strictly better than answering them one at a time. It is
 * withheld earlier because it is a blunt instrument — it answers every open
 * question at once, including the ones with no recommendation.
 */
export function needsInputMenu(options: { round?: number } = {}): MenuOption<NeedsInputOptionId>[] {
	const round = options.round ?? 1;
	return [
		{ id: "answer", label: "Answer the questions and re-draft" },
		...(round >= PROCEED_WITH_RECOMMENDED_ROUND
			? [
					{
						id: "proceed" as const,
						label: "Proceed with recommended answers",
						description: `Round ${round}: takes every recommendation, and tells the model to use its judgement elsewhere`,
					},
				]
			: []),
		{ id: "edit", label: "Edit the prompt and continue to Gate A" },
		{ id: "view", label: "View draft" },
		{ id: "cancel", label: "Cancel" },
	];
}

/** The NEEDS INPUT round from which "Proceed with recommended answers" is offered. */
export const PROCEED_WITH_RECOMMENDED_ROUND = 3;

export type GateBOptionId =
	"accept" | "accept_leftovers" | "discard" | "review" | "feedback" | "view_report" | "view_diffstat" | "dismiss";

/**
 * Builds Gate B's options in the design's order.
 *
 * `interrupted` drops Review here entirely rather than blocking it, because there
 * is no report to review; offering it at all would imply one exists. Send feedback
 * survives an interrupted run on purpose — re-running after a crash is exactly
 * what a user wants there — so it is shown as long as the bound allows it.
 *
 * When the iteration bound is reached, feedback is shown as explicitly blocked
 * rather than omitted, following the same convention as Gate A's blocked Run: a
 * silently missing option reads as a broken gate, while a blocked one states the
 * rule. The caller refuses it either way, because a label is a hint and the
 * service is the guarantee. A fix verdict moves feedback first and an accept
 * verdict moves Accept first; discard is the exception so the destructive action
 * stays in its normal position, with its label explaining the recommendation.
 */
export function gateBMenu(options: {
	interrupted: boolean;
	/** Present only when Review here captured a response for the current iteration. */
	review?: { verdict?: "accept" | "fix" | "discard"; leftovers?: "none" | "items" | "missing" };
	/** Present when a review is pending, describing whether another iteration is allowed. */
	feedback?: { allowed: boolean; iteration: number; maxIterations: number };
	/** Whether there is any report text to open in the full viewer. */
	hasReport?: boolean;
}): MenuOption<GateBOptionId>[] {
	const reviewed = options.review !== undefined;
	const reviewOptions: MenuOption<GateBOptionId>[] = options.interrupted
		? []
		: [{ id: "review", label: reviewed ? "Review again" : "Review here" }];

	const feedbackLabel =
		options.feedback !== undefined && !options.feedback.allowed
			? `${reviewed ? "Send review to worker" : "Send feedback to worker"} (blocked: iteration ${options.feedback.iteration} of ${options.feedback.maxIterations} is the last)`
			: reviewed
				? "Send review to worker"
				: "Send feedback to worker";

	const menu: MenuOption<GateBOptionId>[] = [
		...reviewOptions,
		{ id: "feedback", label: feedbackLabel },
		{
			id: "discard",
			label:
				options.review?.verdict === "discard" ? "Discard changes (reviewer recommends discard)" : "Discard changes",
		},
		{ id: "accept", label: options.interrupted ? "Accept (keep the tree as it is)" : "Accept" },
		...(options.hasReport === true ? [{ id: "view_report" as const, label: "View full report" }] : []),
		{ id: "view_diffstat", label: "View full diffstat" },
		// `none` is deliberately absent rather than disabled: there is nothing to hand
		// off. Missing preserves the old full-review fallback for captured old reviews.
		...(options.review?.verdict === "accept" &&
		options.review.leftovers !== "none" &&
		options.review.leftovers !== undefined
			? [
					{
						id: "accept_leftovers" as const,
						label: "Accept and hand off leftovers",
						description: "Accepts, then drafts a follow-up from the review's `Leftovers:` list",
					},
				]
			: []),
		{ id: "dismiss", label: "Leave this for later" },
	];
	const preferred =
		options.review?.verdict === "fix" ? "feedback" : options.review?.verdict === "accept" ? "accept" : undefined;
	if (preferred === undefined) return menu;

	const preferredOption = menu.find((option) => option.id === preferred);
	return preferredOption === undefined
		? menu
		: [preferredOption, ...menu.filter((option) => option !== preferredOption)];
}

export type ConfirmDiscardOptionId = "discard" | "keep";

/**
 * Builds the confirmation shown before a discard.
 *
 * Keep is listed first so the destructive option is never the default landing
 * position, and the discard label restates what is about to happen.
 */
export function confirmDiscardMenu(): MenuOption<ConfirmDiscardOptionId>[] {
	return [
		{ id: "keep", label: "Keep the changes" },
		{ id: "discard", label: "Discard the worker's changes" },
	];
}

export type ExternalRunOptionId = "review" | "discard" | "cancel";

/**
 * Builds the menu shown while a handoff is running in another terminal.
 *
 * This is the gate that was missing. "Run externally" used to return to idle, so
 * the extension forgot the handoff entirely and the user pasted the worker's
 * report back as an ordinary message: no checkpoint, no diffstat, and no Discard.
 * Recording the external run means `/handoff` has something to offer here, and
 * Review now is what routes it into the same Gate B an internal run reaches.
 */
export function externalRunMenu(): MenuOption<ExternalRunOptionId>[] {
	return [
		{
			id: "review",
			label: "I ran it — review now",
			description: "Reads the diffstat against the checkpoint and opens the review gate",
		},
		{ id: "discard", label: "Discard changes" },
		{ id: "cancel", label: "Leave this for later" },
	];
}
