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
import type { ModelCandidate, Rubric, ThinkingLevel } from "../domain/types.ts";

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
assertSchemaMatches<Static<typeof ModelCandidateSchema>, ModelCandidate>(true);
assertSchemaMatches<Static<typeof RubricSchema>, Rubric>(true);
