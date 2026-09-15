/**
 * Boundary for the drafting side-call and the session text it summarizes.
 *
 * Drafting runs on the reviewing session's current model through Pi's model
 * registry. Both capabilities are expressed as narrow ports so DraftService can
 * be tested with a canned response instead of a live model, and so the app
 * layer never imports Pi's registry, session manager, or message types.
 */

import type { Result } from "../domain/result.ts";

/** Expected drafting-call conditions, kept as values so a gate can render them. */
export type DraftingFailure =
	/** The user dismissed the loader, or the request signal aborted the call. */
	| { kind: "aborted" }
	/** The provider or transport failed; `detail` is diagnostic text, not structured data. */
	| { kind: "completion_failed"; detail: string }
	/** The model returned no text content at all, which no retry prompt can repair. */
	| { kind: "empty_response" };

/** One drafting request, carrying the prompt pair and the loader's abort signal. */
export interface DraftingRequest {
	systemPrompt: string;
	userMessage: string;
	/** Undefined when a caller runs the drafting call without cancellation UI. */
	signal: AbortSignal | undefined;
}

/** Runs one drafting completion on the reviewing session's current model. */
export interface DraftingModel {
	complete(request: DraftingRequest): Promise<Result<string, DraftingFailure>>;
}

/** The serialized reviewing session, or the fact that there is nothing to hand off. */
export type SessionTranscript = { kind: "empty" } | { kind: "text"; text: string };

/** Reads the current session branch as text for the drafting call. */
export interface SessionTranscriptSource {
	read(): SessionTranscript;
}
