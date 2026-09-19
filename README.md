# Pi Handoff

Pi Handoff is a Pi extension that keeps the current session alive as the reviewer while an isolated child `pi` process implements an approved handoff, then brings the result back for review. It supersedes the `~/.pi/agent/prompts/handoff.md` template when installed. The full design is in [`docs/design.md`](docs/design.md).

## Install

```text
pi install /absolute/path/to/pi-handoff
```

## Commands

```text
/handoff [--model provider/model-id[:thinking]] [scope]
```

- `/handoff` or `/handoff <scope>` — draft a handoff from the current session, optionally narrowed by free-text scope (anything that is not a recognized subcommand is treated as scope, not an error).
- `/handoff --model provider/model-id[:thinking] [scope]` — use an available worker model up front instead of the tier's default; omitted thinking defaults to `high`. The flag is recognized only at the beginning, so `--model` in ordinary scope prose remains part of that scope. Invalid or unavailable values warn before a drafting call is made.
- `/handoff status` — print the current handoff state. Works outside the TUI.
- `/handoff abort` — recognized but replies "is not implemented yet"; superseded by Escape in the running overlay, since the run blocks the session behind that overlay and the command cannot be typed while a worker is alive.
- `/handoff config` — recognized but replies "is not implemented yet"; the rubric is currently fixed at `DEFAULT_RUBRIC` (see Configuration below), and `~/.pi/agent/handoff.json` is not read.

Drafting requires TUI mode and a selected model; `/handoff status` works in any mode.

## Flow

1. **Draft** — a side-call on the current model serializes the session transcript and returns a strict JSON envelope: `{ slug, prompt, tier, rationale, bluf?, definitionOfDone?, questions? }`. `bluf` is a one-sentence bottom line; `definitionOfDone` has at most five short, checkable completion conditions. They are metadata for Gate A and the running overlay only — the worker prompt file remains exactly `prompt`. `questions` is bounded to three structured items (`question`, optional one-line `context`, optional `choices`, optional 0-based `recommended` choice); a bad recommendation index is ignored rather than rejecting the envelope. A non-empty `questions` array opens NEEDS INPUT as the primary signal. A standalone prose `NEEDS INPUT` line — normally `## NEEDS INPUT` — remains a fallback for a non-compliant model, but prose mentions and titles do not count. The gate shows numbered questions, context, choices, and recommendations, and offers **Answer**, **Edit**, **View draft**, **Cancel**, and — from the third round — **Proceed with recommended answers**. It asks one question at a time using a select plus Other or a text input, then feeds deterministic `Q:`/`A:` pairs into the re-draft scope; dismissing a question submits no partial answers. The prompt is always written to `/tmp/pi-handoff-<slug>.md` before Gate A, so the external fallback and manual inspection survive whatever happens next. A leftovers-only drafting call may instead return `{ "noLeftovers": true, "rationale": "…" }`, which returns to idle without opening Gate A.

   The extension owns iteration numbering, and the drafting prompt forbids the model from encoding an iteration, round, or attempt number in the `slug` or the prompt's top heading. The transcript fed to the drafting call may already contain earlier review rounds, so a number the model infers from it is usually wrong; a trailing `-iteration-N` on a slug is also stripped defensively when building the prompt path.

   The NEEDS INPUT round is counted and persisted. From the third round the gate offers **Proceed with recommended answers**, which folds in every question's `recommended` choice as its answer and answers the rest with "Use your best judgement; do not ask again", then re-enters drafting exactly as Answer does. It is withheld earlier because it answers every open question at once, including those with no recommendation. While any drafting side-call runs — including NEEDS INPUT re-drafts and leftovers drafts — its cancellable loader names the reviewing-session model and updates elapsed time live.

2. **Gate A** — shows the goal (the tweet-sized `bluf` field, labelled **Goal**) and definition of done above a height-budgeted prompt preview (up to twelve prompt lines), then the recommended `provider/model:thinking` and rationale. At constrained heights the preview collapses to a three-rendered-row floor while retaining its `… N more lines` signpost and **View full prompt**; a common Gate A fits at about 30 rows, while the largest metadata state still needs more than the 24-row minimum without removing non-preview content. A leftovers-originated proposal is labelled with its accepted handoff; if it has no definition of done, **Cancel** is placed before Run. The model line points to **Change model** for discoverability and marks a command-line selection as `from --model`. Options:
   - **Run** (shown as "Run (blocked: choose an available model first)" until an available model is chosen)
   - **Run and review** — identical to Run, and when the worker finishes normally it injects the review turn that **Review here** would have, with no second click. The choice latches across the entire feedback loop, so each later completed iteration started by **Send review to worker** also starts its review turn automatically. An interrupted iteration still opens Gate B instead, since there is no report to review.
   - **View full prompt** — opens the whole prompt in a read-only, scrollable view and returns to Gate A. The gate itself uses its available height for up to twelve prompt lines, because a gate that renders a 165-line prompt pushes its own options off the screen.
   - **Edit prompt** — opens an editor prefilled with the prompt and rewrites the `/tmp` file.
   - **Change model** — pick a model from the live registry, then a thinking level; the tier is kept for the record but the choice overrides it.
   - **Run externally (copy command)** — copies `pi --model "provider/model:thinking" @/tmp/pi-handoff-<slug>.md` to the clipboard via `pbcopy`, falling back to a notification if the clipboard is unavailable. It then **takes the same checkpoint Run takes** and records an external run in progress; see Terminal fallback below.
   - **Cancel** — returns to idle; the `/tmp` file is left in place.
3. **Run** — a git checkpoint (`git rev-parse HEAD` plus `git status --porcelain`) is taken before spawning, and the chosen model is re-checked against the live registry at the moment of the click. The worker is spawned as `pi --mode json -p --no-session --model <provider>/<model> --thinking <level> @/tmp/pi-handoff-<slug>.md` in the working directory, with no `--tools` and no `--append-system-prompt`. A live overlay keeps the goal line and a bounded definition-of-done header visible alongside the current worker phase, active tools, time since the last worker event, elapsed time, turns, tokens, context, cost, and recent tool calls. Its pulse says the overlay is live; the event age deliberately makes silence visible rather than claiming that a quiet worker is progressing. After **10 minutes** without a meaningful worker lifecycle event, a no-progress watchdog changes the status to an explicit stalled prompt that offers the user the choice to keep waiting or press Escape to stop the worker. It never kills the worker on its own; Escape remains the only path that ends a run. The declared 24-row minimum applies to this running overlay and the read-only viewer: it reserves the abort hint with two bullets there and shows up to all five on taller terminals. Pressing Escape stops the worker (SIGTERM, then SIGKILL after a grace period). An aborted run, a crashed one, or one that produced no report still reaches Gate B, marked _interrupted_, with the checkpoint retained.

   A run only counts as completed when the worker **ended cleanly**. An abort, an error stop reason, a defined error message, or a non-zero exit is an interruption even when the worker had already streamed assistant text, because the adapter's report is the last text it saw rather than the worker's conclusion. That text is retained as pre-crash output and labelled as such at Gate B and in the review turn, alongside a bounded tail of the worker's stderr; it is never presented as a report.

4. **Gate B** — shows the worker's report, `git diff --stat` against the checkpoint, usage, and, after **Review here**, the captured reviewer verdict and a height-budgeted findings preview. Its report, diffstat, review, and crash-tail previews share the rows left after fixed metadata and menu chrome, each retaining a three-rendered-row floor and its signpost; a common completed review fits at about 40 rows. The 24-row minimum does not make the largest Gate B states fit without removing non-preview content. Options (Review here is omitted for interrupted runs):
   - **Review here** — injects the report, diffstat, and review instructions into the reviewing session as a follow-up message; see Review and feedback below. After a review it becomes **Review again**.
   - **Send feedback to worker** — shown as blocked once the iteration bound is reached. After a review it becomes **Send review to worker**; a `fix` verdict puts it first, an `accept` verdict puts Accept first, and a `discard` verdict leaves Discard in place but relabels it to explain the recommendation.
   - **Discard changes** — asks for confirmation first (Keep is the default option), then reverts.
   - **Accept** (shown as "Accept (keep the tree as it is)" for an interrupted run)
   - **Accept and hand off leftovers** — offered only after an `accept` verdict whose required `Leftovers:` block contains items, or when an older captured review has no such block. It appears after the report and diffstat viewers. `Leftovers: none` removes the option entirely. Accepts exactly as Accept does, then drafts a follow-up from **the accepted prompt and only the `Leftovers:` items**; a missing legacy block falls back to the full captured review and says so in the scope. The drafting call sends no conversation history at all — the transcript source is not read on this path — and may take its explicit `noLeftovers` exit instead of opening Gate A. That holds for the whole flow, not just the first attempt: a retry after an unparseable envelope and a re-draft after answered NEEDS INPUT questions both re-send the same accepted prompt and leftovers scope, with the round's answers appended.
   - **View full report** / **View full diffstat** — read-only, scrollable views of the whole report and the whole diffstat (plus the stderr tail, when a crash left one). Returning re-renders Gate B unchanged.

   The read-only viewer these options open scrolls with the arrow keys, page up and page down, and home and end; Escape, Enter, or `q` closes it. Its window is measured in **rendered rows rather than source lines**, so a prompt written as unwrapped paragraphs — each of which occupies three or four rows on screen — fills the viewport instead of overflowing it and pushing the heading out of view. Paging follows the same measurement: a page down moves to the first line past the window on screen rather than by a row count, so no lines are skipped between two screens, and a page up returns to the window it came from.
   - **Leave this for later** — dismisses the gate without discarding or accepting; `/handoff` reopens it.

### Review and feedback

- **Review here** arms a one-shot flag and sends the report, the diffstat, and review instructions into the reviewing session as a follow-up user message. The reviewer is told to inspect the actual diff with the read and bash tools rather than trust the report, not to edit or commit anything, and to end the turn with a required `Leftovers:` block immediately before its final `Verdict: accept|fix|discard` line. The block is either `Leftovers: none` or `Leftovers:` followed by concrete worker-item bullets; no-action-needed findings, praise, notes for the human, and accepted work stay out of it. When that turn ends, the `agent_end` hook captures the final assistant text and its final non-empty verdict line, persists them on the pending review, and reopens Gate B exactly once. The reopened overlay displays the verdict and findings preview so they are not hidden behind the gate. Dismissing the gate leaves the review pending without rearming it; `/handoff` reopens it on demand.
- **Send feedback to worker** opens an editor prefilled with the captured reviewer response (minus its trailing `Verdict:` line) when one exists; verdict lines tolerate case differences, simple `*`, `_`, or backtick emphasis around the label or value, and an optional final period. The user can edit or replace it. Normalization happens before the emptiness check, so submitting only a verdict line is refused without starting a worker iteration. It appends a `## Review feedback (iteration N)` section with a preamble that names the iteration and original checkpoint, tells the fresh worker that the working tree already contains prior changes, and limits it to the review findings. It then re-runs against the **original checkpoint** from iteration 1, so Discard still undoes every iteration and the diffstat stays cumulative. A latched **Run and review** setting carries onto the restarted run, so a completed feedback iteration starts its review turn automatically; an interrupted one still stops at Gate B. Refused once `iteration >= maxIterations`.

## Safety properties

- A checkpoint is taken before the worker is spawned, never after — including for a worker the user runs in another terminal.
- A worker that dies is never reported as one that finished. An abort, an error stop reason, an error message, or a non-zero exit reaches Gate B as _interrupted_ even when assistant text had already arrived; that text is shown as pre-crash output, never as a report.
- Discard reverts only paths that were clean at checkpoint time; paths already dirty at checkpoint are skipped and listed in an acknowledgement the user must dismiss, so a worker's edits to pre-existing dirty files survive Discard.
- Discard is blocked if HEAD moved or the repository root changed since the checkpoint.
- Nothing is ever committed, pushed, or opened as a pull request by the extension or, via the prompt, by the worker.
- The worker is killed (SIGTERM, then SIGKILL after a grace period) on Escape during Run and again on `session_shutdown`, so it cannot outlive the reviewing session unnoticed.
- The reviewing session's own model, thinking level, and tools are never changed by a handoff; only the child process runs on the chosen model.
- A follow-up handoff never bypasses a gate: "Accept and hand off leftovers" routes through the same drafting, NEEDS INPUT, and Gate A path as `/handoff`.

## Recovery

Every transition appends a `handoff-state` custom session entry. On `session_start`, the latest valid entry is rehydrated:

- a bare legacy `drafting` state or `proposed` → `idle` (the `/tmp` prompt file may be stale); a `drafting` state with its persisted pending NEEDS INPUT draft reopens that gate on `/handoff`. Answered NEEDS INPUT scope replaces the drafting state's scope before each re-draft, so a later round and restart retain prior answers, as does the NEEDS INPUT round counter. If `/handoff <scope>` or `/handoff --model …` is used while resuming a pending round, the supplied scope or override is ignored with a warning; Cancel and re-run to start fresh with it.
- `running` → an _interrupted_ review, with the note "The worker was interrupted because this Pi session restarted.", keeping the checkpoint so Discard is still available.
- `running` with `external` → unchanged. Its worker is in another terminal that this session's death did not touch, so `/handoff` still offers the review-now path.
- `reviewing` → `reviewing`, with the review-turn flag cleared so a restart cannot resurrect an armed `agent_end`.

`session_shutdown` kills any running child worker and waits for it to exit before Pi tears the session down. An external run has no child, so nothing is killed.

Every field added for crashed workers (`partialReport`, `stderrTail`), external runs (`external`), Run and review (`autoReview`), and the NEEDS INPUT round (`needsInputRound`) is optional, and a completed review's `usage` is nullable rather than required, so session entries written by earlier versions still decode unchanged.

`autoReview` is persisted as a feedback-loop latch: choosing **Run and review** at Gate A carries the setting onto every restarted worker run. A child-process run cannot survive a restart, so its active iteration is always rehydrated as interrupted and never auto-reviews itself; the retained latch still applies if the user sends feedback for another iteration.

## Configuration

The rubric is currently the shipped `DEFAULT_RUBRIC` (`src/domain/rubric/defaults.ts`); per-tier default models remain a future `/handoff config` concern, and `~/.pi/agent/handoff.json` and `/handoff config` are not implemented. The drafting model chooses only a tier; resolving a tier to a concrete model is deterministic — the first candidate below that is present in the live model registry and not excluded wins:

| Tier       | Candidates (in order)                                                      |
| ---------- | -------------------------------------------------------------------------- |
| `routine`  | `bifrost-openai/gpt-5.6-luna` (medium), `bifrost/claude-sonnet-5` (medium) |
| `standard` | `bifrost-openai/gpt-5.6-terra` (high), `bifrost/claude-sonnet-5` (high)    |
| `hard`     | `bifrost/claude-opus-5` (high), `bifrost-openai/gpt-5.6-terra` (xhigh)     |
| `frontier` | `bifrost/claude-fable-5-1` (xhigh)                                         |

`maxIterations` is `3`. The no-progress watchdog threshold is `10 minutes` (`DEFAULT_NO_PROGRESS_THRESHOLD_MS` in `src/ports/worker-runner.ts`); it prompts rather than terminating a quiet worker. Excluded models: `bifrost/claude-3-haiku`, `bifrost/claude-opus-4-8`.

If no candidate for a tier is available, Gate A opens with Run blocked until the user picks a model with **Change model**.

## Terminal fallback

**Run externally** at Gate A copies the exact worker launch command to the clipboard (falling back to a notification if there is no clipboard):

```text
pi --model "provider/model:thinking" @/tmp/pi-handoff-<slug>.md
```

This preserves the original manual workflow: the `/tmp` prompt file is written before Gate A opens, so it exists regardless of which option is chosen, and the command can always be run by hand in a separate terminal.

Unlike earlier versions, choosing it does **not** return to idle. It takes the same git checkpoint Run takes and records an external run in progress, so the handoff keeps its safety boundary while the worker runs elsewhere. While that state is active:

- `/handoff status` reports `<slug> running in another terminal` and how to bring the result back.
- `/handoff` offers **I ran it — review now**, **Discard changes**, and **Leave this for later** instead of drafting a new handoff.
- **I ran it — review now** computes the diffstat against the checkpoint exactly as an internal run does, optionally accepts a pasted report (submitting an empty editor is allowed), and opens the normal Gate B — including Discard, Accept, Send feedback to worker, and the view options. Usage is absent, because no child process was measured; the gate says so rather than printing zeroes.
- **Send feedback to worker** at that Gate B starts an ordinary **internal** child-process iteration against the same checkpoint. Running the first pass by hand does not commit the follow-up passes to the same terminal, and the extension can only measure and abort a worker it spawned itself.
- An empty pasted report reaches Gate B as _interrupted_ rather than as a completed run with an empty report, since the report lives in another terminal's scrollback and its absence is not a result.
- `session_shutdown` does not try to kill anything: no child process was ever created for an external run.

An external run is also the one state that survives a Pi restart as itself. A child-process run is downgraded to an interrupted review because the child cannot outlive its parent, but an external worker is unaffected by this session dying, so the run — and its review-now path — is kept intact.

## Package layout and layering

```text
index.ts                composition root: adapters, services, command, hooks
src/domain/             pure, no IO, no Pi imports
src/ports/              interfaces for everything outside the process
src/adapters/           child-process runner, exec-based git, pbcopy, filesystem
src/persistence/        schemas for session entries and draft JSON
src/app/                HandoffMachine, DraftService, RunService, ReviewService
src/presentation/       gates, widget, model picker, read-only text viewer
src/prompts/            drafting and review prompt text
src/commands/           /handoff argument parsing and dispatch
test/domain/            rubric, draft parsing, leftovers scope, feedback append, porcelain status parsing
test/commands/          drafting loop, Gate B loop, NEEDS INPUT gate, review turn (scripted UI)
test/extension/         entry point loads and registers the expected surface
```

Dependencies point one way: `domain <- app <- adapters <- index.ts`. Only `index.ts` constructs adapters, and `node:*` imports are confined to `src/adapters/`. Each layer has its own `README.md` under `src/`. See `docs/design.md` §5.7 for the full rationale.

## Development

```bash
npm run check
```

`npm run check` runs, in order:

| Step                   | Verifies                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`    | types across `index.ts`, `src/`, and `test/`                                                                                      |
| `npm run test`         | domain unit tests and the extension load test (`node --test`)                                                                     |
| `npm run format:check` | Prettier formatting                                                                                                               |
| `npm run smoke`        | `pi --no-extensions -e . -p --no-tools "/handoff status"` exits cleanly, i.e. Pi itself can load the extension in its own runtime |

`npm run smoke` prints two benign warnings — `No models match pattern "bifrost/**"` and `"bifrost-openai/**"` — because `--no-extensions` also disables the Bifrost provider extensions that supply those models; they do not affect the exit code.

Most of the roughly 12-second run time is `test/adapters/exec-git.test.ts`, which shells out to a real `git` binary in scratch repositories for each case (init, commits, status, discard) rather than mocking it, so the checkpoint and discard behavior is verified against Git itself.
