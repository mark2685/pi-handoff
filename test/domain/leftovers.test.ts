/**
 * Tests for the follow-up handoff built from an accepted review.
 *
 * The scope is assembled from the accepted prompt and the review text alone, so
 * these assert the two properties that make that safe: the instruction not to
 * redo accepted work is present and leads, and both source documents are labelled
 * rather than concatenated into one contradictory blob.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildLeftoversScope,
	LEFTOVERS_PROMPT_HEADING,
	LEFTOVERS_REVIEW_HEADING,
} from "../../src/domain/draft/leftovers.ts";

const INPUT = {
	slug: "add-retry-logic",
	prompt: "# Add retry logic\n\nImplement retries in src/client.ts.",
	reviewText: "The work is correct. Minor nits: the comment on line 12 is stale, and the test name is misleading.",
};

describe("buildLeftoversScope", () => {
	it("names the accepted handoff so the follow-up can refer to it", () => {
		assert.match(buildLeftoversScope(INPUT), /`add-retry-logic`/);
	});

	it("says the accepted work is done and must not be redone", () => {
		const scope = buildLeftoversScope(INPUT);
		assert.match(scope, /must not be redone/);
		assert.match(scope, /Do not restate or re-implement anything the review accepted as correct\./);
	});

	it("scopes the follow-up to only the items the review flagged", () => {
		assert.match(buildLeftoversScope(INPUT), /only the remaining items the review flagged/);
	});

	it("includes the review text under its own heading", () => {
		const scope = buildLeftoversScope(INPUT);
		assert.ok(scope.includes(`## ${LEFTOVERS_REVIEW_HEADING}`));
		assert.ok(scope.includes(INPUT.reviewText));
	});

	it("includes the accepted prompt under its own heading", () => {
		const scope = buildLeftoversScope(INPUT);
		assert.ok(scope.includes(`## ${LEFTOVERS_PROMPT_HEADING}`));
		assert.ok(scope.includes("Implement retries in src/client.ts."));
	});

	/**
	 * The review leads because it is the scope; the prompt is only inherited context.
	 * A drafting model that read the prompt first tends to re-propose its work.
	 */
	it("puts the review before the accepted prompt", () => {
		const scope = buildLeftoversScope(INPUT);
		assert.ok(scope.indexOf(LEFTOVERS_REVIEW_HEADING) < scope.indexOf(LEFTOVERS_PROMPT_HEADING));
	});

	it("tells the follow-up agent the tree already holds the accepted changes", () => {
		assert.match(buildLeftoversScope(INPUT), /working tree already contains the accepted changes/);
	});

	it("says so explicitly when the review captured no text, rather than inventing scope", () => {
		const scope = buildLeftoversScope({ ...INPUT, reviewText: "   " });
		assert.match(scope, /captured no text, so no leftover items are recorded/);
	});

	it("refuses to invent tasks when the review flagged nothing", () => {
		assert.match(buildLeftoversScope(INPUT), /rather than inventing tasks/);
	});

	it("reports an unavailable prompt instead of rendering an empty section", () => {
		assert.match(buildLeftoversScope({ ...INPUT, prompt: "" }), /The accepted prompt is unavailable\./);
	});
});
