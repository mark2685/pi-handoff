/**
 * Pi-backed implementations of the drafting call and the session transcript.
 *
 * These are the only modules that know drafting runs through Pi's model
 * registry on the reviewing session's current model. Keeping the conversion here
 * lets DraftService be tested with canned text, and confines Pi's message,
 * session-entry, and compaction shapes to one adapter.
 *
 * The compaction branch matters: a compacted branch must contribute its summary
 * plus the entries kept after it, or a long reviewing session would hand off a
 * transcript missing everything before the compaction point. This mirrors Pi's
 * own `examples/extensions/handoff.ts`.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, type Message, type Model, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { err, ok, type Result } from "../domain/result.ts";
import type {
	DraftingFailure,
	DraftingModel,
	DraftingRequest,
	SessionTranscript,
	SessionTranscriptSource,
} from "../ports/drafting-model.ts";

/** Converts one session entry into an agent message, ignoring entries with no message. */
function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

/**
 * Collects the messages a handoff should summarize from a session branch.
 *
 * With no compaction this is the branch itself. With one, the latest compaction
 * summary stands in for the entries it replaced, followed by the entries kept
 * from `firstKeptEntryId` onward.
 */
export function collectHandoffMessages(branch: readonly SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		if (branch[index]?.type === "compaction") {
			compactionIndex = index;
			break;
		}
	}

	if (compactionIndex < 0) {
		return branch.map(entryToMessage).filter((message): message is AgentMessage => message !== undefined);
	}

	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction?.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	const compacted = [
		...(compaction === undefined ? [] : [compaction]),
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compacted.map(entryToMessage).filter((message): message is AgentMessage => message !== undefined);
}

/** Creates a transcript source over the reviewing session's current branch. */
export function createPiSessionTranscriptSource(ctx: ExtensionContext): SessionTranscriptSource {
	return {
		read(): SessionTranscript {
			const messages = collectHandoffMessages(ctx.sessionManager.getBranch());
			if (messages.length === 0) return { kind: "empty" };
			const text = serializeConversation(convertToLlm(messages));
			return text.trim() === "" ? { kind: "empty" } : { kind: "text", text };
		},
	};
}

/** Extracts assistant text, which is the only content a draft envelope can occupy. */
function extractText(content: readonly { type: string }[]): string {
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/**
 * Creates a drafting model bound to one concrete model.
 *
 * `cacheRetention: "none"` and a fresh `sessionId` keep this side-call out of the
 * reviewing session's cache and history, so drafting never perturbs the context
 * the user is reviewing with.
 */
export function createPiDraftingModel(ctx: ExtensionContext, model: Model<Api>): DraftingModel {
	return {
		async complete(request: DraftingRequest): Promise<Result<string, DraftingFailure>> {
			const userMessage: Message = {
				role: "user",
				content: [{ type: "text", text: request.userMessage }],
				timestamp: Date.now(),
			};

			try {
				const response = await ctx.modelRegistry.complete(
					model,
					{ systemPrompt: request.systemPrompt, messages: [userMessage] },
					{
						...(request.signal === undefined ? {} : { signal: request.signal }),
						cacheRetention: "none",
						sessionId: uuidv7(),
					},
				);

				if (response.stopReason === "aborted") return err({ kind: "aborted" });

				const text = extractText(response.content);
				return text.trim() === "" ? err({ kind: "empty_response" }) : ok(text);
			} catch (error) {
				if (request.signal?.aborted === true) return err({ kind: "aborted" });
				return err({
					kind: "completion_failed",
					detail: error instanceof Error ? error.message : String(error),
				});
			}
		},
	};
}
