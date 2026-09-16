/**
 * Validation schemas for Pi Handoff data read from disk.
 *
 * A hand-edited or truncated `handoff.json` must be rejected at the storage
 * boundary instead of being trusted as a domain value and failing later in a
 * gate. The compile-time checks below keep these runtime schemas aligned with
 * the pure domain interfaces they protect.
 */

import { type Static, type TSchema, Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { err, ok, type Result } from "../domain/result.ts";
import type { CapturedReview, ReviewVerdict } from "../domain/review.ts";
import type {
	Checkpoint,
	CheckpointPathStatus,
	Draft,
	ModelCandidate,
	ModelChoice,
	Rubric,
	ThinkingLevel,
	Tier,
} from "../domain/types.ts";
import type { HandoffState } from "../app/handoff-machine.ts";
import type { WorkerUsage } from "../ports/worker-runner.ts";

const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

/** A provider is followed by a non-empty model id, which may contain further slashes. */
const MODEL_IDENTIFIER_PATTERN = "^[^/]+/.+$";

const ModelCandidateSchema = Type.Object(
	{
		model: Type.String({ pattern: MODEL_IDENTIFIER_PATTERN }),
		thinking: ThinkingLevelSchema,
	},
	{ additionalProperties: false },
);

const TierCandidatesSchema = Type.Array(ModelCandidateSchema, { minItems: 1 });

const TierSchema = Type.Union([
	Type.Literal("routine"),
	Type.Literal("standard"),
	Type.Literal("hard"),
	Type.Literal("frontier"),
]);

const TiersSchema = Type.Object(
	{
		routine: TierCandidatesSchema,
		standard: TierCandidatesSchema,
		hard: TierCandidatesSchema,
		frontier: TierCandidatesSchema,
	},
	{ additionalProperties: false },
);

/** A bounded loop prevents a malformed config from creating unbounded worker runs. */
export const MAX_RUBRIC_ITERATIONS = 10;

export const RubricSchema = Type.Object(
	{
		tiers: TiersSchema,
		maxIterations: Type.Integer({ minimum: 1, maximum: MAX_RUBRIC_ITERATIONS }),
		excludeModels: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

/** Strict envelope returned by the drafting model before it becomes a domain draft. */
export const DraftSchema = Type.Object(
	{
		slug: Type.String({ minLength: 1 }),
		prompt: Type.String({ minLength: 1 }),
		tier: TierSchema,
		rationale: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

/** One checkpoint path's status, retaining the pre-worker staging boundary. */
export const CheckpointPathStatusSchema = Type.Object(
	{
		indexStatus: Type.String(),
		worktreeStatus: Type.String(),
		path: Type.String(),
		originalPath: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

/** Serializable Git checkpoint used to constrain a later discard operation. */
export const CheckpointSchema = Type.Object(
	{
		repositoryRoot: Type.String(),
		head: Type.String(),
		statuses: Type.Array(CheckpointPathStatusSchema),
	},
	{ additionalProperties: false },
);

const ModelChoiceSchema = Type.Object(
	{
		provider: Type.String(),
		model: Type.String(),
		thinking: ThinkingLevelSchema,
	},
	{ additionalProperties: false },
);

const WorkerUsageSchema = Type.Object(
	{
		inputTokens: Type.Number(),
		outputTokens: Type.Number(),
		cacheReadTokens: Type.Number(),
		cacheWriteTokens: Type.Number(),
		cost: Type.Number(),
		contextTokens: Type.Number(),
		turns: Type.Number(),
	},
	{ additionalProperties: false },
);

const ReviewVerdictSchema = Type.Union([Type.Literal("accept"), Type.Literal("fix"), Type.Literal("discard")]);

/** Optional so session entries written before review capture remain readable. */
const CapturedReviewSchema = Type.Object(
	{
		iteration: Type.Number(),
		verdict: Type.Optional(ReviewVerdictSchema),
		text: Type.String(),
	},
	{ additionalProperties: false },
);

const IdleHandoffStateSchema = Type.Object({ kind: Type.Literal("idle") }, { additionalProperties: false });

const DraftingHandoffStateSchema = Type.Object(
	{
		kind: Type.Literal("drafting"),
		scope: Type.String(),
	},
	{ additionalProperties: false },
);

const ProposedHandoffStateSchema = Type.Object(
	{
		kind: Type.Literal("proposed"),
		draft: DraftSchema,
		choice: ModelChoiceSchema,
	},
	{ additionalProperties: false },
);

const RunningHandoffStateSchema = Type.Object(
	{
		kind: Type.Literal("running"),
		draft: DraftSchema,
		choice: ModelChoiceSchema,
		iteration: Type.Number(),
		startedAt: Type.String(),
		checkpoint: CheckpointSchema,
	},
	{ additionalProperties: false },
);

const CompletedReviewingHandoffStateSchema = Type.Object(
	{
		kind: Type.Literal("reviewing"),
		completion: Type.Literal("completed"),
		draft: DraftSchema,
		choice: ModelChoiceSchema,
		iteration: Type.Number(),
		checkpoint: CheckpointSchema,
		report: Type.String(),
		diffstat: Type.String(),
		usage: WorkerUsageSchema,
		review: Type.Optional(CapturedReviewSchema),
		awaitingReviewTurn: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const InterruptedReviewingHandoffStateSchema = Type.Object(
	{
		kind: Type.Literal("reviewing"),
		completion: Type.Literal("interrupted"),
		draft: DraftSchema,
		choice: ModelChoiceSchema,
		iteration: Type.Number(),
		checkpoint: CheckpointSchema,
		report: Type.Null(),
		diffstat: Type.Null(),
		usage: Type.Null(),
		interruptionNote: Type.String({ minLength: 1 }),
		review: Type.Optional(CapturedReviewSchema),
		awaitingReviewTurn: Type.Boolean(),
	},
	{ additionalProperties: false },
);

/** Strict persisted discriminated union for state appended to Pi session entries. */
export const HandoffStateSchema = Type.Union([
	IdleHandoffStateSchema,
	DraftingHandoffStateSchema,
	ProposedHandoffStateSchema,
	RunningHandoffStateSchema,
	CompletedReviewingHandoffStateSchema,
	InterruptedReviewingHandoffStateSchema,
]);

/** Describes why a persisted configuration value was rejected. */
export interface DecodeError {
	kind: "invalid";
	/** Human-readable list of the first few schema violations. */
	detail: string;
}

/** Maximum schema violations included in a decode error message. */
const MAX_REPORTED_ERRORS = 3;

/** Validates an unknown parsed-JSON value against a schema. */
function decode<const S extends TSchema>(schema: S, value: unknown): Result<Static<S>, DecodeError> {
	if (Check(schema, value)) return ok(value);
	const detail = Errors(schema, value)
		.slice(0, MAX_REPORTED_ERRORS)
		.map((issue) => `${issue.schemaPath || "/"}: ${issue.message}`)
		.join("; ");
	return err({ kind: "invalid", detail: detail || "value does not match the expected shape" });
}

/** Validates the globally persisted handoff rubric before it enters the domain. */
export function validateRubric(value: unknown): Result<Rubric, DecodeError> {
	return decode(RubricSchema, value);
}

/** Validates a drafting-model JSON envelope before it enters the domain. */
export function validateDraft(value: unknown): Result<Draft, DecodeError> {
	return decode(DraftSchema, value);
}

/** Validates a custom session entry before the app layer attempts recovery. */
export function validateHandoffState(value: unknown): Result<HandoffState, DecodeError> {
	return decode(HandoffStateSchema, value);
}

/**
 * Compile-time assertion that a schema's inferred type and the hand-written
 * domain interface describe the same shape, in both directions.
 *
 * Resolves to `false` (not `never`) on mismatch: `never` satisfies every
 * generic constraint, so a constraint-based check would silently pass.
 * Requiring the caller to pass `true` makes a mismatch a real type error.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

function assertSchemaMatches<A, B>(_matches: Exact<A, B>): void {}

assertSchemaMatches<Static<typeof ThinkingLevelSchema>, ThinkingLevel>(true);
assertSchemaMatches<Static<typeof TierSchema>, Tier>(true);
assertSchemaMatches<Static<typeof ModelCandidateSchema>, ModelCandidate>(true);
assertSchemaMatches<Static<typeof RubricSchema>, Rubric>(true);
assertSchemaMatches<Static<typeof DraftSchema>, Draft>(true);
assertSchemaMatches<Static<typeof CheckpointPathStatusSchema>, CheckpointPathStatus>(true);
assertSchemaMatches<Static<typeof CheckpointSchema>, Checkpoint>(true);
assertSchemaMatches<Static<typeof ModelChoiceSchema>, ModelChoice>(true);
assertSchemaMatches<Static<typeof WorkerUsageSchema>, WorkerUsage>(true);
assertSchemaMatches<Static<typeof ReviewVerdictSchema>, ReviewVerdict>(true);
assertSchemaMatches<Static<typeof CapturedReviewSchema>, CapturedReview>(true);
assertSchemaMatches<Static<typeof HandoffStateSchema>, HandoffState>(true);
