/**
 * Pi event-boundary helpers for the Review here turn.
 *
 * `agent_end` includes every message emitted by the low-level run. Gate B needs
 * only the final assistant text, not tool output or earlier assistant messages.
 */

import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";

/** Returns the text blocks of the final assistant response, if this run produced one. */
export function finalAssistantText(messages: AgentEndEvent["messages"]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		return message.content
			.filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
			.map((block) => block.text)
			.join("");
	}
	return undefined;
}
