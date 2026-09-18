# Pi Handoff

## 1. Context

A common workflow in Pi is: converge on a recommendation in one session, then hand the implementation to a fresh session so the first session's context stays clean and can act as the reviewer. Today this is done with the `~/.pi/agent/prompts/handoff.md` template: the reviewing agent writes a self-contained prompt to `/tmp`, recommends a model and thinking level from a tier rubric, and prints a `pi --model "provider/id:level" @/tmp/pi-handoff-<slug>.md` command. The user copies that into another terminal, waits, then pastes the implementer's final report back for review.

Extension commands shadow prompt templates of the same name, so `~/.pi/agent/prompts/handoff.md` is unreachable as `/handoff` while this extension is installed.

The manual steps are: copying the command, watching a second terminal, pasting results back, and re-establishing the diff in the reviewing session. `pi-phase-runner` solves a neighbouring problem (plan on model A, implement on model B) but does so by replacing the current session with `ctx.newSession()`, so the planning context is gone by the time implementation finishes and there is no review leg.

Pi provides the building blocks for a review-preserving version: `ctx.modelRegistry.getAvailable()` and `ctx.modelRegistry.complete()` for side-calls, `ctx.ui.select/confirm/editor/custom` for gates, `ctx.ui.setWidget` for status, `pi.sendUserMessage` to inject text into the live session, and the `examples/extensions/subagent` pattern of spawning `pi --mode json -p --no-session` as a child process and streaming its JSON events.

A 2026-09-18 incident exposed an acceptance-loop hole: two consecutive “Accept and hand off leftovers” actions drafted and ran no-op follow-ups because prose from accepting reviews was treated as work. The review contract now mirrors its structured `Verdict:` line with a required `Leftovers:` block, and the leftovers drafter has an explicit no-work exit instead of manufacturing a minimal runnable prompt.

## 2. Goals

- Keep the current session alive as the reviewing session for the whole handoff.
- Generate the handoff prompt from verified session context, not by hand.
- Recommend a model and thinking level from an explicit, data-driven tier rubric, validated against the live model registry.
- Run the implementer as an isolated child `pi` process so its tool noise never enters the reviewing context.
- Put a human gate at each point where judgment matters: before the worker starts, and before its changes are accepted.
- Bring the worker's final report and a change summary back into the reviewing session automatically.
- Support a bounded fix loop: send review feedback back to the worker without re-drafting the handoff.
- Preserve the terminal fallback: the user can always take the generated command and run it themselves.
- Reuse Phase Runner's layering (pure domain, ports, adapters, thin composition root) and its test harness approach.

## 3. Non-goals

- Do not replace `pi-phase-runner`. Design documents, task state machines, and `phase_task` gating are out of scope.
- Do not run multiple workers in parallel in v1.
- Do not run the worker in a separate git worktree in v1. The worker edits the shared working tree; a checkpoint protects against a bad run.
- Do not make the worker run non-blocking in v1. The reviewing session waits at a gate while the worker runs, matching how the workflow is used today.
- Do not implement an automatic worker-to-reviewer convergence loop without a gate between iterations.
- Do not persist handoff artifacts into the target repository.

## 4. Proposed Design

Create a Pi package named `pi-handoff` with a single extension entry point at `index.ts`.

The extension registers:

- `/handoff [--model provider/model-id[:thinking]] [scope]` as the user-facing command. Runs the full drafting, gate, run, and review flow; a leading `--model` selects an available worker model before drafting.
- `/handoff status` to show the current handoff state and the last worker report.
- `/handoff abort` to kill a running worker and return to idle. Superseded by Escape in the running overlay: the run blocks the session behind that overlay, so this command cannot be typed while a worker is alive and is left unimplemented.
- `/handoff config` to edit the tier rubric's model mapping.

The extension uses these lifecycle hooks:

- `session_start` rehydrates handoff state from a custom session entry so a resumed reviewing session knows a handoff is in flight or awaiting review.
- `session_shutdown` kills any running child worker process. A drafting state stores an optional `{ draft, promptPath }` pending NEEDS INPUT round; the field is optional so old session entries still decode, and only that retained drafting state is resumed into its gate. Each re-draft replaces the drafting state's scope, preserving accumulated `Q:`/`A:` answers for later rounds and restart. A new scope argument supplied while resuming a pending round is ignored with a warning; Cancel followed by a fresh command is required to use it. An external run has no child process, so the hook finds nothing to abort and returns immediately.
- `agent_end` reopens Gate B after the review turn that **Review here** or **Run and review** injected. It is inert in every other state; it never opens UI or changes state unless the machine is in `reviewing` with `awaitingReviewTurn` set.

### Flow

```
/handoff [--model provider/model-id[:thinking]] [scope]
  │
  ├─ 1. DRAFT   side-call on the current model:
  │              session transcript + scope → { prompt, tier, rationale, bluf?, definitionOfDone?, questions? }
  │              rubric maps tier → candidate models; first available wins unless --model overrides it
  │              NEEDS INPUT rounds are counted; from round 3 the gate offers
  │              "Proceed with recommended answers"
  │
  ├─ GATE A     goal + definition of done + height-budgeted prompt preview + model + rationale
  │              [Run] [Run and review] [View full prompt] [Edit prompt]
  │              [Change model] [Run externally] [Cancel]
  │
  ├─ 2. RUN     git checkpoint (stash-free: record HEAD + `git status --porcelain`)
  │              spawn: pi --mode json -p --no-session --model P/M --thinking L @prompt
  │              stream events into a widget; Escape kills the child
  │              (Run externally checkpoints too, and records an external run)
  │
  ├─ GATE B     worker's final report + `git diff --stat` + usage/cost
  │              [Review here] [Send feedback to worker] [Discard changes] [Accept]
  │              [View full report] [View full diffstat] [Accept and hand off leftovers]
  │
  ├─ 3. REVIEW  "Review here" injects report + diffstat into the reviewing
  │              session via sendUserMessage with review instructions;
  │              when that turn ends, agent_end reopens Gate B automatically.
  │              "Run and review" injects the same message without the click.
  │
  └─ 4. LOOP    "Send feedback" reopens the editor, appends feedback to the
                 prompt as a follow-up section, and returns to RUN (max N iterations)
```

### State machine

Handoff state is a discriminated union owned by one `HandoffMachine`, following Phase Runner's `PhaseMachine`:

```
idle
drafting   { scope, pendingDraft?, needsInputRound? }
proposed   { draft, choice }
running    { draft, choice, iteration, startedAt, checkpoint, external?, autoReview? }
reviewing  { draft, choice, iteration, checkpoint, report, diffstat, usage, review?, awaitingReviewTurn,
             partialReport?, stderrTail?, external?, autoReview? }
```

`awaitingReviewTurn` is true only between **Review here** and the end of the turn it triggered. It is the sole condition under which `agent_end` acts. `review` is optional for compatibility with older session entries and contains `{ iteration, verdict?, text }` after an armed review turn ends; `verdict` is absent when the final non-empty line is not a recognized `Verdict: accept|fix|discard` line. The line parser tolerates case differences, simple `*`, `_`, or backtick emphasis around the label or value, and an optional trailing period, but rejects extra words.

Every field marked optional above was added after the first release and is optional for the same reason: a session entry written by an earlier version must still decode. `needsInputRound` counts NEEDS INPUT rounds so the gate can offer to end a non-convergent sequence; `external` marks a run the user launched in another terminal; `autoReview` records that Gate A's **Run and review** was chosen and latches it across feedback iterations; `partialReport` and `stderrTail` retain a crashed worker's evidence. A completed review's `usage` is additionally _nullable_, because an external run has no child process to measure and zeroed usage would claim the work was free.

An external run is modelled as a discriminator on `running` rather than a fourth state kind. Everything that makes `running` what it is — a draft, a chosen model, an iteration, and above all a checkpoint that Discard can return to — is equally true of an external run, so a separate kind would restate all of it and double every transition that reads a checkpoint. What actually differs is only that no child process exists, which matters in exactly two places: `session_shutdown` has nothing to kill, and rehydration must _not_ downgrade the run, because the terminal running it is unaffected by this session's death.

Only one handoff can exist per session. Starting `/handoff` while `running` is refused; starting it while `reviewing` reopens Gate B rather than drafting, since Gate B already offers Discard and Accept.

## 5. Detailed Design

### 5.1 Drafting

The draft step serializes the current session branch (`convertToLlm` + `serializeConversation`, as `examples/extensions/handoff.ts` does) and calls `ctx.modelRegistry.complete(ctx.model, …)` with a drafting system prompt. The prompt body is the current `handoff.md` template's requirements. The response must be a fenced JSON object:

```json
{
	"slug": "add-retry-logic",
	"prompt": "…self-contained implementation prompt…",
	"tier": "standard",
	"rationale": "Multi-file but fully specified; validation is a single test command.",
	"bluf": "Add retry logic so transient client failures recover automatically.",
	"definitionOfDone": ["Retries cover the configured transient failures", "Focused tests pass"]
}
```

Parsing is strict for the prompt, tier, and rationale (`persistence/schemas.ts`). The optional `bluf` is the goal, one tweet-sized sentence (at most 140 characters) on one line phrased as the outcome rather than as what an agent will do, and is rendered under a **Goal** label; optional `definitionOfDone` carries at most five short checkable conditions; malformed display metadata is trimmed or dropped without rejecting an otherwise usable envelope. The envelope optionally carries up to three structured `questions`, each with a required `question`, optional one-line `context`, optional finite `choices`, and optional 0-based `recommended` choice. A recommendation that does not select a listed choice is normalized away rather than rejecting the otherwise usable draft. If the response does not parse, the user is shown the raw text and offered retry or cancel. A non-empty structured question array opens the NEEDS INPUT gate described in §7 instead of Gate A. A standalone prose `NEEDS INPUT` line, normally a `## NEEDS INPUT` heading with questions beneath it, remains a fallback for a model that ignores the envelope contract; mentions in prose or a title do not count. The gate asks each question independently with a select (and Other escape) or text input, renders deterministic `Q:`/`A:` pairs into the re-draft scope, and includes a read-only View draft option. The prompt is always written to `/tmp/pi-handoff-<slug>.md` before Gate A so the external fallback and manual inspection are available regardless of what happens next. The cancellable drafting loader keeps the existing action text visible alongside live elapsed time and the reviewing-session `provider/model` that performs the side-call; the same loader covers ordinary drafts, NEEDS INPUT re-drafts, and leftovers drafts.

A leftovers-only call can instead return `{ "noLeftovers": true, "rationale": "…" }`; it is invalid for ordinary drafting and returns the machine to idle without a prompt file or Gate A.

Iteration numbering belongs to the extension, and the drafting prompt says so explicitly: neither the `slug` nor the prompt's top heading may encode an iteration, round, attempt, or pass number. The transcript handed to the drafting call may already contain earlier handoffs and their review rounds, so a model reading it keeps counting — producing a slug of `tg-feedback-command-iteration-1` for what ran as iteration 2, and a draft titled "… fix review nits (iteration 3)" for a brand-new handoff at iteration 1. The prompt instruction is the fix; `slugify` additionally strips a trailing `-iteration-N`-style counter, because a wrong number on the prompt filename is worse than none when the filename is what a reviewer greps for. That defensive strip recognizes only `iteration`, `iter`, `round`, and `attempt`, the words that can only mean a counter: `v` and `pass` were tried and removed, because they mangle real task names — turning `upgrade-next-v16` into `upgrade-next` and `first-pass-3` into `first` — and silently deleting the version that identifies the work is a worse failure than leaving a stray counter the prompt rule already prevents.

NEEDS INPUT rounds are counted in the drafting state (`needsInputRound`, optional). From the third round the gate adds **Proceed with recommended answers**, which folds each question's `recommended` choice in as its answer and answers the rest with "Use your best judgement; do not ask again", then re-enters drafting exactly as Answer does; the existing rule that answered `Q:`/`A:` pairs are decided is what stops those questions coming back. It is withheld for the first two rounds because it is a blunt instrument — it answers every open question at once, including those the model declined to rank. Two rounds is a model converging; the case that motivated this took four rounds and thirty-five minutes to reach Gate A, one round of it taking twenty-two minutes.

### 5.2 Rubric

The rubric is data, stored globally at `~/.pi/agent/handoff.json` (a future concern: the current extension still leaves `/handoff config` unimplemented, so per-tier defaults are not configurable yet):

```json
{
	"tiers": {
		"routine": [
			{ "model": "bifrost-openai/gpt-5.6-luna", "thinking": "medium" },
			{ "model": "bifrost/claude-sonnet-5", "thinking": "medium" }
		],
		"standard": [
			{ "model": "bifrost-openai/gpt-5.6-terra", "thinking": "high" },
			{ "model": "bifrost/claude-sonnet-5", "thinking": "high" }
		],
		"hard": [
			{ "model": "bifrost/claude-opus-5", "thinking": "high" },
			{ "model": "bifrost-openai/gpt-5.6-terra", "thinking": "xhigh" }
		],
		"frontier": [{ "model": "bifrost/claude-fable-5-1", "thinking": "xhigh" }]
	},
	"maxIterations": 3,
	"excludeModels": ["bifrost/claude-3-haiku", "bifrost/claude-opus-4-8"]
}
```

The drafting model chooses only the tier and explains why. Resolving tier → concrete model is deterministic: the first candidate present in `ctx.modelRegistry.getAvailable()` (and not excluded) wins. If none is available, Gate A shows the tier with no model and requires the user to pick one. The tier axes (specification clarity, scope and coupling, reasoning depth, verification cost) live in the drafting prompt, not in config, because they are instructions to a model rather than a mapping.

Defaults ship in `src/domain/rubric/defaults.ts` and are written to `handoff.json` on first use. `/handoff config` opens the file in `ctx.ui.editor` and re-validates on save.

### 5.3 Gate A

Rendered with `ctx.ui.custom` so the goal, definition of done, prompt preview, model line, and rationale are visible together. The goal and definition block sit above a height-budgeted preview: it grows to the historical twelve prompt-line cap, but at constrained heights it uses a three-rendered-row floor that includes the `… N more lines` signpost. A common Gate A fits at about 30 rows; the largest metadata shape cannot fit in 24 rows without removing non-preview content, which remains a separate design decision. Older drafts without metadata show unobtrusive fallbacks. A leftovers draft is labelled with the accepted slug and keeps its rationale above the metadata; without a definition of done, Cancel moves ahead of Run. The model line names the **Change model** option and marks a `--model` choice. Options:

- **Run** — proceed to 5.4.
- **Run and review** — identical to Run, and on a _completed_ outcome it injects the review turn that **Review here** would have, reusing the same arming and message construction rather than duplicating it. An interrupted outcome opens Gate B instead, because there is no report to review and a crash is something the user should see before spending reviewing context on it. The intent is recorded as `autoReview` on the run state as a feedback-loop latch: every later completed iteration started by **Send review to worker** injects its review turn too, without first reopening Gate B. A child-process run cannot outlive its parent, so its active iteration rehydrates as interrupted and never auto-reviews itself; an interrupted iteration still opens Gate B, while the retained latch applies to a later feedback retry. It exists as a separate option rather than a default or a config flag: in the observed sessions every completed run ended with the user choosing Review here, three to six minutes after the worker finished, while plain Run remains the right choice when the user wants to read the diffstat before committing reviewing context.
- **View full prompt** — opens the whole prompt in the read-only scrollable viewer (§5.8) and returns to the gate. The gate's own preview is capped at twelve prompt lines when room permits and shrinks with the available height because a gate that renders a 165-line prompt pushes its own options off the screen; the previous behaviour left users approving, or sitting for up to twenty-eight minutes over, text they could only see the head of.
- **Edit prompt** — `ctx.ui.editor` prefilled with the prompt; rewrites the `/tmp` file.
- **Change model** — Phase Runner's `pickModel` pattern: select from the live registry, then a thinking level. The tier is kept for the record; the choice overrides it.
- **Run externally** — copies `pi --model "P/M:L" @/tmp/pi-handoff-<slug>.md` to the clipboard via `pbcopy` (falls back to `ctx.ui.notify` with the command), then **takes the same checkpoint Run takes** and records a `running` state marked `external`. It no longer returns to `idle`: doing so meant the extension forgot the handoff, so the user's own worker edited the tree with no checkpoint, and its result came back as a pasted message with no diffstat and no Discard. See §5.9.
- **Cancel** — returns to `idle`; the `/tmp` file is left in place.

### 5.4 Run

Before spawning, the extension records a checkpoint: `git rev-parse HEAD` and `git status --porcelain`. This is the minimum needed for Gate B's **Discard** to be safe: files that were already dirty before the run are never touched by Discard.

The worker is spawned as:

```
pi --mode json -p --no-session --model <provider>/<model> --thinking <level> @/tmp/pi-handoff-<slug>.md
```

in `ctx.cwd`, with the same event handling as `examples/extensions/subagent/index.ts`: `message_end` accumulates assistant messages and usage; `tool_result_end` accumulates tool results; `stopReason` and `errorMessage` are captured; SIGTERM then SIGKILL on abort. The extension does not pass `--tools`; the worker gets the normal default tool set. It also does not pass `--append-system-prompt`; all instructions live in the prompt file so what the user approved at Gate A is exactly what the worker receives.

While running, a widget keeps the goal line and a width-truncated, bounded definition-of-done header above elapsed time, turns, tokens, cost, and the last few tool calls. The declared 24-row terminal minimum applies to this widget and the read-only viewer: the widget shows two completion bullets there and up to all five on taller terminals, while reserving room for metrics, recent activity, and the abort hint. Gate A and Gate B use the same terminal-row source for their separate preview budgets, but their larger fixed summaries need roughly 30 and 40 rows respectively for the common states. The reviewing session's agent is not invoked during this phase; the command handler awaits the child process directly, so the user sees the widget and can press Escape in it to stop the worker. The overlay owns the `AbortController` for the run because there is no external signal to borrow: `ExtensionCommandContext` has no abort member, and `ExtensionContext.signal` is undefined when the agent is not streaming, which is exactly the case while a command handler awaits a child process.

The worker's final assistant text is the report _only when the worker ended cleanly_. Its expected shape is the "final report" section the drafting prompt requires: summary, files changed, validation performed, blockers. The extension does not parse this structurally in v1; it is passed through verbatim.

Classification is owned by one exported function, `classifyOutcome`, so each rule is unit-testable without a child process. A run is interrupted when it was aborted, when its final assistant message carried an error stop reason or an error message, when the process exited non-zero, or when no text arrived at all — **and the first three of those hold even when earlier assistant text exists**. The reason is that the adapter's report is "the last assistant text seen", not "the worker's conclusion": a 2h19m, 203-turn, $45.79 run whose final message was an error reached Gate B as a _completed_ handoff whose entire report was a mid-task sentence about terminal width, presented next to a 2,816-line diff with no indication the worker had died. The pre-crash text is retained as `partialReport`, and a bounded tail of stderr as `stderrTail`, because the user watched that text stream into the widget and silently dropping it would read as the extension having lost the report; both are rendered under headings that deny them the status of a report.

### 5.5 Gate B

Rendered with `ctx.ui.custom`, showing the report, `git diff --stat` against the checkpoint, usage, and iteration count. Its report, diffstat, review, and crash-tail previews share the rows left after fixed metadata, menu, and chrome: each keeps a three-rendered-row floor and signpost, with worker report first, then reviewer findings, diffstat, and crash tails. A common completed Gate B fits at about 40 rows; the 24-row minimum cannot fit its largest states without giving up non-preview content. Options:

- **Review here** — sets `awaitingReviewTurn`, then `pi.sendUserMessage` with: the original handoff prompt (collapsed reference), the worker's report, the diffstat, and instructions to review the actual diff with the read/bash tools against the handoff's acceptance criteria. Immediately before the final `Verdict: accept|fix|discard` line, the reviewer must write either `Leftovers: none` or a `Leftovers:` block of concrete worker-item bullets; no-action-needed findings, praise, notes to the human, and accepted work are excluded. The injected message triggers a full agent turn, so the handler must fire it without awaiting completion and return immediately; a handler that waited would hold the command open for the entire review turn and deadlock the gate it is trying to reopen. The message is delivered as a follow-up (`deliverAs: "followUp"`) because Gate B may itself be open inside `agent_end`, where the agent is still streaming and an un-queued user message is refused; when the agent is idle the option has no effect. When that turn ends, `agent_end` reads the final assistant message exposed by the event, parses its final non-empty `Verdict:` line using the tolerated forms above, clears the flag, persists `{ iteration, verdict?, text }`, and reopens Gate B. The overlay itself displays the captured verdict and a bounded findings preview, because it obscures the transcript rather than leaving the verdict visible above it. When a review exists for the current iteration, Gate B relabels **Review here** to **Review again** and **Send feedback to worker** to **Send review to worker**; a `fix` verdict puts Send review first and an `accept` verdict puts Accept first, while `discard` leaves Discard in its normal position and relabels it to explain the recommendation. If the user dismisses the gate (Escape) to ask the reviewer a follow-up question, the machine stays in `reviewing` with the flag cleared; subsequent turns do not reopen the gate, and `/handoff` reopens it on demand.
- **Send feedback to worker** — `ctx.ui.editor` is blank before a review and prefilled with the captured reviewer text after one, with a trailing `Verdict:` line removed using the same tolerated forms described above. The user still confirms the text by editing or submitting it. Normalization happens before the emptiness check, so a verdict-only submission is refused without starting a worker iteration. The extension normalizes that feedback the same way before appending a `## Review feedback (iteration N)` section to the prompt file: a generated preamble names the iteration and seven-character original checkpoint, says the working tree already has prior iteration changes that must not be restarted or reverted unless requested, and instructs the worker to address only the reviewer findings. It then returns to 5.4. Refused when `iteration >= maxIterations`. The restart reuses the checkpoint taken before iteration 1 rather than taking a new one, so Discard still undoes every iteration and the diffstat stays cumulative across the loop. It drops `external`, but carries a true `autoReview` latch; a completed retry therefore starts the review turn immediately, while an interrupted retry renders Gate B as usual.
- **Discard changes** — `git checkout -- <files changed since checkpoint>` and `git clean` limited to files that were untracked-and-absent at checkpoint. Then `idle`. Paths that were already dirty when the checkpoint was taken are skipped, so a worker's edits to those paths survive Discard; this is why Gate B leads its discard summary with the skipped paths rather than reporting only what was reverted.
- **Accept** — marks the handoff complete, leaves the working tree as is, records the report in the session as a custom entry, and returns to `idle`. Nothing is committed.
- **Accept and hand off leftovers** — offered only when the captured verdict is `accept` and parsed `Leftovers:` are items or missing. `Leftovers: none` omits it, while a missing block preserves a compatibility fallback for older captured reviews. It sits after the full report/diffstat viewers and before dismissal. Performs the ordinary Accept, then enters `drafting` with a scope built by a pure domain function from **the accepted prompt and only the structured item list**; the missing-block fallback passes the full review with an explicit warning that no structured list was found. No transcript is re-serialized: both documents that define the leftovers are already in hand, the accepted work has just superseded the history, and a drafting model given the transcript tends to re-propose work the review accepted. A leftovers drafter that finds no fresh work must return its `noLeftovers` envelope, which abandons the drafting state and never opens Gate A. Otherwise the result goes through `DraftService` into the ordinary NEEDS INPUT and Gate A flow, so a follow-up can never be launched with less approval than any other handoff. This exists because the pattern was already happening by hand: after an `accept` with minor items listed, the user repeatedly started a fresh `/handoff` ("fix the nits", "the remaining weaknesses", "fold the four deferred nits in"), paying a full drafting cycle over the whole transcript each time.

  The transcript-free guarantee is a property of the **whole drafting loop**, not of its first pass. `DraftService.draftLeftovers` therefore takes an already-built scope rather than the two raw documents, because it is called again for every retry after an unparseable envelope and every re-draft after an answered NEEDS INPUT round, and the command layer seeds its scope with the leftovers text before the first call and appends answers onto it. An earlier version built the scope inside the service and let those continuation paths fall back to `draft`, which re-serialized the conversation _and_ replaced the machine's scope with one the accepted prompt and review text had dropped out of — so the promise held only when the first leftovers draft happened to parse and ask nothing. Both the service and the command loop are tested for zero transcript reads across a retry and an answered round.

- **View full report** / **View full diffstat** — open the whole report (or a crashed worker's pre-crash text) and the whole diffstat in the read-only viewer of §5.8, then re-render Gate B unchanged. The diffstat view also carries the stderr tail when a crash left one, since an interrupted run has no report view worth opening for stderr alone.

### 5.6 Session entries and recovery

Each transition appends a `handoff-state` custom entry (`pi.appendEntry(customType, data?)`, which returns `void`) containing the serialized machine state minus the child process handle. Writing entries is an `ExtensionAPI` capability rather than a session-manager call, because `ctx.sessionManager` is a read-only `ReadonlySessionManager` with no append method. On `session_start`, the latest entry is decoded; `running` is downgraded to `reviewing` with a note that the worker was interrupted (the child cannot survive a Pi restart), and `/handoff` reopens the appropriate gate. A bare legacy `drafting` state and `proposed` are downgraded to `idle` because the `/tmp` prompt file may be stale; `drafting` with an optional persisted pending NEEDS INPUT envelope is retained so `/handoff` can reopen that gate.

### 5.7 Package layout

```
index.ts                composition root: adapters, services, command, hooks
src/domain/             pure, no IO, no Pi imports
  types.ts              HandoffState, Draft, ModelChoice, Report, Checkpoint
  result.ts             Result type (copied from phase-runner)
  rubric/               tier resolution, defaults, validation
  draft/                draft JSON parsing, slug normalization, feedback append, leftovers scope
  report/               usage formatting, discard summaries (the report itself is passed through verbatim, never parsed)
src/ports/              WorkerRunner, Git, Clipboard, ConfigStore, Clock
src/adapters/           child-process runner, exec-based git, pbcopy, json file
src/persistence/        schemas for handoff.json, session entries, draft JSON
src/app/                HandoffMachine, DraftService, RunService, ReviewService
src/presentation/       gate-a.ts, gate-b.ts, widget.ts, model-picker.ts, text-viewer.ts
src/prompts/            drafting system prompt, review injection prompt
src/commands/           /handoff argument parsing and dispatch
test/domain/            rubric, draft parsing, leftovers scope, feedback append, diffstat
test/extension/         entry point loads and registers the expected surface
```

Layering rules match Phase Runner: `domain <- app <- adapters <- index.ts`; only `index.ts` constructs adapters.

One cycle is resolved explicitly in the composition root: Gate B's leftovers option starts a draft, while the drafting flow ends at a run whose result Gate B renders. The command object is built after the Gate B flow and injected into it through a late-bound callback, rather than duplicating the drafting flow inside Gate B.

### 5.8 Read-only scrollable viewer

Every gate shows a bounded preview — up to twelve prompt lines at Gate A, and up to twenty-four report lines and twelve diffstat lines at Gate B — because the gates do not scroll. Gate A and Gate B pass `tui.terminal.rows` into their pure formatters and shrink their previews to a three-rendered-row floor, preserving the heading and `… N more lines` signpost so the full viewer remains discoverable. The 24-row terminal minimum is for the running widget and viewer; common Gate A and completed Gate B states need roughly 30 and 40 rows respectively, while their largest states still need more room unless non-preview content changes. Observed prompts ran to 165 lines, reports to roughly 10k characters, and diffstats to 21 files, so the previews routinely hid most of what the user was deciding about. The remedy is a separate surface rather than larger previews, since a gate that fills the screen hides its own options.

`src/presentation/text-viewer.ts` splits the same way as the gates: `windowLines` is pure and owns the scrolling arithmetic, clamping, and the position line, so paging and end-of-content behaviour are unit-tested without a TUI; the component around it renders a window and translates keys. It is genuinely read-only, replacing the previous stand-in of an editor titled "read-only; edits are discarded" — a surface that invited typing into a buffer whose changes were thrown away. Gate A's View full prompt, Gate B's two view options, and the NEEDS INPUT gate's View draft all use it.

Two mechanics are load-bearing rather than incidental. The window is measured in **rendered rows, not source lines**, and the measurement happens inside `render(width)` where the real width is known: the content this viewer exists for is prompts written as unwrapped paragraphs and report bullets, which occupy three or four rows each, so a window of twenty source lines painted forty-six rows into a twenty-row viewport and pushed the heading and the top of the window off the screen. `windowLines` therefore takes an optional per-line height function — defaulting to one row, which keeps plain line windowing as the degenerate case — and anchors its final window by walking heights backwards from the end, since with variable heights the last window's line count is not fixed. The position line stays numbered in source lines, because those are what the text's own numbering means to a reader.

Paging follows from that measurement, and getting it wrong is a second, quieter way to hide content. Rows and source lines are not interchangeable in either direction, so a page computed as a row count and applied as a line offset skipped whatever lay between two screens: at width 80 the first window showed lines 1–5 and one page down jumped to lines 21–25, losing fifteen lines with no indication they had been passed. `windowLines` therefore returns the paging destinations alongside the window — `nextOffset`, the first line past the window it just built, and `previousOffset`, found by filling a viewport backwards from the window's top with the same walk that anchors the final window — and the component navigates by the window it last rendered rather than by arithmetic of its own. Paging up and down over the same boundary is therefore symmetric, and both directions always move by at least one line, so a paragraph taller than the viewport cannot trap the scroll.

Keys are matched with pi-tui's `matchesKey` rather than by comparing raw bytes. Under the Kitty keyboard protocol — Ghostty, WezTerm, Kitty — plain Escape arrives as `\x1b[27u`, so a byte comparison against `\x1b` silently never fires while the footer still advertises `esc close`. Matching parsed keys also removes an ordering hazard the byte version had to work around: Escape is a prefix of every arrow and page sequence, so the close test had to run last to avoid closing the viewer on every scroll key.

### 5.9 External runs

An external run is a `running` state marked `external`, taken with the same checkpoint an internal run takes and holding no child process. `/handoff status` reports it as awaiting the user rather than as work in progress here, and `/handoff` offers a small gate instead of drafting: **I ran it — review now**, **Discard changes**, and **Leave this for later**.

Review now reads the diffstat against the checkpoint exactly as `spawnAndSettle` does, optionally accepts a pasted report, and transitions to `reviewing`, so the whole of Gate B applies unchanged. Two details follow from having no child process. `usage` is null rather than zeroed, because zeroes would report a real run as having cost nothing; the completed reviewing state's `usage` is therefore nullable and Gate B renders the absence as a sentence naming the other terminal. And an empty pasted report reaches Gate B as _interrupted_ rather than as a completed run with an empty report: the report lives in another terminal's scrollback, requiring it would block review on a copy the user may not have kept, and Gate B's completed branch promises a report that an empty string would misrepresent.

**Send feedback to worker** from that Gate B starts an ordinary internal child-process iteration: `restartRun` does not carry `external` forward. Running the first pass by hand does not commit the follow-up passes to the same terminal, and an internal worker is the only kind the extension can measure, stream, and abort. The checkpoint is unchanged, so Discard still spans the manual pass and every iteration after it.

Rehydration keeps an external run intact, which is the single exception to downgrading `running`. A child cannot outlive its parent, so a child-process run comes back as an interrupted review; an external worker is unaffected by this session dying, so downgrading it would discard a run that may still be in flight and lose its review-now path.

## 6. Rejected Alternatives

- Extend the prompt template further: rejected because the template cannot validate its model pick, cannot spawn or observe a worker, and cannot bring results back without a manual paste.
- Add a handoff mode to `pi-phase-runner`: rejected because Phase Runner's invariant is "planning and implementing are mutually exclusive in this session" via `ctx.newSession`, while handoff's invariant is "implementation happens in a child process while this session waits to review." Bolting a subprocess runner onto `PhaseMachine` would fork its state model. Shared pieces (`model-picker`, `environment`) can be extracted later once both shapes are stable.
- Use `ctx.newSession` and switch back with `ctx.switchSession` after implementation: rejected because it serializes the two sessions in one TUI and loses the live review context; the child-process model keeps the reviewing session intact.
- Run the worker in a git worktree: deferred. It gives true isolation but complicates untracked files, `node_modules`, and generated artifacts. The checkpoint plus Discard covers the v1 failure mode.
- Non-blocking worker with a background widget: deferred. The current workflow already waits; blocking keeps the state machine and abort handling simple.
- Structured parsing of the worker report: deferred. The report is prose for a human reviewer; parsing adds a failure mode with little v1 benefit.
- Make "Run and review" the behaviour of Run, or a configurable default: rejected in favour of a separate option. Automatic review was right in every observed completed run, but plain Run is still the honest choice when the user wants to see the diffstat before spending reviewing context, and a config default would decide that for them invisibly.
- Build the leftovers follow-up from the session transcript, like an ordinary draft: rejected. The accepted prompt and the review text already define the leftovers, re-serializing a long reviewing session spends the drafting call's context on history the accepted work just superseded, and a model given the transcript tends to re-propose work the review accepted.
- Model an external run as a fourth state kind: rejected in favour of a discriminator on `running`. A separate kind would restate the draft, model, iteration, and checkpoint that `running` already carries, and double every transition that reads a checkpoint, to express one difference: that no child process exists.
- Enlarge the gates' previews instead of adding a viewer: rejected. A gate that renders a 165-line prompt or a 10k-character report pushes its own options off the screen; the previews identify what is being decided, and a separate scrollable surface shows all of it.
- Keep using `ctx.ui.editor` as the read-only viewer: rejected. It invites the user to type into a buffer whose changes are discarded, which is a surface that lies about what it does.
- Let the drafting model pick a concrete model ID: rejected because it can hallucinate IDs or pick unavailable ones. It picks a tier; resolution to a model is deterministic and registry-validated.
- Require `/handoff` to reopen Gate B after the review turn instead of hooking `agent_end`: rejected in favour of the automatic reopen because the extra command is friction on every handoff, while the hook's misfire risk is contained by a single flag that is cleared on first use. If the review turn ends early (permission prompt, token limit), the user dismisses the gate and continues; `/handoff` remains available to reopen it.

## 7. Correctness Hazards / Non-negotiables

- The reviewing session's model, thinking level, and tools must never be changed by a handoff. Only the child process runs on the chosen model.
- The worker must receive exactly the prompt approved at Gate A. No hidden system prompt additions.
- The chosen model must exist in `ctx.modelRegistry.getAvailable()` at spawn time; otherwise Gate A must block Run.
- Discard must only touch files changed since the checkpoint. Files dirty before the run are out of bounds.
- A worker that died must never reach Gate B as one that finished. An abort, an error stop reason, an error message, or a non-zero exit is an interruption even when assistant text already arrived; that text may be shown only as pre-crash output, never as the report.
- An external run must take a checkpoint before the command is handed to the user, for the same reason a spawned run does: without it, Discard has no boundary and the run's changes are unrecoverable.
- `session_shutdown` and command abort must kill the child (SIGTERM, then SIGKILL after a grace period). A worker must never outlive the reviewing session unnoticed. An external run has no child and must not be treated as though it does.
- The fix loop must be bounded by `maxIterations` and must require a gate between iterations.
- `agent_end` must be a no-op unless the machine is in `reviewing` with `awaitingReviewTurn` set. It must clear the flag before opening Gate B so a second `agent_end` (for example after an auto-retry or queued follow-up) cannot open a second gate. It must never fire UI in a session where no handoff is active.
- The `/tmp` prompt file must be written before Gate A so the external fallback works even if the extension fails afterwards.
- Iteration and round numbering belongs to the extension. A drafting model must not encode one in a slug or a prompt heading, because the transcript it reads makes any number it infers unreliable.
- Exactly one `idle` session entry per abandoned handoff. Cancellation is racy — the drafting loader resolves at the keypress while the side-call it abandoned settles separately — so `DraftService.abandon` is idempotent rather than trusting its callers to coordinate.
- A follow-up handoff must pass through Gate A. "Accept and hand off leftovers" routes through `DraftService` and the ordinary NEEDS INPUT and Gate A flow; there is no second, less-guarded path to a worker.
- Nothing is committed, pushed, or PR'd by the extension or, via the prompt, by the worker.
- The drafting step must never fabricate context: the drafting prompt carries the instruction to ask rather than invent, and a draft with a non-empty structured `questions` array is shown to the user instead of Gate A. A standalone prose `## NEEDS INPUT` heading remains a fallback when a model ignores that contract; mentions in prose or a title are not markers. The gate renders numbered questions, context, finite choices, and recommendations, asks one answer at a time, and appends deterministic `Q:`/`A:` pairs under `Answers to the previous draft's NEEDS INPUT questions`; it also offers edit, a read-only full-draft view, and cancel. The pending envelope is retained in optional drafting state so `/handoff` can reopen it after a restart, while older bare drafting entries continue to downgrade to idle.
- Session-entry rehydration must tolerate a missing or stale `/tmp` file.

## 8. Code-change Inventory

- `package.json`: Pi package manifest (`pi.extensions: ["./index.ts"]`), scripts for typecheck, test, smoke, check.
- `index.ts`: composition root.
- `src/**`: as laid out in 5.7.
- `test/**`: domain tests and extension load test.
- `README.md`: install, commands, flow, config, fallback.
- `docs/design.md`: this document.
- `.gitignore`: `node_modules`, local artifacts.
- `~/.pi/agent/prompts/handoff.md`: retained unchanged as the fallback template; the README documents that `/handoff` supersedes it when the extension is installed.

## 9. Workflow / Rollout

1. Scaffold the package (manifest, tsconfig, test runner, layering skeleton) by copying the shape from `pi-phase-runner`.
2. Implement `domain/rubric` and `domain/draft` with tests.
3. Implement the `WorkerRunner` adapter from the subagent example and drive it from a throwaway command to confirm streaming, usage, and abort.
4. Implement DraftService and Gate A. At this point **Run externally** is a complete, useful feature on its own.
5. Implement RunService, checkpoint, widget, and Gate B with Accept and Discard.
6. Implement Review here and the feedback loop.
7. Implement session entries and recovery.
8. Install with `pi install /absolute/path/to/pi-handoff` and run one real handoff end to end.

## 10. Verification

- `npm run check` passes (typecheck, domain tests, extension load test, smoke).
- `pi -ne -e . -p --no-tools "/handoff status"` exits cleanly.
- Rubric resolution picks the first available candidate and falls through correctly when a model is missing or excluded.
- Draft JSON parsing rejects malformed output and surfaces the raw text.
- In a scratch repository with a pre-existing dirty file: run a handoff, Discard, and confirm the pre-existing change is untouched while worker changes are gone.
- Escape during Run kills the child process (`ps` shows no orphan `pi`).
- Killing the reviewing Pi during Run kills the child.
- Resume the reviewing session mid-review and confirm `/handoff` reopens Gate B.
- After Review here, confirm Gate B reopens exactly once when the review turn ends, and does not reopen after a follow-up question to the reviewer.
- In a session with no active handoff, confirm ordinary turns never trigger any handoff UI.
- Run externally places a valid command on the clipboard that launches the worker with the expected model and thinking level.

## 11. Risks and Decisions

- The child `pi` process resolves auth and settings from the same `~/.pi/agent` as the parent. Any model the parent can see, the child can use.
- Cost visibility depends on the provider reporting usage in `message_end`; Bifrost proxies may omit cost, in which case the widget shows tokens only.
- The drafting side-call runs on the reviewing session's current model, which is typically the most capable and expensive one. This is deliberate: drafting quality determines everything downstream.
- The report is passed through verbatim; a worker that ignores the report format degrades Gate B's usefulness but not its correctness.
- `pbcopy` is macOS-only. The fallback notify keeps Run externally functional elsewhere.
- Blocking the reviewing session during Run means long workers tie up the TUI. This matches current usage; non-blocking is a known follow-up.

## 12. Task Breakdown

- [x] T1: Scaffold package, manifest, tsconfig, test runner, layering skeleton, and `.gitignore`.
- [x] T2: Implement `domain/rubric` (defaults, resolution, validation) with tests.
- [x] T3: Implement `domain/draft` (JSON parsing, slug, feedback append) with tests.
- [x] T4: Implement `WorkerRunner` port and child-process adapter with abort handling.
- [x] T5: Implement `Git` port and adapter (checkpoint, diffstat, discard-since-checkpoint).
- [x] T6: Implement `HandoffMachine` and session-entry persistence with schemas.
- [x] T7: Implement DraftService, the drafting prompt, and Gate A including Run externally.
- [x] T8: Implement RunService, the running widget, and Gate B with Accept and Discard.
- [x] T9: Implement Review here injection, the `agent_end` reopen of Gate B, and the bounded feedback loop.
- [x] T10: Implement `session_start` rehydration and `session_shutdown` cleanup.
- [x] T11: Write README and extension load test; run `npm run check`.
- [ ] T12: End-to-end test in a scratch repository, including the Discard safety check.
