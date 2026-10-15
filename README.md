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
- `/handoff abort` — recognized but replies "is not implemented yet"; superseded by Escape in the run monitor, since the run blocks the session behind the run monitor and the command cannot be typed while a worker is alive.
- `/handoff config` — recognized but replies "is not implemented yet"; the rubric is currently fixed at `DEFAULT_RUBRIC` (see Configuration below), and `~/.pi/agent/handoff.json` is not read.

Drafting requires TUI mode and a selected model; `/handoff status` works in any mode.

## Flow

1. **Draft** — a side-call on the current model serializes the session transcript and returns a strict JSON envelope: `{ slug, prompt, tier, rationale, bluf?, definitionOfDone?, questions? }`. `bluf` is the one-sentence goal; `definitionOfDone` has at most five short, checkable completion conditions. They are metadata for the launch gate and the run monitor only — the worker prompt file remains exactly `prompt`. `questions` is bounded to three structured items (`question`, optional one-line `context`, optional `choices`, optional 0-based `recommended` choice); a bad recommendation index is ignored rather than rejecting the envelope. A non-empty `questions` array opens the questions gate as the primary signal. A standalone prose `NEEDS INPUT` line — normally `## NEEDS INPUT` — remains a fallback for a non-compliant model, but prose mentions and titles do not count. The gate shows numbered questions, context, choices, and recommendations, and offers **Answer**, **Edit**, **View draft**, **Cancel**, and — from the third round — **Proceed with recommended answers**. It asks one question at a time using a select plus Other or a text input, then feeds deterministic `Q:`/`A:` pairs into the re-draft scope; dismissing a question submits no partial answers. If that re-draft **fails**, the answers are not lost: the answered round stays persisted and the failure is reported with its real cause, with **Retry the draft with the same answers** or an explicit cancel that says the answers are being discarded. Dismissing that failure menu is not a cancel: it keeps the saved answers, and `/handoff` resumes the re-draft with them. Cancelling the drafting loader still ends the handoff, since that is a deliberate choice rather than a provider failure. The prompt is always written to `/tmp/pi-handoff-<slug>.md` before the launch gate, so the external fallback and manual inspection survive whatever happens next. A leftovers-only drafting call may instead return `{ "noLeftovers": true, "rationale": "…" }`, which returns to idle without opening the launch gate.

   The extension owns iteration numbering, and the drafting prompt forbids the model from encoding an iteration, round, or attempt number in the `slug` or the prompt's top heading. The transcript fed to the drafting call may already contain earlier review rounds, so a number the model infers from it is usually wrong; a trailing `-iteration-N` on a slug is also stripped defensively when building the prompt path.

   The questions round is counted and persisted. From the third round the gate offers **Proceed with recommended answers**, which folds in every question's `recommended` choice as its answer and answers the rest with "Use your best judgement; do not ask again", then re-enters drafting exactly as Answer does. It is withheld earlier because it answers every open question at once, including those with no recommendation. While any drafting side-call runs — including questions-gate re-drafts and leftovers drafts — its cancellable loader names the reviewing-session model and updates elapsed time live.

2. **Launch gate** — shows the handoff's identity — slug, tier, the recommended `provider/model:thinking`, rationale, prompt path, and launch command — then the goal (the tweet-sized `bluf` field, labelled **Goal**) and definition of done, then the menu, then as much of the prompt as the terminal has rows for. Every gate is laid out by the same **gate frame** (see Gates below): the menu is always on screen, and the evidence below it is what gives way. A leftovers-originated proposal is labelled with its accepted handoff; if it has no definition of done, **Cancel** is placed before Run. The model line points to **Change model** for discoverability and marks a command-line selection as `from --model`. Options:
   - **Run** (shown as "Run (blocked: choose an available model first)" until an available model is chosen)
   - **Run and review** — identical to Run, and when the worker finishes normally it injects the review turn that **Review here** would have, with no second click. The choice latches across the entire feedback loop, so each later completed iteration started by **Send review to worker** also starts its review turn automatically. An interrupted iteration still opens the result gate instead, since there is no report to review.
   - **View full prompt** — opens the whole prompt in a read-only, scrollable view and returns to the launch gate. The gate itself shows only what fits below its menu, because a gate that renders a 165-line prompt pushes its own options off the screen.
   - **Edit prompt** — opens an editor prefilled with the prompt and rewrites the `/tmp` file.
   - **Change model** — pick a model from the live registry, then a thinking level; the tier is kept for the record but the choice overrides it.
   - **Run externally (copy command)** — copies `pi --model "provider/model:thinking" @/tmp/pi-handoff-<slug>.md` to the clipboard via `pbcopy`, falling back to a notification if the clipboard is unavailable. It then **takes the same checkpoint Run takes** and records an external run in progress; see Terminal fallback below.
   - **Cancel** — returns to idle; the `/tmp` file is left in place.
3. **Run** — a git checkpoint (`git rev-parse HEAD` plus `git status --porcelain`) is taken before spawning, and the chosen model is re-checked against the live registry at the moment of the click. The worker is spawned as `pi --mode json -p --no-session --model <provider>/<model> --thinking <level> @/tmp/pi-handoff-<slug>.md` in the working directory, with no `--tools` and no `--append-system-prompt`. A run monitor keeps the goal line and a bounded definition-of-done header visible alongside the current worker phase, active tools, time since the last worker event, elapsed time, turns, tokens, context, cost, and recent tool calls. Its pulse says the surface is live; the event age deliberately makes silence visible rather than claiming that a quiet worker is progressing. After **10 minutes** without a meaningful worker lifecycle event, a no-progress watchdog changes the status to an explicit stalled prompt that offers the user the choice to keep waiting or press Escape to stop the worker. It never kills the worker on its own; Escape remains the only path that ends a run. The declared 24-row minimum applies to this run monitor and the read-only viewer: it reserves the abort hint with two bullets there and shows up to all five on taller terminals. Pressing Escape stops the worker (SIGTERM, then SIGKILL after a grace period). A stopped run, a crashed one, or one that produced no report still reaches the result gate, marked _interrupted_, with the checkpoint retained.

   A run only counts as completed when the worker **ended cleanly**. An abort, an error stop reason, a defined error message, or a non-zero exit is an interruption even when the worker had already streamed assistant text, because the adapter's report is the last text it saw rather than the worker's conclusion. That text is retained as partial output and labelled as such at the result gate and in the review turn, alongside a bounded tail of the worker's stderr; it is never presented as a report.

   "Ended cleanly" is judged on the run's **final** state, not on any attempt within it. Pi retries a transient provider failure inside the worker, emitting the failed attempt's error before it carries on, so a run whose retry succeeded is completed and its final report is used; only a run whose retries ran out is interrupted, with the real error in its note. Errors the extension itself observes — a spawn failure or a killed pipe — are never cleared by a later worker message.

   The usage measured before an interruption is kept and shown at the result gate, under a heading that says it was measured before the run ended. Tokens and cost are measured rather than reported, so a crashed or stopped worker still spent what it spent; only a run nobody measured — one in another terminal, or one whose session restarted — reports no usage at all.

4. **Result gate** — shows the handoff's identity and usage, then — after **Review here** — the reviewer's verdict among the identity lines above the menu it orders, then the menu, then the worker's report, the reviewer's findings, `git diff --stat` against the checkpoint, and any crash evidence, in that priority, each shortened to the rows available with a signpost — naming the viewer that shows the rest where one exists; the findings block has none, since the full review is in the transcript. Options (Review here is omitted for interrupted runs):
   - **Review here** — injects the report, diffstat, and review instructions into the reviewing session as a follow-up message; see Review and feedback below. After a review it becomes **Review again**.
   - **Send feedback to worker** — shown as blocked once the iteration bound is reached. After a review it becomes **Send review to worker**; a `fix` verdict puts it first, an `accept` verdict puts Accept first, and a `discard` verdict leaves Discard in place but relabels it to explain the recommendation.
   - **Discard changes** — asks for confirmation first (Keep is the default option), then reverts.
   - **Accept** (shown as "Accept (keep the tree as it is)" for an interrupted run)
   - **Accept and hand off leftovers** — offered only after an `accept` verdict whose required `Leftovers:` block contains items, or when an older captured review has no such block. It appears after the report and diffstat viewers. `Leftovers: none` removes the option entirely. Accepts exactly as Accept does, then drafts a follow-up from **the accepted prompt and only the `Leftovers:` items**; a missing legacy block falls back to the full captured review and says so in the scope. The drafting call sends no conversation history at all — the transcript source is not read on this path — and may take its explicit `noLeftovers` exit instead of opening the launch gate. That holds for the whole flow, not just the first attempt: a retry after an unparseable envelope and a re-draft after answered questions-gate questions both re-send the same accepted prompt and leftovers scope, with the round's answers appended.
   - **View full report** / **View full diffstat** — read-only, scrollable views of the whole report and the whole diffstat (plus the stderr tail, when a crash left one). Returning re-renders the result gate unchanged.

   The read-only viewer these options open scrolls with the arrow keys, page up and page down, and home and end; Escape, Enter, or `q` closes it. Its window is measured in **rendered rows rather than source lines**, so a prompt written as unwrapped paragraphs — each of which occupies three or four rows on screen — fills the viewport instead of overflowing it and pushing the heading out of view. Paging follows the same measurement: a page down moves to the first line past the window on screen rather than by a row count, so no lines are skipped between two screens, and a page up returns to the window it came from.
   - **Leave this for later** — dismisses the gate without discarding or accepting; `/handoff` reopens it.

### Gates

The questions gate, the launch gate, and the result gate are laid out by one module, the **gate frame** (`src/presentation/gate-frame.ts`, ADR-0001). A gate module says what the gate contains — a title, fixed header lines, a menu, and evidence blocks in priority order — and the frame decides how much of it fits, measured in **rendered rows at the real terminal width** inside `render(width)`, exactly as the read-only viewer does. The layout is title, header, menu, evidence, hint: the decision is at a fixed position and the evidence is what gives way. Each evidence block shrinks in priority order to a floor of two rows plus its signpost; a block that cannot reach its floor is hidden behind a **hidden-blocks line**; only then is the header cut from the bottom. The menu and hint are never cut. The frame budgets `tui.terminal.rows` less four rows reserved for the fullscreen dock's other occupants — the transcript's one-row minimum, Pi's two-row footer, and one row of slack — because a component cannot learn the height it was allocated. The result gate offers a viewer (**View full report**, **View partial output**, **View full diffstat**) only for a block the frame had to shorten, so a viewer never opens on text the gate already showed in full; the menu is re-resolved after a resize, so a block cut by a smaller terminal gets its viewer back. Replayed against 238 result gates and 168 launch gates recorded in real sessions, no gate overflows at any common terminal size; previously 82% of those result gates did at 120×50, because their budgets counted source lines while reports wrap to three or four rows per line.

### Review and feedback

- **Review here** arms a one-shot flag and sends the report, the diffstat, and review instructions into the reviewing session as a follow-up user message. The reviewer is told to inspect the actual diff with the read and bash tools rather than trust the report, not to edit or commit anything, and to end the turn with a required `Leftovers:` block immediately before its final `Verdict: accept|fix|discard` line. The block is either `Leftovers: none` or `Leftovers:` followed by concrete worker-item bullets; no-action-needed findings, praise, notes for the human, and accepted work stay out of it. When that turn ends, the `agent_end` hook captures the final assistant message and opens nothing; once the turn has fully settled, the `agent_settled` hook parses its final non-empty verdict line, persists both on the pending review, and reopens the result gate exactly once. A turn that **failed** — a provider error on the reviewer model, such as a 402 — that was **stopped** before it finished, for example with Escape, or that produced no text records no review at all, even if the reviewer had already written part of one: the failure is reported as `Review turn failed: <reason>` (a stopped or textless turn says so instead), and the result gate reopens still offering the review option so the review can be run again. The notification names that option as the menu does — **Review here**, or **Review again** when an earlier review of the same iteration is still kept. A turn Pi retried successfully is captured as the review it is, because the last attempt is what the settle acts on. The reopen is deliberately split that way: Pi awaits extension `agent_end` handlers before it clears its own `Working` spinner, so a gate opened there would sit under a spinner that cannot clear, next to the run monitor of any worker the gate started. `agent_settled` launches the gate detached and returns immediately, so neither review-turn hook waits on a gate, a worker run, or a leftovers draft. The reopened result gate displays the verdict and findings preview so they are not hidden behind the gate. Dismissing the gate leaves the review pending without rearming it; `/handoff` reopens it on demand.
- **Send feedback to worker** opens an editor prefilled with the captured reviewer response (minus its trailing `Verdict:` line) when one exists; verdict lines tolerate case differences, simple `*`, `_`, or backtick emphasis around the label or value, and an optional final period. The user can edit or replace it. Normalization happens before the emptiness check, so submitting only a verdict line is refused without starting a worker iteration. It appends a `## Review feedback (iteration N)` section with a preamble that names the iteration and original checkpoint, tells the fresh worker that the working tree already contains prior changes, and limits it to the review findings. It then re-runs against the **original checkpoint** from iteration 1, so Discard still undoes every iteration and the diffstat stays cumulative. A latched **Run and review** setting carries onto the restarted run, so a completed feedback iteration starts its review turn automatically; an interrupted one still stops at the result gate. Refused once `iteration >= maxIterations`.

## Safety properties

- A checkpoint is taken before the worker is spawned, never after — including for a worker the user runs in another terminal.
- A worker that dies is never reported as one that finished. An abort, an error stop reason, an error message, or a non-zero exit reaches the result gate as _interrupted_ even when assistant text had already arrived; that text is shown as partial output, never as a report. Equally, a worker that finished is never reported as one that died: an attempt Pi retried successfully does not make the run an interruption.
- A review that never happened is never recorded as one. A review turn that failed, was stopped, or produced no text records no review, says why, and leaves the review option available.
- Answers the user has given are not discarded by a failure. A re-draft that fails keeps the answered questions round, persisted, and offers to retry it.
- Discard reverts only paths that were clean at checkpoint time; paths already dirty at checkpoint are skipped and listed in a notice the user must dismiss, so a worker's edits to pre-existing dirty files survive Discard.
- Discard is blocked if HEAD moved or the repository root changed since the checkpoint.
- Nothing is ever committed, pushed, or opened as a pull request by the extension or, via the prompt, by the worker.
- The worker is killed (SIGTERM, then SIGKILL after a grace period) on Escape during Run and again on `session_shutdown`, so it cannot outlive the reviewing session unnoticed.
- The reviewing session's own model, thinking level, and tools are never changed by a handoff; only the child process runs on the chosen model.
- A follow-up handoff never bypasses a gate: "Accept and hand off leftovers" routes through the same drafting, questions-gate, and launch-gate path as `/handoff`.

## Recovery

Every transition appends a `handoff-state` custom session entry. On `session_start`, the latest valid entry is rehydrated:

- a bare legacy `drafting` state or `proposed` → `idle` (the `/tmp` prompt file may be stale); a `drafting` state with its persisted pending questions-gate draft reopens that gate on `/handoff`. A pending re-draft that previously failed after answers were given instead resumes the re-draft directly with its saved answers, without re-asking. Answered questions-gate scope replaces the drafting state's scope before each re-draft, so a later round and restart retain prior answers, as does the questions round counter. If `/handoff <scope>` or `/handoff --model …` is used while resuming a pending round, the supplied scope or override is ignored with a warning; Cancel and re-run to start fresh with it.
- `running` → an _interrupted_ review, with the note "The worker was interrupted because this Pi session restarted.", keeping the checkpoint so Discard is still available.
- `running` with `external` → unchanged. Its worker is in another terminal that this session's death did not touch, so `/handoff` still offers the review-now path.
- `reviewing` → `reviewing`, with the review-turn flag cleared so a restart cannot resurrect an armed review turn.

`session_shutdown` kills any running child worker and waits for it to exit before Pi tears the session down. An external run has no child, so nothing is killed.

Every field added for crashed workers (`partialReport`, `stderrTail`), external runs (`external`), Run and review (`autoReview`), the questions round (`needsInputRound`), and a saved answered re-draft retry (`answeredRetryPending`) is optional, and both reviewing variants' `usage` is nullable rather than required, so session entries written by earlier versions — including interrupted reviews recorded with `usage: null` — still decode unchanged.

Entries also record why a handoff ended and why a run was interrupted, for anyone reading the session afterwards; recovery ignores both. An `idle` entry carries an optional `reason` — `cancelled`, `draft-failed`, `no-leftovers`, `launch-failed` (Run externally could not take a checkpoint), `discarded`, or `accepted`. An interrupted review carries an optional `interruptionReason` — `user-stopped`, `worker-error`, `error-stop`, `nonzero-exit`, `other-stop`, `no-report`, `session-restarted`, or `external-no-report` — set by the same branch that writes `interruptionNote`. The result gate appends a separate `handoff-event` entry, `{ kind: "result-gate-action", action, iteration }`, when an action is chosen: `review`, `feedback`, `discard`, `accept`, `accept_leftovers`, or `dismiss`. Each comes before the `handoff-state` entry the action leads to. All three are optional, so older sessions still decode.

`autoReview` is persisted as a feedback-loop latch: choosing **Run and review** at the launch gate carries the setting onto every restarted worker run. A child-process run cannot survive a restart, so its active iteration is always rehydrated as interrupted and never auto-reviews itself; the retained latch still applies if the user sends feedback for another iteration.

## Configuration

The rubric is currently the shipped `DEFAULT_RUBRIC` (`src/domain/rubric/defaults.ts`); per-tier default models remain a future `/handoff config` concern, and `~/.pi/agent/handoff.json` and `/handoff config` are not implemented. The drafting model chooses only a tier; resolving a tier to a concrete model is deterministic — the first candidate below that is present in the live model registry and not excluded wins:

| Tier       | Candidates (in order)                                                      |
| ---------- | -------------------------------------------------------------------------- |
| `routine`  | `bifrost-openai/gpt-5.6-luna` (medium), `bifrost/claude-sonnet-5` (medium) |
| `standard` | `bifrost-openai/gpt-5.6-terra` (high), `bifrost/claude-sonnet-5` (high)    |
| `hard`     | `bifrost/claude-opus-5` (high), `bifrost-openai/gpt-5.6-terra` (xhigh)     |
| `frontier` | `bifrost/claude-fable-5-1` (xhigh)                                         |

`maxIterations` is `3`. The no-progress watchdog threshold is `10 minutes` (`DEFAULT_NO_PROGRESS_THRESHOLD_MS` in `src/ports/worker-runner.ts`); it prompts rather than terminating a quiet worker. Excluded models: `bifrost/claude-3-haiku`, `bifrost/claude-opus-4-8`.

If no candidate for a tier is available, the launch gate opens with Run blocked until the user picks a model with **Change model**.

## Terminal fallback

**Run externally** at the launch gate copies the exact worker launch command to the clipboard (falling back to a notification if there is no clipboard):

```text
pi --model "provider/model:thinking" @/tmp/pi-handoff-<slug>.md
```

This preserves the original manual workflow: the `/tmp` prompt file is written before the launch gate opens, so it exists regardless of which option is chosen, and the command can always be run by hand in a separate terminal.

Unlike earlier versions, choosing it does **not** return to idle. It takes the same git checkpoint Run takes and records an external run in progress, so the handoff keeps its safety boundary while the worker runs elsewhere. While that state is active:

- `/handoff status` reports `<slug> running in another terminal` and how to bring the result back.
- `/handoff` offers **I ran it — review now**, **Discard changes**, and **Leave this for later** instead of drafting a new handoff.
- **I ran it — review now** computes the diffstat against the checkpoint exactly as an internal run does, optionally accepts a pasted report (submitting an empty editor is allowed), and opens the normal result gate — including Discard, Accept, Send feedback to worker, and the view options. Usage is absent, because no child process was measured; the gate says so rather than printing zeroes.
- **Send feedback to worker** at that result gate starts an ordinary **internal** child-process iteration against the same checkpoint. Running the first pass by hand does not commit the follow-up passes to the same terminal, and the extension can only measure and abort a worker it spawned itself.
- An empty pasted report reaches the result gate as _interrupted_ rather than as a completed run with an empty report, since the report lives in another terminal's scrollback and its absence is not a result.
- `session_shutdown` does not try to kill anything: no child process was ever created for an external run.

An external run is also the one state that survives a Pi restart as itself. A child-process run is downgraded to an interrupted review because the child cannot outlive its parent, but an external worker is unaffected by this session dying, so the run — and its review-now path — is kept intact.

## Package layout and layering

```text
index.ts                composition root: adapters, services, command, hooks
src/domain/             pure, no IO, no Pi imports; `vocabulary.ts` spells the `CONTEXT.md` terms that more than one surface must agree on
src/ports/              interfaces for everything outside the process
src/adapters/           child-process runner, exec-based git, pbcopy, filesystem
src/persistence/        schemas for session entries and draft JSON
src/app/                HandoffMachine, DraftService, RunService, ReviewService
src/presentation/       launch, result, and questions gates; run monitor; model picker; read-only text viewer
src/prompts/            drafting and review prompt text
src/commands/           /handoff argument parsing and dispatch
test/domain/            rubric, draft parsing, leftovers scope, feedback append, porcelain status parsing
test/commands/          drafting loop, the result gate loop, questions gate, review turn (scripted UI)
test/extension/         entry point loads and registers the expected surface
```

[`CONTEXT.md`](CONTEXT.md) is the glossary: the three gates are named by the decision each guards — the **questions gate**, the **launch gate**, and the **result gate** — and every other user-facing term (run monitor, interrupted, partial output, feedback, …) has one spelling, defined there; the terms more than one surface must agree on — gate names and titles, the run monitor title, the partial-output heading, the review option label — are spelled once in `src/domain/vocabulary.ts`.

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
