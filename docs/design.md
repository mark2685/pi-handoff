# Pi Handoff

## 1. Context

A common workflow in Pi is: converge on a recommendation in one session, then hand the implementation to a fresh session so the first session's context stays clean and can act as the reviewer. Today this is done with the `~/.pi/agent/prompts/handoff.md` template: the reviewing agent writes a self-contained prompt to `/tmp`, recommends a model and thinking level from a tier rubric, and prints a `pi --model "provider/id:level" @/tmp/pi-handoff-<slug>.md` command. The user copies that into another terminal, waits, then pastes the implementer's final report back for review.

The manual steps are: copying the command, watching a second terminal, pasting results back, and re-establishing the diff in the reviewing session. `pi-phase-runner` solves a neighbouring problem (plan on model A, implement on model B) but does so by replacing the current session with `ctx.newSession()`, so the planning context is gone by the time implementation finishes and there is no review leg.

Pi provides the building blocks for a review-preserving version: `ctx.modelRegistry.getAvailable()` and `ctx.modelRegistry.complete()` for side-calls, `ctx.ui.select/confirm/editor/custom` for gates, `ctx.ui.setWidget` for status, `pi.sendUserMessage` to inject text into the live session, and the `examples/extensions/subagent` pattern of spawning `pi --mode json -p --no-session` as a child process and streaming its JSON events.

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

- `/handoff [scope]` as the user-facing command. Runs the full drafting, gate, run, and review flow.
- `/handoff status` to show the current handoff state and the last worker report.
- `/handoff abort` to kill a running worker and return to idle. Superseded by Escape in the running overlay: the run blocks the session behind that overlay, so this command cannot be typed while a worker is alive and is left unimplemented.
- `/handoff config` to edit the tier rubric's model mapping.

The extension uses these lifecycle hooks:

- `session_start` rehydrates handoff state from a custom session entry so a resumed reviewing session knows a handoff is in flight or awaiting review.
- `session_shutdown` kills any running worker process.
- `agent_end` reopens Gate B after the review turn that **Review here** injected. It is inert in every other state; it never opens UI or changes state unless the machine is in `reviewing` with `awaitingReviewTurn` set.

### Flow

```
/handoff [scope]
  │
  ├─ 1. DRAFT   side-call on the current model:
  │              session transcript + scope → { prompt, tier, rationale }
  │              rubric maps tier → candidate models; first available wins
  │
  ├─ GATE A     prompt + recommended provider/model:thinking + rationale
  │              [Run] [Edit prompt] [Change model] [Run externally] [Cancel]
  │
  ├─ 2. RUN     git checkpoint (stash-free: record HEAD + `git status --porcelain`)
  │              spawn: pi --mode json -p --no-session --model P/M --thinking L @prompt
  │              stream events into a widget; Escape kills the child
  │
  ├─ GATE B     worker's final report + `git diff --stat` + usage/cost
  │              [Review here] [Send feedback to worker] [Discard changes] [Accept]
  │
  ├─ 3. REVIEW  "Review here" injects report + diffstat into the reviewing
  │              session via sendUserMessage with review instructions;
  │              when that turn ends, agent_end reopens Gate B automatically
  │
  └─ 4. LOOP    "Send feedback" reopens the editor, appends feedback to the
                 prompt as a follow-up section, and returns to RUN (max N iterations)
```

### State machine

Handoff state is a discriminated union owned by one `HandoffMachine`, following Phase Runner's `PhaseMachine`:

```
idle
drafting   { scope }
proposed   { draft, choice }
running    { draft, choice, iteration, startedAt, checkpoint }
reviewing  { draft, choice, iteration, checkpoint, report, diffstat, usage, awaitingReviewTurn }
```

`awaitingReviewTurn` is true only between **Review here** and the end of the turn it triggered. It is the sole condition under which `agent_end` acts.

Only one handoff can exist per session. Starting `/handoff` while `running` is refused; starting it while `reviewing` reopens Gate B rather than drafting, since Gate B already offers Discard and Accept.

## 5. Detailed Design

### 5.1 Drafting

The draft step serializes the current session branch (`convertToLlm` + `serializeConversation`, as `examples/extensions/handoff.ts` does) and calls `ctx.modelRegistry.complete(ctx.model, …)` with a drafting system prompt. The prompt body is the current `handoff.md` template's requirements. The response must be a fenced JSON object:

```json
{
	"slug": "add-retry-logic",
	"prompt": "…self-contained implementation prompt…",
	"tier": "standard",
	"rationale": "Multi-file but fully specified; validation is a single test command."
}
```

Parsing is strict (`persistence/schemas.ts`). If the response does not parse, the user is shown the raw text and offered retry or cancel. The prompt is always written to `/tmp/pi-handoff-<slug>.md` before Gate A so the external fallback and manual inspection are available regardless of what happens next.

### 5.2 Rubric

The rubric is data, stored globally at `~/.pi/agent/handoff.json`:

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

Rendered with `ctx.ui.custom` so the prompt, model line, and rationale are visible together. Options:

- **Run** — proceed to 5.4.
- **Edit prompt** — `ctx.ui.editor` prefilled with the prompt; rewrites the `/tmp` file.
- **Change model** — Phase Runner's `pickModel` pattern: select from the live registry, then a thinking level. The tier is kept for the record; the choice overrides it.
- **Run externally** — copies `pi --model "P/M:L" @/tmp/pi-handoff-<slug>.md` to the clipboard via `pbcopy` (falls back to `ctx.ui.notify` with the command), and returns to `idle`. This preserves today's workflow for cases where the user wants a real second terminal.
- **Cancel** — returns to `idle`; the `/tmp` file is left in place.

### 5.4 Run

Before spawning, the extension records a checkpoint: `git rev-parse HEAD` and `git status --porcelain`. This is the minimum needed for Gate B's **Discard** to be safe: files that were already dirty before the run are never touched by Discard.

The worker is spawned as:

```
pi --mode json -p --no-session --model <provider>/<model> --thinking <level> @/tmp/pi-handoff-<slug>.md
```

in `ctx.cwd`, with the same event handling as `examples/extensions/subagent/index.ts`: `message_end` accumulates assistant messages and usage; `tool_result_end` accumulates tool results; `stopReason` and `errorMessage` are captured; SIGTERM then SIGKILL on abort. The extension does not pass `--tools`; the worker gets the normal default tool set. It also does not pass `--append-system-prompt`; all instructions live in the prompt file so what the user approved at Gate A is exactly what the worker receives.

While running, a widget shows elapsed time, turns, tokens, cost, and the last few tool calls. The reviewing session's agent is not invoked during this phase; the command handler awaits the child process directly, so the user sees the widget and can press Escape in it to stop the worker. The overlay owns the `AbortController` for the run because there is no external signal to borrow: `ExtensionCommandContext` has no abort member, and `ExtensionContext.signal` is undefined when the agent is not streaming, which is exactly the case while a command handler awaits a child process.

The worker's final assistant text is the report. Its expected shape is the "final report" section the drafting prompt requires: summary, files changed, validation performed, blockers. The extension does not parse this structurally in v1; it is passed through verbatim.

### 5.5 Gate B

Rendered with `ctx.ui.custom`, showing the report, `git diff --stat` against the checkpoint, usage, and iteration count. Options:

- **Review here** — sets `awaitingReviewTurn`, then `pi.sendUserMessage` with: the original handoff prompt (collapsed reference), the worker's report, the diffstat, and instructions to review the actual diff with the read/bash tools against the handoff's acceptance criteria and end the turn with a one-line verdict of accept, fix, or discard. The injected message triggers a full agent turn, so the handler must fire it without awaiting completion and return immediately; a handler that waited would hold the command open for the entire review turn and deadlock the gate it is trying to reopen. The message is delivered as a follow-up (`deliverAs: "followUp"`) because Gate B may itself be open inside `agent_end`, where the agent is still streaming and an un-queued user message is refused; when the agent is idle the option has no effect. When that turn ends, `agent_end` clears the flag and reopens Gate B, so the user acts on the review without typing another command. The reviewer's verdict is in the transcript directly above the reopened gate. If the user dismisses the gate (Escape) to ask the reviewer a follow-up question, the machine stays in `reviewing` with the flag cleared; subsequent turns do not reopen the gate, and `/handoff` reopens it on demand.
- **Send feedback to worker** — `ctx.ui.editor` for feedback; the extension appends a `## Review feedback (iteration N)` section to the prompt file and returns to 5.4. Refused when `iteration >= maxIterations`. The restart reuses the checkpoint taken before iteration 1 rather than taking a new one, so Discard still undoes every iteration and the diffstat stays cumulative across the loop.
- **Discard changes** — `git checkout -- <files changed since checkpoint>` and `git clean` limited to files that were untracked-and-absent at checkpoint. Then `idle`. Paths that were already dirty when the checkpoint was taken are skipped, so a worker's edits to those paths survive Discard; this is why Gate B leads its discard summary with the skipped paths rather than reporting only what was reverted.
- **Accept** — marks the handoff complete, leaves the working tree as is, records the report in the session as a custom entry, and returns to `idle`. Nothing is committed.

### 5.6 Session entries and recovery

Each transition appends a `handoff-state` custom entry (`pi.appendEntry(customType, data?)`, which returns `void`) containing the serialized machine state minus the child process handle. Writing entries is an `ExtensionAPI` capability rather than a session-manager call, because `ctx.sessionManager` is a read-only `ReadonlySessionManager` with no append method. On `session_start`, the latest entry is decoded; `running` is downgraded to `reviewing` with a note that the worker was interrupted (the child cannot survive a Pi restart), and `/handoff` reopens the appropriate gate. `drafting` and `proposed` are downgraded to `idle` because the `/tmp` prompt file may be stale.

### 5.7 Package layout

```
index.ts                composition root: adapters, services, command, hooks
src/domain/             pure, no IO, no Pi imports
  types.ts              HandoffState, Draft, ModelChoice, Report, Checkpoint
  result.ts             Result type (copied from phase-runner)
  rubric/               tier resolution, defaults, validation
  draft/                draft JSON parsing, slug normalization, feedback append
  report/               usage formatting, discard summaries (the report itself is passed through verbatim, never parsed)
src/ports/              WorkerRunner, Git, Clipboard, ConfigStore, Clock
src/adapters/           child-process runner, exec-based git, pbcopy, json file
src/persistence/        schemas for handoff.json, session entries, draft JSON
src/app/                HandoffMachine, DraftService, RunService, ReviewService
src/presentation/       gate-a.ts, gate-b.ts, widget.ts, model-picker.ts
src/prompts/            drafting system prompt, review injection prompt
src/commands/           /handoff argument parsing and dispatch
test/domain/            rubric, draft parsing, feedback append, diffstat
test/extension/         entry point loads and registers the expected surface
```

Layering rules match Phase Runner: `domain <- app <- adapters <- index.ts`; only `index.ts` constructs adapters.

## 6. Rejected Alternatives

- Extend the prompt template further: rejected because the template cannot validate its model pick, cannot spawn or observe a worker, and cannot bring results back without a manual paste.
- Add a handoff mode to `pi-phase-runner`: rejected because Phase Runner's invariant is "planning and implementing are mutually exclusive in this session" via `ctx.newSession`, while handoff's invariant is "implementation happens in a child process while this session waits to review." Bolting a subprocess runner onto `PhaseMachine` would fork its state model. Shared pieces (`model-picker`, `environment`) can be extracted later once both shapes are stable.
- Use `ctx.newSession` and switch back with `ctx.switchSession` after implementation: rejected because it serializes the two sessions in one TUI and loses the live review context; the child-process model keeps the reviewing session intact.
- Run the worker in a git worktree: deferred. It gives true isolation but complicates untracked files, `node_modules`, and generated artifacts. The checkpoint plus Discard covers the v1 failure mode.
- Non-blocking worker with a background widget: deferred. The current workflow already waits; blocking keeps the state machine and abort handling simple.
- Let the drafting model pick a concrete model ID: rejected because it can hallucinate IDs or pick unavailable ones. It picks a tier; resolution to a model is deterministic and registry-validated.
- Structured parsing of the worker report: deferred. The report is prose for a human reviewer; parsing adds a failure mode with little v1 benefit.
- Require `/handoff` to reopen Gate B after the review turn instead of hooking `agent_end`: rejected in favour of the automatic reopen because the extra command is friction on every handoff, while the hook's misfire risk is contained by a single flag that is cleared on first use. If the review turn ends early (permission prompt, token limit), the user dismisses the gate and continues; `/handoff` remains available to reopen it.

## 7. Correctness Hazards / Non-negotiables

- The reviewing session's model, thinking level, and tools must never be changed by a handoff. Only the child process runs on the chosen model.
- The worker must receive exactly the prompt approved at Gate A. No hidden system prompt additions.
- The chosen model must exist in `ctx.modelRegistry.getAvailable()` at spawn time; otherwise Gate A must block Run.
- Discard must only touch files changed since the checkpoint. Files dirty before the run are out of bounds.
- `session_shutdown` and command abort must kill the child (SIGTERM, then SIGKILL after a grace period). A worker must never outlive the reviewing session unnoticed.
- The fix loop must be bounded by `maxIterations` and must require a gate between iterations.
- `agent_end` must be a no-op unless the machine is in `reviewing` with `awaitingReviewTurn` set. It must clear the flag before opening Gate B so a second `agent_end` (for example after an auto-retry or queued follow-up) cannot open a second gate. It must never fire UI in a session where no handoff is active.
- The `/tmp` prompt file must be written before Gate A so the external fallback works even if the extension fails afterwards.
- Nothing is committed, pushed, or PR'd by the extension or, via the prompt, by the worker.
- The drafting step must never fabricate context: the drafting prompt carries the template's instruction to ask rather than invent, and a draft that contains an explicit `NEEDS INPUT` marker is shown to the user instead of Gate A.
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
