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
import { normalizeDraftQuestions } from "../domain/draft/questions.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { CapturedReview, ReviewVerdict } from "../domain/review.ts";
import type {
	Checkpoint,
	CheckpointPathStatus,
	Draft,
	DraftEnvelope,
	DraftQuestion,
	NoLeftovers,
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

/** A compact question bound keeps a malformed model response from opening an unbounded dialog sequence. */
export const MAX_DRAFT_QUESTIONS = 3;

const DraftMetadataLineSchema = Type.String({ minLength: 1, pattern: "^[^\\r\\n]*$" });

const DraftQuestionSchema = Type.Object(
	{
		question: Type.String({ minLength: 1 }),
		context: Type.Optional(Type.String({ minLength: 1, pattern: "^[^\\r\\n]*$" })),
		choices: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 8 })),
		// A bad index is repaired after structural validation instead of rejecting the entire envelope.
		recommended: Type.Optional(Type.Integer()),
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
		questions: Type.Optional(Type.Array(DraftQuestionSchema, { maxItems: MAX_DRAFT_QUESTIONS })),
		// Optional so envelopes and session entries written before Gate A metadata still decode.
		bluf: Type.Optional(DraftMetadataLineSchema),
		definitionOfDone: Type.Optional(Type.Array(DraftMetadataLineSchema, { maxItems: 5 })),
	},
	{ additionalProperties: false },
);

/** Distinct leftovers-only exit; ordinary drafts still require every Draft field above. */
export const NoLeftoversSchema = Type.Object(
	{
		noLeftovers: Type.Literal(true),
		rationale: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

/** All valid drafting-model envelopes, including the leftovers-only exit. */
export const DraftEnvelopeSchema = Type.Union([DraftSchema, NoLeftoversSchema]);

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
		overrideSource: Type.Optional(Type.Literal("command_line")),
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

const PendingDraftSchema = Type.Object(
	{
		draft: DraftSchema,
		promptPath: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const DraftingHandoffStateSchema = Type.Object(
	{
		kind: Type.Literal("drafting"),
		scope: Type.String(),
		// Optional so entries recorded before NEEDS INPUT rounds were persisted still decode.
		pendingDraft: Type.Optional(PendingDraftSchema),
		// Optional for the same reason; an absent counter reads as the first round.
		needsInputRound: Type.Optional(Type.Number()),
		// Optional so an unfinished command-line override survives a restart without rejecting older entries.
		modelOverride: Type.Optional(ModelChoiceSchema),
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
		// Optional so entries written before external runs and Run and review still decode.
		external: Type.Optional(Type.Boolean()),
		autoReview: Type.Optional(Type.Boolean()),
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
		// Nullable, not optional: an external run has no usage to report, and null says
		// "not measured" where zeroes would claim the work was free. Older entries carry
		// a usage object and still decode.
		usage: Type.Union([WorkerUsageSchema, Type.Null()]),
		external: Type.Optional(Type.Boolean()),
		autoReview: Type.Optional(Type.Boolean()),
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
		// Optional so entries recorded before crash evidence and the feedback-loop latch still decode.
		partialReport: Type.Optional(Type.String({ minLength: 1 })),
		stderrTail: Type.Optional(Type.String({ minLength: 1 })),
		autoReview: Type.Optional(Type.Boolean()),
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
export function validateDraft(value: unknown): Result<DraftEnvelope, DecodeError> {
	if (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as { noLeftovers?: unknown }).noLeftovers === true
	) {
		return decode(NoLeftoversSchema, value);
	}

	const normalized = normalizeDraftMetadata(value);
	const decoded = decode(DraftSchema, normalized);
	if (!decoded.ok) return decoded;
	const questions = decoded.value.questions;
	return ok({
		...decoded.value,
		...(questions === undefined ? {} : { questions: normalizeDraftQuestions(questions) }),
	});
}

/** Rejects the leftovers-only exit where an ordinary runnable draft is required. */
export function validateOrdinaryDraft(value: unknown): Result<Draft, DecodeError> {
	const decoded = validateDraft(value);
	if (!decoded.ok) return decoded;
	if ("noLeftovers" in decoded.value) {
		return err({ kind: "invalid", detail: "noLeftovers is valid only for a leftovers follow-up" });
	}
	return ok(decoded.value);
}

/**
 * Keeps non-critical Gate A metadata lenient without weakening the core envelope.
 *
 * A usable prompt, tier, and rationale must still validate strictly. These fields
 * are display-only, though, so a model that adds whitespace, a non-string list
 * item, or too many completion conditions should not make an otherwise runnable
 * handoff unparseable.
 */
function normalizeDraftMetadata(value: unknown): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
	const draft = { ...(value as Record<string, unknown>) };

	const bluf = draft.bluf;
	if (typeof bluf !== "string") delete draft.bluf;
	else {
		// Keep the first usable line from a model that ignored the one-line contract.
		const firstLine = bluf
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line !== "");
		if (firstLine === undefined) delete draft.bluf;
		else draft.bluf = firstLine;
	}

	const definitionOfDone = draft.definitionOfDone;
	if (!Array.isArray(definitionOfDone)) {
		delete draft.definitionOfDone;
	} else {
		const conditions = definitionOfDone
			.filter((condition): condition is string => typeof condition === "string")
			.map((condition) => condition.trim())
			.filter((condition) => condition !== "" && !/[\r\n]/.test(condition))
			.slice(0, 5);
		if (conditions.length === 0) delete draft.definitionOfDone;
		else draft.definitionOfDone = conditions;
	}

	return draft;
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
assertSchemaMatches<Static<typeof DraftQuestionSchema>, DraftQuestion>(true);
assertSchemaMatches<Static<typeof ModelCandidateSchema>, ModelCandidate>(true);
assertSchemaMatches<Static<typeof RubricSchema>, Rubric>(true);
assertSchemaMatches<Static<typeof DraftSchema>, Draft>(true);
assertSchemaMatches<Static<typeof NoLeftoversSchema>, NoLeftovers>(true);
assertSchemaMatches<Static<typeof DraftEnvelopeSchema>, DraftEnvelope>(true);
assertSchemaMatches<Static<typeof CheckpointPathStatusSchema>, CheckpointPathStatus>(true);
assertSchemaMatches<Static<typeof CheckpointSchema>, Checkpoint>(true);
assertSchemaMatches<Static<typeof ModelChoiceSchema>, ModelChoice>(true);
assertSchemaMatches<Static<typeof WorkerUsageSchema>, WorkerUsage>(true);
assertSchemaMatches<Static<typeof ReviewVerdictSchema>, ReviewVerdict>(true);
assertSchemaMatches<Static<typeof CapturedReviewSchema>, CapturedReview>(true);
assertSchemaMatches<Static<typeof HandoffStateSchema>, HandoffState>(true);
