/**
 * Tests for the failure-to-sentence formatter.
 *
 * Every Git failure kind is covered because this is the only thing standing
 * between a user and an unexplained refusal: a Discard that reports nothing is
 * indistinguishable from a Discard that silently did nothing. The conflict case is
 * asserted for pass-through, since a conflict already carries a user-facing
 * message and re-wording it would give the same condition two vocabularies.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeGitFailure, describeGitOrConflict } from "../../src/presentation/git-failure.ts";

describe("describeGitFailure", () => {
	it("explains a directory that is not a repository", () => {
		assert.equal(
			describeGitFailure({ kind: "not_repository", detail: "/tmp is not a git repository" }),
			"This directory is not a Git repository (/tmp is not a git repository)",
		);
	});

	it("explains a repository with no commit", () => {
		assert.equal(
			describeGitFailure({ kind: "no_head", detail: "no HEAD" }),
			"This repository has no commit to check against (no HEAD)",
		);
	});

	it("names both roots when the repository moved", () => {
		assert.equal(
			describeGitFailure({ kind: "repository_changed", checkpointRoot: "/a", currentRoot: "/b" }),
			"The repository moved from /a to /b",
		);
	});

	it("names both commits when HEAD moved", () => {
		assert.equal(
			describeGitFailure({ kind: "head_changed", checkpointHead: "abc1234", currentHead: "def5678" }),
			"HEAD moved from abc1234 to def5678 since the checkpoint",
		);
	});

	it("explains an unusable checkpoint", () => {
		assert.equal(
			describeGitFailure({ kind: "invalid_checkpoint", detail: "missing head" }),
			"The checkpoint could not be used (missing head)",
		);
	});

	it("explains an unreadable porcelain status", () => {
		assert.equal(
			describeGitFailure({ kind: "invalid_porcelain", detail: "short record" }),
			"Git reported a status this extension could not read (short record)",
		);
	});

	it("quotes the command that failed", () => {
		assert.equal(
			describeGitFailure({ kind: "command_failed", command: "git diff --stat", detail: "index locked" }),
			"`git diff --stat` failed: index locked",
		);
	});
});

describe("describeGitOrConflict", () => {
	it("passes a conflict's own message through unchanged", () => {
		assert.equal(
			describeGitOrConflict({
				kind: "conflict",
				current: "idle",
				attempted: "diffstat",
				message: "No checkpointed handoff is available to diff",
			}),
			"No checkpointed handoff is available to diff",
		);
	});

	it("formats a Git failure as the Git formatter does", () => {
		assert.equal(
			describeGitOrConflict({ kind: "no_head", detail: "no HEAD" }),
			"This repository has no commit to check against (no HEAD)",
		);
	});
});
