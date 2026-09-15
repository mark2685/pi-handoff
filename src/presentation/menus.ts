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

export type GateBOptionId = "accept" | "discard" | "review" | "feedback" | "dismiss";

/**
 * Builds Gate B's options in the design's order.
 *
 * Review here and Send feedback to worker belong to a later task. They are shown
 * as explicitly blocked rather than omitted, following the same convention as
 * Gate A's blocked Run: the design describes four options, and a gate that
 * silently offers two would read as the feature being absent rather than pending.
 * The caller refuses them and says which task owns them.
 *
 * `interrupted` drops Review here even as a blocked entry, because there is no
 * report to review; offering it at all would imply one exists.
 */
export function gateBMenu(options: { interrupted: boolean }): MenuOption<GateBOptionId>[] {
	const reviewOptions: MenuOption<GateBOptionId>[] = options.interrupted
		? []
		: [{ id: "review", label: "Review here (not implemented yet)" }];

	return [
		...reviewOptions,
		{ id: "feedback", label: "Send feedback to worker (not implemented yet)" },
		{ id: "discard", label: "Discard changes" },
		{ id: "accept", label: options.interrupted ? "Accept (keep the tree as it is)" : "Accept" },
		{ id: "dismiss", label: "Leave this for later" },
	];
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
