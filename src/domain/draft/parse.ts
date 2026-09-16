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

/** Matches a Markdown heading line and captures its `#` run, so its depth can be compared. */
const HEADING_LINE = /^(#{1,6})\s+/;

/** Finds the 0-based index of the first line containing the marker. */
function findMarkerLineIndex(lines: readonly string[]): number {
	return lines.findIndex((line) => hasNeedsInputMarker(line));
}

/**
 * Returns a heading section's body, bounded by the next heading at the same or
 * a shallower depth (fewer `#` characters), or the end of the prompt.
 *
 * The heading line itself is excluded: it is usually just "## NEEDS INPUT" and
 * carries no question text, so the gate would otherwise show a redundant title.
 */
function extractHeadingSection(lines: readonly string[], headingIndex: number, level: number): string {
	let end = lines.length;
	for (let index = headingIndex + 1; index < lines.length; index += 1) {
		const match = lines[index]?.match(HEADING_LINE);
		if (match !== null && match !== undefined && match[1] !== undefined && match[1].length <= level) {
			end = index;
			break;
		}
	}
	return lines
		.slice(headingIndex + 1, end)
		.join("\n")
		.trim();
}

/**
 * Returns the paragraph containing the marker, from the marker's own text
 * onward, up to the next blank line.
 *
 * Falls back to the bare marker line when no blank line follows: extracting to
 * the end of an un-paragraphed document would otherwise drag in unrelated
 * trailing content that was never delimited as part of this question.
 */
function extractParagraph(lines: readonly string[], markerLineIndex: number): string {
	const markerLine = lines[markerLineIndex] ?? "";
	const markerIndex = markerLine.search(/\bNEEDS INPUT\b/);

	let blankIndex = -1;
	for (let index = markerLineIndex; index < lines.length; index += 1) {
		if ((lines[index] ?? "").trim() === "") {
			blankIndex = index;
			break;
		}
	}

	if (blankIndex === -1) return markerLine.trim();

	const firstLine = markerLine.slice(Math.max(markerIndex, 0));
	const restLines = lines.slice(markerLineIndex + 1, blankIndex);
	return [firstLine, ...restLines].join("\n").trim();
}

/**
 * Extracts only the NEEDS INPUT questions from a drafted prompt, for the gate
 * that shows them instead of the whole prompt.
 *
 * Three shapes, tried in order: a Markdown heading whose text contains the
 * marker yields that heading's body; otherwise the marker's own paragraph, from
 * the marker onward, up to the next blank line; otherwise the bare line
 * containing the marker. Only the first occurrence of the marker is used, so a
 * prompt with two NEEDS INPUT sections surfaces the first one.
 *
 * Callers should only call this when `hasNeedsInputMarker(prompt)` is true; if
 * the marker is absent, the whole prompt is returned unchanged.
 */
export function extractNeedsInput(prompt: string): string {
	const lines = prompt.split("\n");
	const markerLineIndex = findMarkerLineIndex(lines);
	if (markerLineIndex === -1) return prompt;

	const markerLine = lines[markerLineIndex] ?? "";
	const heading = markerLine.match(HEADING_LINE);
	if (heading !== null && heading[1] !== undefined) {
		return extractHeadingSection(lines, markerLineIndex, heading[1].length);
	}

	return extractParagraph(lines, markerLineIndex);
}
