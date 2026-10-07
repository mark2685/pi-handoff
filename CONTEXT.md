# Pi Handoff

The language this extension uses when it talks to a person: in gate titles and menus, in the run monitor, in notifications, in `/handoff status`, and in the README. One term per concept, on every surface. Implementation terms that never reach a user (`HandoffMachine`, `RunService`, `GateFrame`, `WorkerRunner`) are defined in [docs/design.md](docs/design.md); this file defines the words the user reads, and `src/domain/vocabulary.ts` spells the ones more than one surface must agree on — gate names and titles, the run monitor title, the partial-output heading, the review option label — so those cannot drift between a menu and the notification that names it.

## Language

### The handoff

**Handoff**:
One delegation of work from the reviewing session to a worker, from draft to accept or discard.
_Avoid_: task, job, run (that is one worker execution)

**Draft**:
The drafting model's proposal for a handoff: slug, prompt, tier, rationale, goal, definition of done, and any open questions.
_Avoid_: proposal, envelope (the JSON wire shape), plan

**Prompt**:
The text the worker is given, written to `/tmp/pi-handoff-<slug>.md` before the launch gate opens.
_Avoid_: task file, spec, instructions

**Goal**:
The draft's one-sentence bottom line, shown at the launch gate and on the run monitor.
_Avoid_: BLUF, `bluf` (the envelope key), summary, headline

**Definition of done**:
Up to five short, checkable completion conditions carried by a draft.
_Avoid_: acceptance criteria, checklist, DoD (in prose)

**Scope**:
Free text that narrows a draft, including the `Q:`/`A:` pairs an answered questions gate appends.
_Avoid_: context, hint, focus

**Open question**:
A decision the drafting model could not make for itself, asked at the questions gate.
_Avoid_: NEEDS INPUT (the model's marker), blocker, clarification

**Tier**:
The drafting model's difficulty rating for a handoff — routine, standard, hard, or frontier — which the rubric resolves to a model.
_Avoid_: level, difficulty, size

**Rubric**:
The fixed table of tier candidates, excluded models, and the iteration bound.
_Avoid_: config, policy, settings

**Leftovers**:
The `Leftovers:` items of an accepting review, draftable as a follow-up handoff.
_Avoid_: follow-ups, remaining work, TODOs, nits

### Roles

**Reviewing session**:
The Pi session that drafts the handoff, decides its gates, and reviews the result; its model, thinking level, and tools are never changed.
_Avoid_: parent, host, main session, this session (as a name)

**Worker**:
The isolated child `pi` process that implements one run of a handoff.
_Avoid_: child (in prose), agent, subagent, implementer

**Drafting model**:
The reviewing session's model, when it writes or re-writes a draft.
_Avoid_: planner, side model

**Reviewer**:
The reviewing session's agent, when it runs a review turn.
_Avoid_: judge, critic, the model

### Running

**Launch**:
Starting a worker on an approved draft — Run, Run and review, or Run externally.
_Avoid_: start, spawn (in prose), kick off

**Run**:
One worker execution of a handoff against its checkpoint.
_Avoid_: attempt, execution, job

**Iteration**:
The ordinal of a run within a handoff; the first launch is iteration 1 and each feedback run adds one, up to the rubric's bound.
_Avoid_: round (that is the questions gate's count), pass, loop

**Checkpoint**:
`HEAD` plus the porcelain status taken before the first launch; every iteration runs against it and Discard reverts to it.
_Avoid_: snapshot, baseline, stash

**External run**:
A run the user launches in another terminal from the copied launch command; it is measured by nobody.
_Avoid_: manual run, terminal run, fallback (as a name)

**Run monitor**:
The surface shown while a worker runs: goal, definition of done, worker phase, metrics, recent tool calls, and Escape to stop.
_Avoid_: overlay, widget, running widget, progress screen

**Stalled**:
The run monitor's state after ten minutes without a meaningful worker event; it asks whether to keep waiting and never stops the worker itself.
_Avoid_: hung, timed out, dead

### Results

**Result**:
How a run ended: **completed** or **interrupted**, with whatever evidence that end left behind.
_Avoid_: outcome, status, output

**Completed**:
A run whose worker ended cleanly, so its final text is a report.
_Avoid_: finished, succeeded, done

**Report**:
A completed worker's final text — a claim the worker chose to make about what it did.
_Avoid_: output, summary, response, result

**Interrupted**:
A run whose worker did not end cleanly — stopped, crashed, or restarted — and is therefore never presented as completed.
_Avoid_: aborted (the `AbortController` mechanism), killed, died, failed (in prose), incomplete

**Stopped**:
Interrupted by the user pressing Escape on the run monitor.
_Avoid_: aborted, cancelled

**Crashed**:
Interrupted by a worker error, an error stop reason, or a non-zero exit.
_Avoid_: errored, failed

**Restarted**:
Interrupted because the reviewing session restarted while a child-process worker was running.
_Avoid_: lost, orphaned

**Partial output**:
Text a crashed worker emitted before it died; never a report.
_Avoid_: pre-crash output, partial report, `partialReport` (the persisted field)

**Stderr tail**:
The bounded end of a crashed worker's standard error, which usually names the real failure.
_Avoid_: logs, error output

**Diffstat**:
`git diff --stat` of the working tree against the checkpoint, cumulative across iterations.
_Avoid_: changes (alone), diff, the stat

**Usage**:
Tokens, context size, cost, and turns measured from a child-process worker; absent — never zero — when nothing measured it.
_Avoid_: stats, metrics (on the run monitor those are live), spend

### Review and feedback

**Review turn**:
The reviewing session's agent turn, started by Review here, that inspects the diff and ends with a `Leftovers:` block and a `Verdict:` line.
_Avoid_: review (alone, for the turn), in-session review, Review here (as a noun)

**Captured review**:
A review turn's final message — its verdict and findings — kept with the iteration it reviewed.
_Avoid_: review result, review record, pending review (that is the gate's state)

**Verdict**:
The captured review's `accept`, `fix`, or `discard`.
_Avoid_: decision, outcome, result, recommendation

**Findings**:
A captured review's text apart from its verdict line.
_Avoid_: comments, notes, review body

**Feedback**:
Text sent to a new worker iteration; a captured review is its prefill.
_Avoid_: review (for the thing sent), instructions, fixes

**Accept**:
Ending the handoff and keeping the working tree exactly as it is; nothing is committed.
_Avoid_: approve, merge, finish

**Discard**:
Reverting the paths that were clean at the checkpoint back to it, leaving paths already dirty then untouched.
_Avoid_: revert (the mechanism), rollback, undo, reset

### Gates and surfaces

**Surface**:
Any screen the extension takes keyboard focus for: a gate, a viewer, the run monitor, or the drafting loader.
_Avoid_: overlay, dialog, modal, screen (as a name)

**Gate**:
A human decision that spends money or changes the working tree; there are exactly three.
_Avoid_: dialog, prompt, menu (for a gate), step

**Questions gate**:
The gate that decides how a draft's open questions are answered before it is re-drafted.
_Avoid_: NEEDS INPUT gate, needs-input gate, clarification dialog

**Launch gate**:
The gate that decides whether, and on which model, a draft runs.
_Avoid_: Gate A, approval gate, run gate, proposal

**Result gate**:
The gate that decides what becomes of a run's result: review it, send feedback, discard, or accept.
_Avoid_: Gate B, review gate, acceptance gate, changes gate

**Choice**:
A menu that decides neither spend nor a tree change — the external-run menu and the retry menus.
_Avoid_: gate

**Confirmation**:
The Keep/Discard question asked before a discard, with Keep as the default.
_Avoid_: gate, are-you-sure

**Notice**:
A message the user must dismiss, such as the discard summary; distinct from a transient notification.
_Avoid_: notification (that is `ctx.ui.notify`), alert, acknowledgement (in prose)

**Viewer**:
The read-only, scrollable surface that shows a whole text a gate could only preview.
_Avoid_: pager, editor, full view

**Hidden-blocks line**:
The dim row inside a gate that names the evidence blocks the terminal had no room for, e.g. `… report, findings not shown — enlarge the terminal or use the viewers in the menu`; it is part of the gate and is not dismissed.
_Avoid_: notice (that must be dismissed), warning, overflow message

**Signpost**:
The `… N more lines — choose "View full report" to read all of it` line a shortened block ends with, naming the viewer that shows the rest.
_Avoid_: truncation notice, ellipsis, more-link

**Drafting loader**:
The cancellable loader shown while a drafting call runs, naming the drafting model and elapsed time.
_Avoid_: spinner, progress

## Relationships

- A **Handoff** has exactly one **Draft** at a time, one **Checkpoint**, and one or more **Runs**; each **Run** is one **Iteration**.
- A **Draft** has one **Prompt**, one **Goal**, one **Tier**, at most five **Definition of done** items, and zero to three **Open questions**; its **Tier** is resolved by the **Rubric** unless the user changes the model.
- Every **Run** ends in exactly one **Result**: **Completed**, with a **Report**, or **Interrupted** — **Stopped**, **Crashed**, or **Restarted** — with whatever **Partial output** and **Stderr tail** the crash left.
- A **Run** has **Usage** only if the extension measured it; an **External run** and a **Restarted** run have none.
- The three **Gates** happen in order: **Questions gate** (zero or more times) → **Launch gate** → **Result gate**; a **Choice**, **Confirmation**, or **Notice** is never a gate.
- The **Result gate** may start one **Review turn** per **Iteration**; its **Captured review** has one **Verdict** and some **Findings**, orders the gate's options, and prefills **Feedback**.
- **Feedback** launches the next **Iteration** against the same **Checkpoint**, so **Discard** undoes every iteration at once and the **Diffstat** stays cumulative.
- An accepting **Verdict** with **Leftovers** can start a follow-up **Handoff**, which passes through the same gates.
- A shortened block in any **Gate** ends in a **Signpost**; where a **Viewer** exists for its full text, the signpost names it. The questions gate's questions and the result gate's findings have no viewer, so their signposts only count what is hidden.

## Example dialogue

> **Dev:** "The **run monitor** said the worker was **stalled**, I pressed Escape, and the **result gate** says the run was **interrupted**. Did it crash?"
> **Domain expert:** "No — you **stopped** it. **Interrupted** is the umbrella: stopped, crashed, or restarted. Either way there is no **report**, so Review here is not offered; what you see is **partial output**, which is never called a report."
>
> **Dev:** "On a completed run I chose Review here. Is that the **review**?"
> **Domain expert:** "That starts the **review turn**. When it settles, its **captured review** — a **verdict** and **findings** — comes back to the **result gate**. Choose Send review to worker and the findings become **feedback** for iteration 2, against the same **checkpoint**."
>
> **Dev:** "So the **launch gate** and the **result gate** are the old Gate A and Gate B?"
> **Domain expert:** "Yes, named by what they decide. The **questions gate** is the third; it is a gate because answering it spends a re-draft. The external-run menu is a **choice**, and Keep/Discard is a **confirmation** — neither is a gate."

## Flagged ambiguities

- "Gate A" and "Gate B" named the gates by order, and the NEEDS INPUT gate by the model's marker — resolved: **launch gate**, **result gate**, and **questions gate**, in code, docs, and emitted text; `NEEDS INPUT` survives as the drafting model's marker: in the drafting prompt, in the fallback parser, in the model-facing scope heading `Answers to the previous draft's NEEDS INPUT questions`, and — named as the marker, "remove the NEEDS INPUT marker" — in the two conflict messages about a prompt that still carries it.
- "interrupted", "aborted", "stopped", "crashed", "did not finish", and "did not complete" described one condition — resolved: **interrupted** is the condition, **stopped** / **crashed** / **restarted** are its causes; "aborted" names only the `AbortController` mechanism in code.
- "pre-crash output", "partial output", "partial report", and `partialReport` named one thing — resolved: **partial output** everywhere a person reads; `partialReport` stays as the persisted field so older session entries still decode.
- `bluf` in the envelope, schema, and code but "Goal" on screen — resolved: **goal** in prose and identifiers; `bluf` stays the envelope key and persisted field.
- "overlay" and "widget" both named the surface shown during a run, and neither is accurate: the code uses pi's `ctx.ui.custom` without `overlay: true` and never `setWidget` — resolved: **run monitor**; **surface** is the generic word.
- "Send feedback to worker" and "Send review to worker" are one action — resolved: the thing sent is always **feedback**; the dual label is kept deliberately because it tells the person whether the editor opens prefilled with a **captured review**.
- The persisted state kinds `idle`, `drafting`, `proposed`, `running`, and `reviewing` are wire values; in prose a handoff is "waiting at the launch gate" or "waiting at the result gate", never "in the proposed state".
- "Leave this for later" is spelled `dismiss` in option ids; in prose the gate is "left for later" and the review stays "pending".
- `GateFrame`, `HandoffMachine`, and the service names are implementation terms a person never reads, so they are defined in `docs/design.md` rather than here.
