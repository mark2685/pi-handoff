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

export type GateAOptionId = "run" | "edit" | "model" | "external" | "cancel";

/**
 * Builds Gate A's five options.
 *
 * Run is present but disabled-looking when no registry-backed model exists, so
 * the blocked state is visible rather than silently missing; the caller refuses
 * the action and explains why.
 */
export function gateAMenu(runnable: boolean): MenuOption<GateAOptionId>[] {
	return [
		{
			id: "run",
			label: runnable ? "Run" : "Run (blocked: choose an available model first)",
		},
		{ id: "edit", label: "Edit prompt" },
		{ id: "model", label: "Change model" },
		{ id: "external", label: "Run externally (copy command)" },
		{ id: "cancel", label: "Cancel" },
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

export type NeedsInputOptionId = "answer" | "edit" | "cancel";

/**
 * Builds the menu shown when a draft contains the NEEDS INPUT marker.
 *
 * Answer comes first because it is the path back into an automated re-draft;
 * Edit is the manual escape hatch for a user who would rather resolve the
 * marker by hand than restate answers as scope.
 */
export function needsInputMenu(): MenuOption<NeedsInputOptionId>[] {
	return [
		{ id: "answer", label: "Answer the questions and re-draft" },
		{ id: "edit", label: "Edit the prompt and continue to Gate A" },
		{ id: "cancel", label: "Cancel" },
	];
}

export type GateBOptionId = "accept" | "discard" | "review" | "feedback" | "dismiss";

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
	review?: { verdict?: "accept" | "fix" | "discard" };
	/** Present when a review is pending, describing whether another iteration is allowed. */
	feedback?: { allowed: boolean; iteration: number; maxIterations: number };
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
