# Pi Handoff

Pi Handoff is a Pi extension that keeps the current session alive as the reviewer while an isolated child `pi` process implements an approved handoff, then brings the result back for review. It supersedes the `~/.pi/agent/prompts/handoff.md` template when installed. The full design is in [`docs/design.md`](docs/design.md).

## Install

```text
pi install /absolute/path/to/pi-handoff
```

## Commands

```text
/handoff [scope]
```

- `/handoff` or `/handoff <scope>` — draft a handoff from the current session, optionally narrowed by free-text scope (anything that is not a recognized subcommand is treated as scope, not an error).
- `/handoff status` — print the current handoff state. Works outside the TUI.
- `/handoff abort` — recognized but replies "is not implemented yet"; superseded by Escape in the running overlay, since the run blocks the session behind that overlay and the command cannot be typed while a worker is alive.
- `/handoff config` — recognized but replies "is not implemented yet"; the rubric is currently fixed at `DEFAULT_RUBRIC` (see Configuration below), and `~/.pi/agent/handoff.json` is not read.

Drafting requires TUI mode and a selected model; `/handoff status` works in any mode.

## Flow

1. **Draft** — a side-call on the current model serializes the session transcript and returns a strict JSON envelope: `{ slug, prompt, tier, rationale }`. If the response cannot be parsed, the raw text is placed in the editor and a retry/cancel menu is shown. If the draft contains a `NEEDS INPUT` marker, it is shown to the user rather than run. The prompt is always written to `/tmp/pi-handoff-<slug>.md` before Gate A, so the external fallback and manual inspection survive whatever happens next.
2. **Gate A** — shows the prompt, the recommended `provider/model:thinking`, and the rationale. Options:
   - **Run** (shown as "Run (blocked: choose an available model first)" until an available model is chosen)
   - **Edit prompt** — opens an editor prefilled with the prompt and rewrites the `/tmp` file.
   - **Change model** — pick a model from the live registry, then a thinking level; the tier is kept for the record but the choice overrides it.
   - **Run externally (copy command)** — copies `pi --model "provider/model:thinking" @/tmp/pi-handoff-<slug>.md` to the clipboard via `pbcopy`, falling back to a notification if the clipboard is unavailable.
   - **Cancel** — returns to idle; the `/tmp` file is left in place.
3. **Run** — a git checkpoint (`git rev-parse HEAD` plus `git status --porcelain`) is taken before spawning, and the chosen model is re-checked against the live registry at the moment of the click. The worker is spawned as `pi --mode json -p --no-session --model <provider>/<model> --thinking <level> @/tmp/pi-handoff-<slug>.md` in the working directory, with no `--tools` and no `--append-system-prompt`. A live overlay shows elapsed time, turns, tokens, context, and cost, plus recent tool calls. Pressing Escape stops the worker (SIGTERM, then SIGKILL after a grace period). An aborted run or one that produced no report still reaches Gate B, marked _interrupted_, with the checkpoint retained.
4. **Gate B** — shows the worker's report, `git diff --stat` against the checkpoint, and usage. Options (Review here is omitted for interrupted runs):
   - **Review here** — injects the report, diffstat, and review instructions into the reviewing session as a follow-up message; see Review and feedback below.
   - **Send feedback to worker** — shown as blocked once the iteration bound is reached.
   - **Discard changes** — asks for confirmation first (Keep is the default option), then reverts.
   - **Accept** (shown as "Accept (keep the tree as it is)" for an interrupted run)
   - **Leave this for later** — dismisses the gate without discarding or accepting; `/handoff` reopens it.

### Review and feedback

- **Review here** arms a one-shot flag and sends the report, the diffstat, and review instructions into the reviewing session as a follow-up user message. The reviewer is told to inspect the actual diff with the read and bash tools rather than trust the report, not to edit or commit anything, and to end the turn with a line beginning `Verdict:` followed by `accept`, `fix`, or `discard`. When that turn ends, the `agent_end` hook reopens Gate B exactly once. Dismissing the gate leaves the review pending without rearming it; `/handoff` reopens it on demand.
- **Send feedback to worker** opens an editor, appends a `## Review feedback (iteration N)` section to the prompt file on disk, and re-runs the worker against the **original checkpoint** from iteration 1, so Discard still undoes every iteration and the diffstat stays cumulative. Refused once `iteration >= maxIterations`.

## Safety properties

- A checkpoint is taken before the worker is spawned, never after.
- Discard reverts only paths that were clean at checkpoint time; paths already dirty at checkpoint are skipped and listed in an acknowledgement the user must dismiss, so a worker's edits to pre-existing dirty files survive Discard.
- Discard is blocked if HEAD moved or the repository root changed since the checkpoint.
- Nothing is ever committed, pushed, or opened as a pull request by the extension or, via the prompt, by the worker.
- The worker is killed (SIGTERM, then SIGKILL after a grace period) on Escape during Run and again on `session_shutdown`, so it cannot outlive the reviewing session unnoticed.
- The reviewing session's own model, thinking level, and tools are never changed by a handoff; only the child process runs on the chosen model.

## Recovery

Every transition appends a `handoff-state` custom session entry. On `session_start`, the latest valid entry is rehydrated:

- `drafting` or `proposed` → `idle` (the `/tmp` prompt file may be stale).
- `running` → an _interrupted_ review, with the note "The worker was interrupted because this Pi session restarted.", keeping the checkpoint so Discard is still available.
- `reviewing` → `reviewing`, with the review-turn flag cleared so a restart cannot resurrect an armed `agent_end`.

`session_shutdown` kills any running worker and waits for it to exit before Pi tears the session down.

## Configuration

The rubric is currently the shipped `DEFAULT_RUBRIC` (`src/domain/rubric/defaults.ts`); `~/.pi/agent/handoff.json` and `/handoff config` are not implemented. The drafting model chooses only a tier; resolving a tier to a concrete model is deterministic — the first candidate below that is present in the live model registry and not excluded wins:

| Tier       | Candidates (in order)                                                      |
| ---------- | -------------------------------------------------------------------------- |
| `routine`  | `bifrost-openai/gpt-5.6-luna` (medium), `bifrost/claude-sonnet-5` (medium) |
| `standard` | `bifrost-openai/gpt-5.6-terra` (high), `bifrost/claude-sonnet-5` (high)    |
| `hard`     | `bifrost/claude-opus-5` (high), `bifrost-openai/gpt-5.6-terra` (xhigh)     |
| `frontier` | `bifrost/claude-fable-5-1` (xhigh)                                         |

`maxIterations` is `3`. Excluded models: `bifrost/claude-3-haiku`, `bifrost/claude-opus-4-8`.

If no candidate for a tier is available, Gate A opens with Run blocked until the user picks a model with **Change model**.

## Terminal fallback

**Run externally** at Gate A copies the exact worker launch command to the clipboard (falling back to a notification if there is no clipboard):

```text
pi --model "provider/model:thinking" @/tmp/pi-handoff-<slug>.md
```

This preserves the original manual workflow: the `/tmp` prompt file is written before Gate A opens, so it exists regardless of which option is chosen, and the command can always be run by hand in a separate terminal.

## Package layout and layering

```text
index.ts                composition root: adapters, services, command, hooks
src/domain/             pure, no IO, no Pi imports
src/ports/              interfaces for everything outside the process
src/adapters/           child-process runner, exec-based git, pbcopy, filesystem
src/persistence/        schemas for session entries and draft JSON
src/app/                HandoffMachine, DraftService, RunService, ReviewService
src/presentation/       gates, widget, model picker
src/prompts/            drafting and review prompt text
src/commands/           /handoff argument parsing and dispatch
test/domain/            rubric, draft parsing, feedback append, porcelain status parsing
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
