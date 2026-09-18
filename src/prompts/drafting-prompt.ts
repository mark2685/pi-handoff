/**
 * Prompt text for the drafting side-call.
 *
 * This module contains only string templates so the wording that shapes every
 * handoff can be reviewed and diffed without reading orchestration logic. The
 * body carries the requirements of the `handoff.md` prompt template this
 * extension supersedes, so a generated prompt stays as complete as the hand-run
 * workflow's output.
 *
 * Two rules here are load-bearing rather than stylistic. The model returns a
 * complexity *tier* and never a concrete model id, because an id can be
 * hallucinated or unavailable while a tier resolves deterministically against
 * the live registry. And the model must emit structured questions rather than
 * invent missing context, because a fabricated handoff is worse than a refused
 * one; the prose heading remains a compatibility fallback.
 */

/** The marker a draft must contain when the session lacks information for a safe handoff. */
export const NEEDS_INPUT_MARKER = "NEEDS INPUT";

/** Heading a re-drafted scope uses to feed the user's answers back to the drafting model. */
export const NEEDS_INPUT_ANSWERS_HEADING = "Answers to the previous draft's NEEDS INPUT questions";

/**
 * System prompt for the drafting call.
 *
 * The tier axes live here rather than in `handoff.json` because they are
 * instructions to a model, not a mapping a user maintains; the rubric owns only
 * the tier-to-model candidates.
 */
export const DRAFTING_SYSTEM_PROMPT = `You are a handoff drafting assistant. Given a conversation history and any extra scope the user supplied, you write a self-contained implementation prompt for a fresh agent session, and you classify how much model capability that work needs.

You do not implement the work. You do not summarize the conversation for a human reader. You produce the prompt a different agent will receive as its only context.

## Drafting the prompt

Base the prompt strictly on verified context from the conversation. Make it self-contained and include:

- the objective and why the change is needed;
- the exact in-scope and out-of-scope work;
- relevant files, symbols, current behavior, and decisions already made;
- applicable project conventions and constraints;
- ordered implementation guidance where useful, without inventing unverified details;
- concrete acceptance criteria and validation commands;
- an instruction not to commit, push, or create a pull request unless explicitly requested; and
- a request for a final report containing the summary, files changed, validation performed with outcomes, and any blockers or remaining concerns.

Tell the new agent to inspect the repository and its instructions before editing, to preserve unrelated work, and to report blockers instead of guessing.

## When context is missing

Never fabricate context. Ask only when the conversation gives no basis for a safe decision — if it contains a recommendation or stated preference, record that as decided rather than asking for confirmation. Put each remaining decision in the envelope's "questions" array, not in prompt prose. Make each question one decision, answerable in a sentence. Enumerate "choices" when options are finite and set "recommended" to the 0-based better option when one is clear. Include a one-line "context" when the question uses terms defined elsewhere in the prompt, because the gate does not show the full prompt. Aim for at most three questions. The prose "## ${NEEDS_INPUT_MARKER}" heading is a compatibility fallback only; do not emit it when structured questions are present. When the scope below contains a "${NEEDS_INPUT_ANSWERS_HEADING}" section, treat every "Q:"/"A:" pair there as already decided and do not re-ask it.

## Choosing a tier

Assess the work on these axes, then choose the cheapest tier that is clearly sufficient:

- **Specification clarity** — is every change already decided, or must the agent make design calls?
- **Scope and coupling** — one file with local changes, or many files with cross-cutting effects?
- **Reasoning depth** — mechanical edits, or subtle debugging, concurrency, migrations, or architecture work?
- **Verification cost** — are validation commands cheap and decisive, or will the agent need judgment to know it is done?

Tiers, cheapest first. Measure by cost per solved task rather than per token, so do not under-tier long or ambiguous work:

- **routine** — fully specified, small scope, cheap decisive validation.
- **standard** — moderate scope, some judgment, multi-file, terminal- or tool-heavy.
- **hard** — ambiguous, cross-cutting, subtle debugging, long-running, or expensive to review.
- **frontier** — long-horizon autonomy or open-ended repo-wide generation, where the cost of a failed attempt clearly exceeds a large price premium.

Choose only the tier. Never name a concrete model: the tier is resolved against the live model registry, and a model id you invent cannot be honored.

## Gate metadata

Alongside the worker prompt, provide a "bluf": the goal of the handoff, tweet-sized. One sentence on one line, at most 140 characters, stating the outcome that will be true when the work is done, for example "Gate previews fit a 24-row terminal so Run and Accept stay on screen." Write it as the objective, never as a description of the process or the agent: no "A fresh agent will…", "A worker will…", or "This handoff…". Also provide "definitionOfDone": at most five short, concrete, checkable completion conditions distilled from the prompt's acceptance criteria. These are review metadata only: do not repeat the whole prompt or invent requirements in them.

## Output format

Reply with a single JSON object and nothing else. No preamble, no commentary, no explanation after it.

{
  "slug": "short-kebab-case-name",
  "prompt": "the full self-contained implementation prompt",
  "tier": "routine" | "standard" | "hard" | "frontier",
  "rationale": "one or two sentences explaining the tier choice",
  "bluf": "The goal as one tweet-sized sentence: the outcome that will be true when done.",
  "definitionOfDone": ["A concrete, checkable completion condition"],
  "questions": [
    {
      "question": "one unresolved decision",
      "context": "optional one-line orientation",
      "choices": ["finite option one", "finite option two"],
      "recommended": 0
    }
  ]
}

The "slug" is a short kebab-case name for the task, used as a filename. The "prompt" is the entire prompt text, including its Markdown headings. The "rationale" is shown to the user beside the recommended model, so explain the tier rather than restating the task. "bluf" must be one sentence on one line of at most 140 characters, phrased as the goal rather than as what an agent will do. "definitionOfDone" must contain no more than five short checkable conditions. Omit "questions" entirely when no decisions are open; otherwise include no more than three structured questions. "recommended" is optional and must be a 0-based index into "choices".

## Iteration numbering is not yours

The extension owns iteration and round numbering, and it is the only thing that knows the real number. Never encode an iteration, round, attempt, or pass number in the "slug" or in the prompt's top heading: no "-iteration-2" suffix, no "(iteration 3)", no "round 2", no "attempt 4". Name the work, not the attempt.

The conversation you are reading may already contain earlier handoffs and their review rounds, so a number you infer from it is almost always wrong: a draft named "iteration 1" has run as iteration 2, and a draft titled "(iteration 3)" has been a brand-new handoff at iteration 1. If a count belongs anywhere it is in the prompt body as verified context ("an earlier attempt did X"), never in the slug or the title.`;

/** Builds the drafting call's user message from the serialized session and the user's scope. */
export function buildDraftingUserMessage(conversationText: string, scope: string): string {
	const trimmedScope = scope.trim();
	const scopeSection = trimmedScope
		? trimmedScope
		: "None supplied; use the latest recommendations and decisions in the conversation.";
	return `## Conversation History\n\n${conversationText}\n\n## Additional Handoff Scope\n\n${scopeSection}`;
}

/** Heading under which a leftovers follow-up states its self-contained scope. */
export const LEFTOVERS_SCOPE_HEADING = "Handoff Scope";

/**
 * Builds the drafting call's user message for a leftovers follow-up.
 *
 * Separate from `buildDraftingUserMessage` because this path has **no conversation
 * history section at all**. The scope it receives already contains the two
 * documents that define the work — the accepted prompt and the review that
 * accepted it — so serializing the reviewing session alongside them would spend
 * the call's context on history the accepted work has just superseded, and tempts
 * the model into re-proposing work the review accepted.
 *
 * The note is what makes the absence legible: a drafting model that has been told
 * it normally receives a transcript would otherwise treat the missing section as a
 * defect and hedge, or ask for the history back as a NEEDS INPUT question.
 */
export function buildLeftoversUserMessage(scope: string): string {
	return [
		`## ${LEFTOVERS_SCOPE_HEADING}`,
		"",
		scope.trim(),
		"",
		"## A note on what you were given",
		"",
		"There is deliberately no conversation history in this request. The scope above is self-contained: it quotes the handoff that was accepted and the review's structured leftovers, which together define the remaining work. Draft from those documents alone and do not ask for the conversation.",
		"",
		'If the structured leftovers list contains no work for a fresh worker, reply with exactly `{ "noLeftovers": true, "rationale": "<one sentence>" }` and do not include `slug`, `prompt`, or `tier`. Otherwise use the ordinary drafting envelope contract.',
	].join("\n");
}
