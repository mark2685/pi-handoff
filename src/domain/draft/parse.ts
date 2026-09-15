/**
 * Strict draft-envelope parsing for untrusted drafting-model responses.
 *
 * Models may return bare JSON or wrap it in a markdown fence whose prompt field
 * contains literal triple backticks. Rather than parse fences, this module scans
 * balanced JSON-object spans while respecting quoted strings and escapes, then
 * validates each parsed candidate in source order. This tolerates nested fence
 * markers and trailing prose. It cannot disambiguate two complete, valid draft
 * envelopes in one response; in that ambiguous case the first valid envelope
 * wins.
 */

import { err, ok, type Result } from "../result.ts";

/** The expected outcome when the response contains no parseable JSON object. */
export interface NoJsonObject {
	kind: "no_json_object";
}

/** The expected outcome when JSON was found but rejected by the supplied schema validator. */
export interface InvalidDraft<E> {
	kind: "invalid_draft";
	error: E;
}

export type DraftParseError<E> = NoJsonObject | InvalidDraft<E>;

type DraftValidator<T, E> = (value: unknown) => Result<T, E>;

/** Returns whether a parsed JSON value is an object rather than an array or null. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Attempts to parse a JSON object without allowing malformed model output to throw. */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return isJsonObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Finds the closing brace for an object, ignoring braces inside JSON strings. */
function findObjectEnd(text: string, start: number): number | undefined {
	let depth = 0;
	let inString = false;
	let escaping = false;

	for (let index = start; index < text.length; index += 1) {
		const character = text[index];
		if (character === undefined) return undefined;

		if (inString) {
			if (escaping) {
				escaping = false;
			} else if (character === "\\") {
				escaping = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}

		if (character === '"') {
			inString = true;
		} else if (character === "{") {
			depth += 1;
		} else if (character === "}") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}

	return undefined;
}

/** Collects parseable JSON objects in source order, including objects inside surrounding prose. */
function findJsonObjects(response: string): Record<string, unknown>[] {
	const objects: Record<string, unknown>[] = [];

	for (let start = 0; start < response.length; start += 1) {
		if (response[start] !== "{") continue;
		const end = findObjectEnd(response, start);
		if (end === undefined) continue;

		const value = parseJsonObject(response.slice(start, end + 1));
		if (value !== undefined) objects.push(value);
	}

	return objects;
}

/**
 * Extracts and validates the first draft-shaped JSON object in a model response.
 *
 * Keeping validation injected preserves the domain/persistence boundary: this
 * module handles untrusted text, while `persistence/schemas.ts` owns the draft
 * envelope schema and its diagnostic detail.
 */
export function parseDraft<T, E>(response: string, validate: DraftValidator<T, E>): Result<T, DraftParseError<E>> {
	let validationFailure: InvalidDraft<E> | undefined;

	for (const value of findJsonObjects(response)) {
		const result = validate(value);
		if (result.ok) return ok(result.value);
		validationFailure ??= { kind: "invalid_draft", error: result.error };
	}

	return validationFailure === undefined ? err({ kind: "no_json_object" }) : err(validationFailure);
}

/**
 * Detects the explicit, case-sensitive `NEEDS INPUT` marker in a parsed prompt.
 *
 * Word boundaries prevent near-matches such as `NEEDS INPUTS`; lowercase prose
 * such as "needs input validation" deliberately does not divert Gate A.
 */
export function hasNeedsInputMarker(prompt: string): boolean {
	return /\bNEEDS INPUT\b/.test(prompt);
}
