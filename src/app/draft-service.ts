/**
 * Turns a reviewing session into an approved-ready handoff proposal.
 *
 * This service owns every step between `/handoff` and Gate A: serialize the
 * session, make the drafting side-call, parse the strict envelope, resolve the
 * tier against the live registry, write the prompt file, and drive the machine.
 * Presentation code above it only renders outcomes and collects choices, so the
 * decisions that matter stay testable without a TUI.
 *
 * Three behaviors here are correctness requirements rather than conveniences.
 * The prompt file is written before any outcome that can open a gate, so the
 * external fallback survives a later failure. A draft carrying the explicit
 * structured questions or the fallback `NEEDS INPUT` marker never reach Gate A — they are retained so the NEEDS INPUT
 * gate's Answer and Edit options can finish them later, rather than abandoned. And
 * a tier that resolves to no available model yields a ready outcome with an
 * undefined choice rather than a fabricated one, which is what lets Gate A open
 * with Run blocked.
 *
 * The machine stays in `drafting` until a real `ModelChoice` exists, because
 * `propose` requires one. That is deliberate: there is no representable
 * `proposed` state with a missing model or an open question, so neither an
 * unresolved tier nor a NEEDS INPUT draft can be mistaken for an approved
 * proposal.
 */

import { buildPromptPath } from "../domain/draft/slug.ts";
import { hasNeedsInputMarker, type DraftParseError, parseDraft } from "../domain/draft/parse.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { isModelAvailable, resolveTier } from "../domain/rubric/resolve.ts";
import type { AvailableModel, Draft, ModelChoice, Rubric } from "../domain/types.ts";
import { type DecodeError, validateDraft, validateOrdinaryDraft } from "../persistence/schemas.ts";
import type { DraftingFailure, DraftingModel, SessionTranscriptSource } from "../ports/drafting-model.ts";
import type { PromptFileWriter, PromptWriteFailure } from "../ports/prompt-file-writer.ts";
import {
	buildDraftingUserMessage,
	buildLeftoversUserMessage,
	DRAFTING_SYSTEM_PROMPT,
} from "../prompts/drafting-prompt.ts";
import type { HandoffConflict, HandoffMachine } from "./handoff-machine.ts";
import type { HandoffStateRecorder } from "./state-recorder.ts";

/** Structured questions win over prose; the marker remains a safety net for older model behavior. */
function needsInput(draft: Draft): boolean {
	return (draft.questions?.length ?? 0) > 0 || hasNeedsInputMarker(draft.prompt);
}

/** A draft that is ready for Gate A, including an unresolved-model case. */
export interface DraftReady {
	kind: "ready";
	draft: Draft;
	/** Undefined when the tier resolved to no available model; Gate A must block Run. */
	choice: ModelChoice | undefined;
	promptPath: string;
}

/** A draft that asked the user for missing context instead of inventing it. */
export interface DraftNeedsInput {
	kind: "needs_input";
	draft: Draft;
	promptPath: string;
}

/** A response that could not be parsed as the draft envelope, retained for retry or cancel. */
export interface DraftUnparseable {
	kind: "unparseable";
	rawResponse: string;
	error: DraftParseError<DecodeError>;
}

/** A leftovers review named no fresh worker work after all. */
export interface DraftNoLeftovers {
	kind: "no_leftovers";
	rationale: string;
}

/** The reviewing session had no conversation to hand off. */
export interface DraftEmptySession {
	kind: "empty_session";
}

/** The drafting call itself failed or was cancelled. */
export interface DraftFailed {
	kind: "failed";
	failure: DraftingFailure;
}

/** The prompt file could not be written, so no gate may open. */
export interface DraftWriteFailed {
	kind: "write_failed";
	failure: PromptWriteFailure;
}

export type DraftOutcome =
	| DraftReady
	| DraftNeedsInput
	| DraftUnparseable
	| DraftNoLeftovers
	| DraftEmptySession
	| DraftFailed
	| DraftWriteFailed;

/** Construction-time dependencies, all of them ports or the pure machine. */
export interface DraftServiceDeps {
	machine: HandoffMachine;
	draftingModel: DraftingModel;
	transcript: SessionTranscriptSource;
	promptWriter: PromptFileWriter;
	recorder: HandoffStateRecorder;
	rubric: Rubric;
	/** Read live on every resolution so a registry change between gates is observed. */
	availableModels: () => readonly AvailableModel[];
}

export interface DraftService {
	/** Runs or retries the drafting call for a scope and returns the Gate A outcome. */
	draft(
		scope: string,
		signal: AbortSignal | undefined,
		modelOverride?: ModelChoice,
	): Promise<Result<DraftOutcome, HandoffConflict>>;
	/**
	 * Drafts a follow-up handoff for the items an accepting review still flagged.
	 *
	 * Takes an already-built scope — `buildLeftoversScope`'s output — rather than the
	 * raw documents, because this is called again for every retry and every answered
	 * NEEDS INPUT round, and each of those must re-send the same accepted prompt and
	 * parsed leftovers (or the explicit legacy full-review fallback) with the round's answers appended. Building the scope here instead
	 * would make the caller choose between rebuilding it (losing the answers) and
	 * falling back to `draft` (which reads the transcript).
	 *
	 * The transcript source is not read at all on this path — not merely omitted from
	 * the scope — because both documents that define the leftovers are already in hand
	 * and the accepted work has just superseded the history. Enters `drafting` from
	 * `idle`, where Accept has just left the machine, and replaces the scope on a
	 * re-entry exactly as `draft` does. The result goes through the ordinary NEEDS
	 * INPUT and Gate A path, so a follow-up is never launched without the same
	 * approval as any other handoff.
	 */
	draftLeftovers(scope: string, signal: AbortSignal | undefined): Promise<Result<DraftOutcome, HandoffConflict>>;
	/** The current NEEDS INPUT round, counted from 1, for the gate's escape hatch. */
	needsInputRound(): number;
	/** Records a user-selected model, overriding the tier's recommendation. */
	chooseModel(choice: ModelChoice): Result<DraftReady, HandoffConflict>;
	/** Rewrites the prompt file and the retained draft after Edit prompt. */
	revisePrompt(prompt: string): Promise<Result<DraftReady, HandoffConflict | PromptWriteFailure>>;
	/**
	 * Finishes a retained draft with replacement prompt text, from the NEEDS INPUT
	 * gate's Answer (re-drafted prompt) or Edit (hand-edited prompt) options.
	 * Refuses with a conflict when no draft is retained; returns `needs_input`
	 * again, rather than a conflict, when the replacement prompt still carries the
	 * marker.
	 */
	continueWithPrompt(prompt: string): Promise<Result<DraftOutcome, HandoffConflict>>;
	/** Re-checks a choice against the live registry immediately before Run. */
	isChoiceRunnable(choice: ModelChoice | undefined): boolean;
	/** Returns to idle after Cancel, Run externally, or a terminal failure. */
	abandon(): void;
}

/** Wires the drafting flow to the machine, its ports, and the shipped rubric. */
export function createDraftService(deps: DraftServiceDeps): DraftService {
	const { machine, draftingModel, transcript, promptWriter, recorder, rubric, availableModels } = deps;

	/**
	 * The draft retained while the machine cannot expose one: an unresolved tier
	 * awaiting a model, or a NEEDS INPUT draft awaiting an answer or an edit.
	 *
	 * `machine.draft()` is undefined in the `drafting` state, which is exactly the
	 * state both of those outcomes leave behind, so Change model and the NEEDS
	 * INPUT gate need the draft that the pending outcome carried. It is retained
	 * here rather than pushed into the machine so no state can hold a draft
	 * without a model or with an unanswered question. Cleared on every terminal
	 * outcome so a later handoff can never inherit a stale draft, and replaced
	 * rather than leaked across a re-draft.
	 */
	let retainedDraft: Draft | undefined;

	/** Persists the machine's current state so a resumed session can recover it. */
	function record(): void {
		recorder.record(machine.current());
	}

	/**
	 * Returns to idle and records the reset, used by every terminal drafting outcome.
	 *
	 * Idempotent, and that is load-bearing rather than defensive. Abandonment is
	 * genuinely racy: cancelling the drafting loader resolves the overlay at the
	 * keypress, while the side-call it abandoned settles separately and reports
	 * `aborted`, so both the command layer and `draft()` legitimately call this for
	 * the same cancellation. Recording unconditionally appended two consecutive
	 * `idle` entries within the same second, which reads in the session log as two
	 * abandoned handoffs. Skipping an already-idle machine keeps one abandonment to
	 * one record without making either caller responsible for guessing whether the
	 * other already ran.
	 */
	function abandon(): void {
		retainedDraft = undefined;
		if (machine.current().kind === "idle") return;
		machine.reset();
		record();
	}

	/**
	 * Writes the prompt before any outcome that can open a gate.
	 *
	 * A write failure abandons the handoff rather than continuing, because Gate A
	 * would otherwise offer a Run externally command for a file that is missing.
	 */
	async function writePrompt(draft: Draft): Promise<Result<string, PromptWriteFailure>> {
		const promptPath = buildPromptPath(draft.slug);
		const written = await promptWriter.write(promptPath, draft.prompt);
		return written.ok ? ok(promptPath) : err(written.error);
	}

	/** Records a resolved choice on the machine, whether it is the first or a replacement. */
	function applyChoice(draft: Draft, choice: ModelChoice): Result<void, HandoffConflict> {
		const applied =
			machine.current().kind === "proposed" ? machine.updateProposal(draft, choice) : machine.propose(draft, choice);
		if (!applied.ok) return err(applied.error);
		record();
		return ok(undefined);
	}

	/**
	 * The draft awaiting a model or an answer, which the machine cannot expose
	 * while drafting. A persisted pending draft takes precedence after recovery.
	 */
	function pendingDraft(): Draft | undefined {
		const state = machine.current();
		return machine.draft() ?? (state.kind === "drafting" ? state.pendingDraft?.draft : undefined) ?? retainedDraft;
	}

	/** Persists the open round without making a draft with unanswered questions look proposed. */
	function retainNeedsInputDraft(draft: Draft, promptPath: string): Result<void, HandoffConflict> {
		retainedDraft = draft;
		// Counted before the envelope is retained, because the machine infers an implicit
		// round from a retained envelope when no counter exists (an older entry). Counting
		// afterwards would make this round look like the second one.
		const counted = machine.beginNeedsInputRound();
		if (!counted.ok) return err(counted.error);
		const retained = machine.setPendingDraft({ draft, promptPath });
		if (!retained.ok) return err(retained.error);
		record();
		return ok(undefined);
	}

	/**
	 * Finishes a parsed draft envelope: write the prompt, divert to NEEDS INPUT if
	 * the marker survives, otherwise resolve the tier and propose.
	 *
	 * Shared by `draft()` and `continueWithPrompt()`, the two paths that produce a
	 * draft envelope ready to finalize, so the write-before-gate and
	 * marker-before-resolution rules live in exactly one place instead of two.
	 */
	async function finishDraft(draft: Draft): Promise<Result<DraftOutcome, HandoffConflict>> {
		const written = await writePrompt(draft);
		if (!written.ok) {
			abandon();
			return ok({ kind: "write_failed", failure: written.error });
		}

		// Structured questions are the primary signal; the prose marker survives as a non-compliant-model fallback.
		if (needsInput(draft)) {
			const retained = retainNeedsInputDraft(draft, written.value);
			if (!retained.ok) return err(retained.error);
			return ok({ kind: "needs_input", draft, promptPath: written.value });
		}

		const draftingState = machine.current();
		const modelOverride = draftingState.kind === "drafting" ? draftingState.modelOverride : undefined;
		if (modelOverride !== undefined) {
			const applied = applyChoice(draft, modelOverride);
			if (!applied.ok) return err(applied.error);
			retainedDraft = undefined;
			return ok({ kind: "ready", draft, choice: modelOverride, promptPath: written.value });
		}

		const resolution = resolveTier(rubric, draft.tier, availableModels());
		if (resolution.kind === "none_available") {
			// No representable proposal exists without a model, so the machine stays drafting.
			retainedDraft = draft;
			return ok({ kind: "ready", draft, choice: undefined, promptPath: written.value });
		}

		const applied = applyChoice(draft, resolution.choice);
		if (!applied.ok) return err(applied.error);
		retainedDraft = undefined;
		return ok({ kind: "ready", draft, choice: resolution.choice, promptPath: written.value });
	}

	/**
	 * Enters `drafting` with a scope, or replaces the scope of a draft already running.
	 *
	 * Both drafting entry points re-enter: `draft` on a retry after an unparseable
	 * envelope or an answered question round, `draftLeftovers` for the same two reasons.
	 * Replacing rather than ignoring the scope is what makes answered NEEDS INPUT
	 * decisions — and, for a leftovers follow-up, the accepted prompt and parsed leftovers
	 * the scope carries — survive another round and a session restart.
	 */
	function enterDrafting(scope: string, modelOverride?: ModelChoice): Result<void, HandoffConflict> {
		const entered =
			machine.current().kind === "drafting"
				? machine.replaceDraftScope(scope)
				: machine.beginDraft(scope, modelOverride);
		if (!entered.ok) return err(entered.error);
		record();
		return ok(undefined);
	}

	/**
	 * Runs the drafting side-call for an already-`drafting` machine and finishes it.
	 *
	 * Shared by `draft` and `draftLeftovers` so the two entry points cannot drift on
	 * the parts that matter: a parse failure stays in `drafting` for retry, and a
	 * success clears any prior question round before the envelope is finalized.
	 *
	 * The user message is built by the caller rather than here, because the two
	 * callers disagree about the one thing this function must not decide: an ordinary
	 * draft is a transcript plus a scope, while a leftovers follow-up is a scope
	 * alone. Passing the finished message in keeps the transcript read out of this
	 * shared path entirely, so the leftovers promise — no transcript — is a property
	 * of the code rather than of a comment.
	 */
	async function completeDraftingCall(
		userMessage: string,
		signal: AbortSignal | undefined,
		allowNoLeftovers: boolean,
	): Promise<Result<DraftOutcome, HandoffConflict>> {
		const response = await draftingModel.complete({
			systemPrompt: DRAFTING_SYSTEM_PROMPT,
			userMessage,
			signal,
		});
		if (!response.ok) {
			abandon();
			return ok({ kind: "failed", failure: response.error });
		}

		const parsed = parseDraft(response.value, allowNoLeftovers ? validateDraft : validateOrdinaryDraft);
		if (!parsed.ok) {
			// Deliberately stays in `drafting` so the caller can retry without re-entering.
			return ok({ kind: "unparseable", rawResponse: response.value, error: parsed.error });
		}

		if ("noLeftovers" in parsed.value) {
			// This envelope is legal only on the transcript-free leftovers path. It has no
			// prompt to write or approve, so abandon before returning to the command loop.
			abandon();
			return ok({ kind: "no_leftovers", rationale: parsed.value.rationale });
		}

		// A successful re-draft supersedes a persisted prior question round before it is finalized.
		const drafting = machine.current();
		if (drafting.kind === "drafting" && drafting.pendingDraft !== undefined) {
			const cleared = machine.clearPendingDraft();
			if (!cleared.ok) return err(cleared.error);
			record();
		}
		return finishDraft(parsed.value);
	}

	return {
		async draft(
			scope: string,
			signal: AbortSignal | undefined,
			modelOverride?: ModelChoice,
		): Promise<Result<DraftOutcome, HandoffConflict>> {
			const entered = enterDrafting(scope, modelOverride);
			if (!entered.ok) return err(entered.error);

			// Read here rather than in the shared path: this is the only entry point that
			// hands off a conversation, so it is the only one an empty session can refuse.
			const session = transcript.read();
			if (session.kind === "empty") {
				abandon();
				return ok({ kind: "empty_session" });
			}

			return completeDraftingCall(buildDraftingUserMessage(session.text, scope), signal, false);
		},

		async draftLeftovers(
			scope: string,
			signal: AbortSignal | undefined,
		): Promise<Result<DraftOutcome, HandoffConflict>> {
			const entered = enterDrafting(scope);
			if (!entered.ok) return err(entered.error);
			// No transcript read, and so no `empty_session` outcome: the accepted prompt and
			// the review text the scope carries are the entire input. Routing this through the
			// transcript would have abandoned a leftovers draft as `empty_session` on an empty
			// session, which is nonsense for a path whose source documents are both already in
			// hand.
			return completeDraftingCall(buildLeftoversUserMessage(scope), signal, true);
		},

		needsInputRound(): number {
			return machine.needsInputRound();
		},

		chooseModel(choice: ModelChoice): Result<DraftReady, HandoffConflict> {
			const pending = pendingDraft();
			if (pending === undefined) {
				return err({
					kind: "conflict",
					current: machine.current().kind,
					attempted: "chooseModel",
					message: "No drafted handoff is available to assign a model to",
				});
			}
			if (needsInput(pending)) {
				return err({
					kind: "conflict",
					current: machine.current().kind,
					attempted: "chooseModel",
					message: "Answer the NEEDS INPUT questions, or remove the marker, before choosing a model",
				});
			}

			const applied = applyChoice(pending, choice);
			if (!applied.ok) return err(applied.error);
			retainedDraft = undefined;
			return ok({ kind: "ready", draft: pending, choice, promptPath: buildPromptPath(pending.slug) });
		},

		async revisePrompt(prompt: string): Promise<Result<DraftReady, HandoffConflict | PromptWriteFailure>> {
			const existing = pendingDraft();
			if (existing === undefined) {
				return err({
					kind: "conflict",
					current: machine.current().kind,
					attempted: "revisePrompt",
					message: "No drafted handoff is available to edit",
				});
			}
			if (needsInput(existing)) {
				return err({
					kind: "conflict",
					current: machine.current().kind,
					attempted: "revisePrompt",
					message: "Answer the NEEDS INPUT questions, or remove the marker, before editing the prompt",
				});
			}

			const revised: Draft = { ...existing, prompt };
			const written = await writePrompt(revised);
			if (!written.ok) return err(written.error);

			const choice = machine.choice();
			if (choice !== undefined) {
				const applied = applyChoice(revised, choice);
				if (!applied.ok) return err(applied.error);
			} else {
				retainedDraft = revised;
			}

			return ok({ kind: "ready", draft: revised, choice, promptPath: written.value });
		},

		async continueWithPrompt(prompt: string): Promise<Result<DraftOutcome, HandoffConflict>> {
			const existing = pendingDraft();
			if (existing === undefined) {
				return err({
					kind: "conflict",
					current: machine.current().kind,
					attempted: "continueWithPrompt",
					message: "No drafted handoff is available to continue",
				});
			}

			// Edit is the manual escape hatch: its explicit Gate A intent resolves the retained questions.
			const revised: Draft = {
				slug: existing.slug,
				prompt,
				tier: existing.tier,
				rationale: existing.rationale,
				...(existing.bluf === undefined ? {} : { bluf: existing.bluf }),
				...(existing.definitionOfDone === undefined ? {} : { definitionOfDone: existing.definitionOfDone }),
			};
			return finishDraft(revised);
		},

		isChoiceRunnable(choice: ModelChoice | undefined): boolean {
			if (choice === undefined) return false;
			return isModelAvailable(`${choice.provider}/${choice.model}`, availableModels());
		},

		abandon,
	};
}
