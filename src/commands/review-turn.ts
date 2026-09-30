/**
 * Pi event-boundary helpers for the Review here turn.
 *
 * `agent_end` includes every message emitted by the low-level run. Gate B needs
 * only the final assistant text, not tool output or earlier assistant messages.
 *
 * It also needs to know when that final message is not a review at all. Pi's
 * `complete` path reports a provider failure as an assistant message with
 * `stopReason: "error"`, an `errorMessage`, and no content, so a reviewer model
 * that hit a 402 budget error ended a turn that looked, to a text-only reader,
 * exactly like a reviewer with nothing to say. That was persisted as
 * `review: { iteration: 2, text: "" }` and reopened Gate B as though the work had
 * been reviewed. Classifying the turn here keeps that distinction at the event
 * boundary, where the stop reason actually is.
 */

import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";

/** What an armed review turn produced, from the perspective of the pending review. */
export type ReviewTurnOutcome =
	/** A real reviewer response, which may or may not end in a `Verdict:` line. */
	| { kind: "review"; text: string }
	/** The turn ended on an error, so there is no review and the user must be told why. */
	| { kind: "failed"; errorMessage: string | undefined }
	/**
	 * The turn was stopped before it finished, typically by Escape. Whatever the reviewer
	 * had streamed is a truncated review, and saving it would prefill the feedback editor
	 * and relabel Gate B as though the diff had been fully reviewed.
	 */
	| { kind: "stopped" }
	/** The turn produced no assistant text at all, which is not a review either. */
	| { kind: "empty" };

type AssistantMessage = Extract<AgentEndEvent["messages"][number], { role: "assistant" }>;

/** Finds the final assistant message of the run, ignoring tool and user messages. */
function finalAssistantMessage(messages: AgentEndEvent["messages"]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		return message;
	}
	return undefined;
}

/** Joins the text blocks of one assistant message, dropping thinking and tool calls. */
function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** Returns the text blocks of the final assistant response, if this run produced one. */
export function finalAssistantText(messages: AgentEndEvent["messages"]): string | undefined {
	const message = finalAssistantMessage(messages);
	return message === undefined ? undefined : assistantText(message);
}

/**
 * Says whether the run that just ended actually produced a review.
 *
 * A failed turn is reported as a failure rather than as empty text, because the
 * two lead to different things being said to the user: one names the provider
 * error, the other says the reviewer wrote nothing.
 */
export function classifyReviewTurn(messages: AgentEndEvent["messages"]): ReviewTurnOutcome {
	const message = finalAssistantMessage(messages);
	if (message === undefined) return { kind: "empty" };
	if (message.stopReason === "error") return { kind: "failed", errorMessage: message.errorMessage };
	// Pi ends an aborted run with `agent_end` carrying the partial message, and providers keep
	// the text streamed so far, so an abort is only distinguishable here by its stop reason.
	if (message.stopReason === "aborted") return { kind: "stopped" };
	const text = assistantText(message);
	return text.trim() === "" ? { kind: "empty" } : { kind: "review", text };
}
