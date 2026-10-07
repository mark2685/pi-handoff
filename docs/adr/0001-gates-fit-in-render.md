# Gates fit themselves in `render(width)`, and the menu is invariant

Every gate used to assemble itself from `Text` children and budget its previews with hand-counted row constants that counted source lines. Worker reports and prompts are written as paragraphs that wrap to three or four rows per line, so an 18-line "preview" painted 45 rows; Pi's fullscreen layout clips an oversized dock component from the bottom, where the menu was; and across 238 result gates recorded in real sessions, 82% overflowed a 120×50 terminal with the budget active. The user pressed Enter on a menu they could not see, and after an `accept` verdict the first option is Accept.

We decided that one module, the gate frame, lays out every gate and does so inside `render(width)`, measured in rendered rows with pi-tui's own wrapping, as the read-only viewer already did. Gate modules emit a pure spec — title, header, menu, evidence blocks in priority order — and make no height decisions. The frame shrinks blocks to a floor, hides them behind a hidden-blocks line, cuts the header last, and never cuts the menu. Budget is `tui.terminal.rows − 4`, because a component cannot learn its allocated height and the fullscreen dock's transcript minimum and footer share the screen. The result gate's viewer-omission rule is served by `resolveMenu`, re-run whenever a fit changes which blocks are shortened — including after a resize — and converging in a few steps because offering a viewer can only shorten more blocks. Blocks name their viewers by menu option id, and signposts take the label from the menu actually offered.

## Considered options

- **Fix the arithmetic in place** (count wrapped rows inside each formatter). Rejected: four copies of the shell would remain and the next gate would reintroduce the bug.
- **`overlay: true` with an explicit `maxHeight`.** The frame would know its height exactly instead of reserving four rows. Deferred: it changes every gate's look and rendering path at once; the spec seam makes it a local swap inside the frame if the reservation proves wrong.

## Consequences

- `formatResultGateSummary` and friends return the untruncated content; row behaviour is tested through `fitGate`, not through exported row constants, which were deleted.
- The layout changed: the menu now sits under the header, above the evidence, and the reviewer's verdict sits with the identity lines at the top of the header, so a header cut from the bottom loses usage before it loses the verdict.
- At the declared 24-row minimum the result gate shows its menu and little evidence; the viewers cover the rest.
