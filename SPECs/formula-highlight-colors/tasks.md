# Tasks: Color Highlights in Formulas and Prose

**Input**: Design documents from `SPECs/formula-highlight-colors/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Included — plan.md names `apps/desktop/tests/highlight.test.ts` and quickstart.md
specifies exactly what it must cover. Every test task below is lifted from that table. No test
constructs an `EditorView`, mounts the bar, or asserts on rendered pixels (node-only runner,
Constitution VI).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story the task belongs to (US1, US2, US3, US4)
- Paths are relative to the repository root. Every task names its file, except the two
  command-only tasks (T044's validation gate, T045's manual walk), which name the commands to run
  and the document to walk instead

---

## Phase 1: Setup

**Purpose**: Create the test file every later phase appends to. Nothing else — no new dependency,
no toolchain change, and no empty directory or barrel file (`lib/highlight/` comes into existence
with its first module, T002).

- [x] T001 Create `apps/desktop/tests/highlight.test.ts` with the Vitest imports and a single placeholder `describe("highlight")` block, matching the style of a neighbouring test such as `apps/desktop/tests/editor-formatting.test.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Everything FR-007 says must be shared — one palette, one context decision, one bar,
one write path. Both P1 stories differ only in their emitter, so all of this sits below both.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T002 Implement the palette table in `apps/desktop/src/lib/highlight/palette.ts` per [contracts/palette.md](./contracts/palette.md): export ``interface PaletteColour { id: string; name: string; hex: `#${string}` }`` and `export const HIGHLIGHT_PALETTE: readonly PaletteColour[]` with six entries. Constraints, verbatim from data-model.md: `id` is "stable, kebab-case", "unique across the table", and "never written to the document"; `name` is "shown in the bar and read by screen readers"; `hex` is "lowercase `#rrggbb`" matching `/^#[0-9a-f]{6}$/` and "is what lands in the file"; each `hex` "clears the contrast threshold against both the light and the dark editor background". No CSS variable, no theme-aware value (Constitution I, research R6)
- [x] T003 Add the palette tests to `apps/desktop/tests/highlight.test.ts`: iterate `HIGHLIGHT_PALETTE` and assert every `hex` matches `/^#[0-9a-f]{6}$/`, every `id` is unique, and every `hex` clears the contrast threshold against both the light and the dark editor background colours (FR-014, SC-006). Assert over the whole table, not per-entry literals — adding a seventh colour must be covered without editing the test
- [x] T004 Implement the context resolver in `apps/desktop/src/lib/highlight/emit.ts`: a function taking the editor state and a selection range that calls `mathContext(state, pos)` from `apps/desktop/src/lib/latex-snippets/math-context.ts` for **both ends** and returns `"math"` (kind `inline` | `display` | `text`), `"prose"` (kind `prose`), or refused. Rules from data-model.md: the two ends "must agree" — a selection starting in math and ending in prose is refused rather than guessed at, so math delimiters are never swallowed; `code` in either end means refused (FR-002); `text` (inside `\text{…}`) counts as **math** because "an HTML span there would not render". Never cached across a document change (FR-017)
- [x] T005 Add context-resolver tests to `apps/desktop/tests/highlight.test.ts`: both ends in math → `"math"`; both in prose → `"prose"`; one end in each → refused; either end in inline or fenced code → refused; inside `\text{…}` → `"math"` (FR-002, FR-007, research R3)
- [x] T006 Implement the `Highlight` value type and the detector in `apps/desktop/src/lib/highlight/emit.ts`: `{ from: number; to: number; colour: PaletteColour | { hex: string }; context: "math" | "prose" }` where `from`/`to` are "document positions of the **inner text** — the glyphs that get the colour, excluding the wrapper" (data-model.md). The detector recognises **exactly** `\textcolor{#rrggbb}{…}` and `<span style="color:#rrggbb">…</span>` and nothing else — a hand-written `\color{...}`, a `<span>` carrying other CSS, or a `<mark>` "is not a Writer highlight, is left strictly alone, and raises no bar state" ([contracts/document-format.md](./contracts/document-format.md))
- [x] T007 Add detector tests to `apps/desktop/tests/highlight.test.ts`: the two recognised forms are read back with correct inner `from`/`to` and hex; `\color{#e0a000}{x}`, `<mark>x</mark>` and `<span class="foo">x</span>` are all ignored (contract, "Reading a highlight back")
- [x] T008 Implement the normalise-then-re-emit write path in `apps/desktop/src/components/editor-area/highlight-command.ts`: strip every Writer wrapper intersecting the union of the selection and the highlights it touches, then compute up to three regions over the resulting plain text — "the old colour on the leading remainder, the new colour on the selection, the old colour on the trailing remainder" (research R8). **Emitter-agnostic**: this task computes and returns the regions against an emitter interface; the emitters themselves arrive with US1 (T021/T023) and US2 (T027/T032), so nothing is written to a document at the Phase 2 checkpoint. No-overlap and fully-inside are the same code path with empty remainders, so the FR-013 recolour is not a special case. Nesting must be **unrepresentable**, not merely avoided — KaTeX accepts a nested `\textcolor`, so validation gives FR-013 no backstop
- [x] T009 Enforce single-dispatch discipline in `apps/desktop/src/components/editor-area/highlight-command.ts`: colour, recolour and remove are each exactly **one** `view.dispatch`, so CodeMirror's history groups each into one undo step (FR-011, research R7). Never split a highlight action across two dispatches and never implement recolour as remove-then-apply
- [x] T010 Build the selection-anchored bar shell in `apps/desktop/src/components/editor-area/highlight-bar.tsx`: render one swatch per `HIGHLIGHT_PALETTE` entry plus a remove action (FR-001), anchored from `view.coordsAtPos` measured **inside `view.requestMeasure`, never directly in an update handler** (research R5, `docs/editor.md`). Do not appear for an empty selection, for a refused context, or in a read-only surface (FR-002). Follow `apps/desktop/src/components/editor-area/pdf-quote-button.tsx`'s _rule_ — resolve the target at press time, not capture time — not its geometry
- [x] T011 Implement FR-017's stale-position guard in `apps/desktop/src/components/editor-area/highlight-bar.tsx`: recompute the target range and its context at the moment a colour is pressed; if the document changed such that the position is no longer valid, close the bar and **write nothing** — never map to a guessed position (Constitution IV)
- [x] T012 Mount the bar in `apps/desktop/src/components/editor-area/editor-pane.tsx` as a sibling of `<ProseMarkEditor>`, passing the `editorView` state the file already holds — the same wiring `<SectionRail filePath={path} view={editorView} …>` uses at `editor-pane.tsx:93`
- [x] T013 Create `apps/desktop/src/components/editor-area/highlight.css` and import it from `apps/desktop/src/components/editor-area/highlight-bar.tsx` (precedent: `prosemark-editor.tsx:3` imports `./prosemark-theme.css`). Swatch colours come from `HIGHLIGHT_PALETTE` as inline style, never from a duplicated list in CSS (Constitution III — "no parallel list")
- [x] T014 Create `apps/desktop/src/components/editor-area/highlight-decorations.ts` with the shared decoration entry point (empty spec list for now) and register it plus the bar's plugin in `apps/desktop/src/components/editor-area/editor-extensions.ts`. US1 and US2 each add their own spec to this file in later phases

**Checkpoint**: The bar appears beside a selection, refuses code and empty selections, and closes on a stale position. No colour is written yet.

---

## Phase 3: User Story 1 — Colour a fragment of a formula (Priority: P1)

**Goal**: Select part of a `$…$` / `$$…$$` formula, pick a colour, and see that fragment — and only
that fragment — coloured in the rendered output, with the document never left unrenderable.

**Independent Test**: Open a note with `$$(2+5j)^4=(\sqrt{24})^4(\cos(4*1.190)+\sin(4*1.190)j)$$`,
select `\cos(4*1.190)`, pick amber, and confirm the rendered output shows that sub-expression in
amber while the rest is unchanged (spec US1).

- [x] T015 [US1] Export a `validateMath` wrapper around `katex.__parse` from `apps/desktop/src/components/editor-area/math-renderer.ts`, returning a boolean and swallowing the parse error. Leave `trust: false` untouched — `\textcolor` is a core KaTeX command needing no relaxation, verified in research R1, and `math-renderer.ts` already documents why `trust: false` matters for documents arriving from external vaults (FR-010)
- [x] T016 [US1] Implement the brace-depth counter in `apps/desktop/src/lib/highlight/math-range.ts`: ~15 lines counting `{` and `}` over the formula string, used only to locate the ladder's wider candidates. It must **never** learn command arity, `\left`/`\right` or environments — `katex.__parse` owns those judgements (plan.md Constitution Check II)
- [x] T017 [US1] Implement the three syntactic guards in `apps/desktop/src/lib/highlight/math-range.ts`: reject a candidate with a leading `^` or `_`, one whose brace depth does not return to zero or goes negative, and one ending in a trailing lone `\`. These run **before** `katex.__parse`, because `\textcolor{c}{^2}` parses while meaning a superscript with no base — the guards exist to reject candidates that _parse but mean the wrong thing_ (research R2)
- [x] T018 [US1] Implement `expandAndValidate` in `apps/desktop/src/lib/highlight/math-range.ts` returning, verbatim from data-model.md, `{ ok: true; from: number; to: number; expanded: boolean }` or `{ ok: false; reason: string }`. Walk the four-entry ladder in order and accept the first candidate clearing both the guards (T017) and `validateMath` (T015): **C0** the user's exact range; **C1** C0 trimmed of leading and trailing whitespace; **C2** C0 widened left over a partial control sequence and right until brace depth returns to zero; **C3** the contents of the enclosing `{…}` group, widened left over an owning command name (`\frac`, `\sqrt`) and over any `^`/`_` and its base. Expansion is always a contiguous range widening — no braces are ever inserted outside the user's selection and no character between `from` and `to` is ever altered ([contracts/document-format.md](./contracts/document-format.md))
- [x] T019 [US1] Add the `expandAndValidate` ladder tests to `apps/desktop/tests/highlight.test.ts` over the research R2 table: unmatched parentheses pass **unexpanded** (they parse fine — spec scenario 3); a selection crossing a `\sqrt{…}` boundary expands and the result renders (scenario 4); a split control sequence expands; a bare superscript expands; an unrescuable selection returns `ok: false` with a reason (FR-008, FR-009, SC-002)
- [x] T020 [US1] Add the guard tests to `apps/desktop/tests/highlight.test.ts`: `^2`, `a}{b` and a trailing lone `\` are each rejected by the guards **before** `__parse` sees them; and `{a}` selected inside `\frac{a}{b}` walks the ladder to C3 and yields `\textcolor{…}{\frac{a}{b}}` (research R2, FR-008)
- [x] T021 [US1] Implement the math emitter in `apps/desktop/src/lib/highlight/emit.ts`: produce exactly `\textcolor{#rrggbb}{FRAGMENT}` where `#rrggbb` is lowercase from the palette and `FRAGMENT` is "the document text of the applied range, byte-for-byte, unmodified". Written **inside** the `$…$` / `$$…$$` delimiters — the delimiters are never touched and never enter the highlight. The wrapper is purely additive: a prefix, the untouched original text, a suffix ([contracts/document-format.md](./contracts/document-format.md), FR-005)
- [x] T022 [US1] Add the math emitter test to `apps/desktop/tests/highlight.test.ts`: colouring `\cos(4*1.190)` amber in the contract's example source yields exactly `$$(2+5j)^4=(\sqrt{24})^4(\textcolor{#e0a000}{\cos(4*1.190)}+\sin(4*1.190)j)$$` (FR-005, contract example)
- [x] T023 [US1] Wire the math branch into `apps/desktop/src/components/editor-area/highlight-command.ts`: run `expandAndValidate` per emitted region before writing. On `ok: false`, leave the document **untouched** and pass `reason` to `showEditorNotice` from `apps/desktop/src/components/editor-area/editor-notice-store.ts` — never a silent no-op, never a fallback that writes something broken (FR-009, Constitution IV). A remainder region that cannot be re-wrapped safely fails the **whole** action rather than writing a partial result (research R8)
- [x] T024 [US1] Surface the applied range when `expanded: true` in `apps/desktop/src/components/editor-area/highlight-bar.tsx`: FR-008 requires the user can see the range that was actually coloured when it differs from what they selected
- [x] T025 [US1] Add a math-source decoration pass to `apps/desktop/src/components/editor-area/highlight-decorations.ts` that colours the inner glyphs of `\textcolor{#rrggbb}{…}` in the **unfolded** source and conceals the wrapper (FR-015, FR-016). It must **not** use `hidableNodeFacet`: that facet keys on syntax nodes, and `latexSourceLanguage` in `apps/desktop/src/components/editor-area/latex-highlighting.ts` is "a flat `StreamLanguage` tokenizer — it emits six token classes and **no nesting**" (plan.md, "One correction to the spec's Assumptions"), so there is no node for the wrapper to match. Scan the math source ranges directly with the T006 detector, emitting `Decoration.replace` over the `\textcolor{#rrggbb}{` prefix and over its closing `}`, and `Decoration.mark` carrying the colour over the inner text. Use a replace-based hide, **not** a `font-size: 0` mark — a collapsed bounding rect destabilises `view.coordsAtPos`, which the bar's own placement depends on (research R4, `apps/desktop/src/lib/prosemark-core/hide/core.ts`). Reveal rule for the math case, which the prose rule does not cover: the source is unfolded only because the caret is inside the math block, so conceal the wrapper whenever the caret is outside **that highlight** and reveal it when the caret enters the wrapper or its inner text
- [x] T026 [US1] Record the math-concealment mechanism in `SPECs/formula-highlight-colors/research.md` as a new entry: plan.md assigns concealment to `hidableNodeFacet`, which holds for prose (research R4) but not for math, and the reason is the flat tokenizer. Write down what T025 actually used, so the next reader is not pointed at a mechanism the code does not use (Constitution V)

**Checkpoint**: US1 is independently demoable — quickstart steps 1–7 pass.

---

## Phase 4: User Story 2 — Colour plain prose (Priority: P1)

**Goal**: The same gesture in ordinary Markdown, written as inline HTML so the colour survives in
any other Markdown reader.

**Independent Test**: Select a sentence in a note with no math, pick green, and confirm the text
shows in green in the editor and still reads as highlighted when the file is opened in another
Markdown tool (spec US2).

**Note**: `emit.ts` and `highlight-decorations.ts` are shared with US1 — these tasks add to those
files rather than running in parallel with the US1 tasks that touch them.

- [x] T027 [US2] Implement the prose emitter in `apps/desktop/src/lib/highlight/emit.ts`: produce exactly `<span style="color:#rrggbb">TEXT</span>` where `TEXT` is "the selected text byte-for-byte". The colour is on the glyphs, not a background box (FR-004), matching the math form. Inline HTML so every CommonMark reader passes it through and the text stays visible and coloured rather than showing as raw syntax (FR-006, SC-004)
- [x] T028 [US2] Implement the multi-paragraph split in `apps/desktop/src/lib/highlight/emit.ts`: a selection spanning a blank line emits **one span per paragraph**, never a single span across a block boundary. This is load-bearing, not stylistic — a span straddling a blank line parses as an opening `HTMLTag` in one `Paragraph` and a closing one in the next, so the editor's pairing scan cannot match it and concealment would silently fail (research R9, contract)
- [x] T029 [US2] Add the prose emitter tests to `apps/desktop/tests/highlight.test.ts`: a single-paragraph selection yields exactly the contract's span form; a multi-paragraph selection emits one span per paragraph with none straddling a blank line (FR-006, contract, research R9)
- [x] T030 [US2] Add the prose `hidableNodeFacet` spec to `apps/desktop/src/components/editor-area/highlight-decorations.ts` keyed on `HTMLTag`: the predicate matches the **opening** tag only — matching both would emit every highlight's decorations twice (research R9). From the matched open tag, scan forward within the block for its partner and emit three ranges: replace the open tag, `Decoration.mark` the inner text with the colour, replace the close tag. `onHide` is allowed to return ranges outside the matched node — `hide/core.ts` pushes results into a flat array and finishes with `Decoration.set(decorations, true)`, which sorts them (research R9)
- [x] T031 [US2] Set `unhideZone` for the prose spec in `apps/desktop/src/components/editor-area/highlight-decorations.ts` to the whole highlight (open tag through close tag) so the markup reveals as one unit when the caret enters any part of it, and conceals again when it leaves (FR-016)
- [x] T032 [US2] Wire the prose branch into `apps/desktop/src/components/editor-area/highlight-command.ts`: the prose emitter is the **only** difference from the math path — same command, same palette, same bar, same normalise-then-re-emit (FR-007)

**Checkpoint**: US2 is independently demoable — quickstart steps 8–11 pass. Both P1 stories are now
complete; this is the MVP.

---

## Phase 5: User Story 3 — Recolour and remove (Priority: P2)

**Goal**: A colour is revisable — change it or take it away, with the source returning byte-for-byte.

**Independent Test**: Colour a fragment, select it again, pick a different colour, then remove it
entirely, and confirm the source returns to exactly its original text (spec US3).

**Depends on**: US1 for the math half (each re-emitted region walks `expandAndValidate`) and US2 for
the prose half. The write path itself (T008) is already shared.

- [x] T033 [US3] Implement recolour in `apps/desktop/src/components/editor-area/highlight-command.ts` as a single `changes` set replacing the old wrapper's colour argument in place — **not** a remove followed by an apply, which would break FR-011's single-undo-step requirement (research R7, FR-013)
- [x] T034 [US3] Implement removal in `apps/desktop/src/components/editor-area/highlight-command.ts`: delete exactly the prefix and suffix ranges and nothing between them. Byte-exactness is a property of the additive wrapper format, so the code must not normalise, re-trim, or rewrite the inner text (FR-012, SC-005)
- [x] T035 [US3] Show active-colour and remove state in `apps/desktop/src/components/editor-area/highlight-bar.tsx` when the selection covers an existing highlight, using the T006 detector. A recognised hex that is **not** in the palette "is displayed as written, and the bar shows _no_ active swatch. It is never silently rewritten to the nearest palette entry" (data-model.md, spec edge case)
- [x] T036 [US3] Add the round-trip test to `apps/desktop/tests/highlight.test.ts`: apply then remove, asserting **string identity** with the original — not approximate equivalence (FR-012, SC-005, research R7)
- [x] T037 [US3] Add the overlap tests to `apps/desktop/tests/highlight.test.ts`: applying to an already-highlighted range replaces the colour and produces **no nested wrapper** (FR-013); a selection **partially** overlapping an existing highlight yields three adjacent wrappers — old, new, old — with no nesting and no orphaned markup (FR-013, spec edge case, research R8)

**Checkpoint**: quickstart steps 12–16 pass, including the empty `git diff` after removing every highlight.

---

## Phase 6: User Story 4 — Keyboard and palette access (Priority: P3)

**Goal**: The colours are reachable without the mouse.

**Independent Test**: With a selection active, apply the default colour from the keyboard and
confirm the same result as clicking it in the bar (spec US4).

- [ ] T038 [US4] Add one highlight command entry to `apps/desktop/src/components/command-palette/index.tsx` following the existing `id: "…"` entry shape (see `index.tsx:161` onward). It opens the bar focused on a selection and is a no-op when there is none (FR-018)
- [ ] T039 [US4] Add keyboard navigation to `apps/desktop/src/components/editor-area/highlight-bar.tsx`: arrow keys move between swatches, Enter applies the focused colour, Escape closes the bar leaving the document unchanged (spec US4 scenarios 1–2)

**Checkpoint**: quickstart steps 17–18 pass.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [x] T040 Add the validate-before-write rule to `docs/editor.md` — it owns editor-extension rules, and the rule (candidate ladder, guards before `__parse`, refuse rather than write something unrenderable) belongs beside them (Constitution V, plan.md gate table)
- [ ] T041 [P] Add the user-visible entry to `CHANGELOG.md` (Constitution V)
- [ ] T042 [P] Update `docs/keyboard-shortcuts.md` **only if** a keyboard shortcut was bound in T039; if the command palette entry is the only access path, leave the doc alone (FR-018)
- [ ] T043 [P] Move the feature task at `TODOS.md:5` from In Progress to Done, keeping the link to this spec
- [ ] T044 Run the full gate: `vp check` and `vp test` from the repository root, and `cargo test`, `cargo clippy`, `cargo fmt --check` from `apps/desktop/src-tauri/` (unchanged by this frontend-only feature, but they are the gate — quickstart "Before calling it done")
- [ ] T045 Walk the refusals and edges in [quickstart.md](./quickstart.md) steps 19–23 by hand: caret-only shows no bar; no bar inside fenced or inline code; a selection running out of a math block is treated as prose with the `$$` delimiters not swallowed; an external edit closes the open bar without writing; a hand-edited off-palette hex renders as written with no active swatch

---

## Dependencies

```
Phase 1 (Setup)
   └─► Phase 2 (Foundational: palette, context, write path, bar)   ← BLOCKS EVERYTHING
          ├─► Phase 3  US1 (math)   ─┐
          ├─► Phase 4  US2 (prose)  ─┤
          │                          ├─► Phase 5  US3 (recolour/remove)
          ├─► Phase 6  US4 (keyboard, needs only the Phase 2 bar)
          └─────────────────────────────────► Phase 7 (Polish)
```

**Story independence — stated honestly**:

- **US1 and US2 are independent of each other.** Either can ship on the Phase 2 foundation alone.
  They touch two shared files (`emit.ts`, `highlight-decorations.ts`), so if built concurrently
  those two files need sequencing; nothing else overlaps.
- **US3 is not fully independent.** Its math half needs US1's `math-range.ts` (research R8: each
  re-emitted region walks the ladder independently), and its prose half needs US2's emitter. It is
  independently _testable_ once both P1 stories are in.
- **US4 depends only on Phase 2** — the bar exists before either emitter does.

**Shared files, not parallelisable across stories**:

| File                                              | Touched by                                                     |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `lib/highlight/emit.ts`                           | Phase 2 (T004, T006), US1 (T021), US2 (T027, T028)             |
| `components/editor-area/highlight-command.ts`     | Phase 2 (T008, T009), US1 (T023), US2 (T032), US3 (T033, T034) |
| `components/editor-area/highlight-bar.tsx`        | Phase 2 (T010, T011), US1 (T024), US3 (T035), US4 (T039)       |
| `components/editor-area/highlight-decorations.ts` | Phase 2 (T014), US1 (T025), US2 (T030, T031)                   |
| `apps/desktop/tests/highlight.test.ts`            | every phase — each test task appends its own `describe` block  |

`highlight.test.ts` is written by a task in every phase, so **no test task carries `[P]`** — they
share one file and most also wait on the module they exercise. They are cheap and sequential.

---

## Parallel Execution Examples

Genuine parallelism is thin here, and the honest answer is more useful than a padded one: nine of
the tasks write one test file and five more write one command file, so most of the work is
sequential by construction.

**Phase 7** — three different documents, no shared state:

```
T041  CHANGELOG.md
T042  docs/keyboard-shortcuts.md
T043  TODOS.md
```

**Across stories** — the real parallelism is story-level, not task-level. Once Phase 2 is done,
US1 (Phase 3) and US2 (Phase 4) can be built by two people at once; they collide only on
`emit.ts` and `highlight-decorations.ts`, where the later writer appends rather than rewrites.
US4 (Phase 6) can run alongside either, since it needs only the Phase 2 bar.

**Within Phase 3** — T015 (`math-renderer.ts`) and T016 (`math-range.ts`) are different files with
no dependency on each other, so they can start together; T017 and T018 then build on T016.

---

## Implementation Strategy

### MVP scope: US1 **and** US2 — both P1

Not US1 alone. The spec is explicit: _"shipping only the math half would leave the second half to be
bolted on later"_ (US2, Why this priority). FR-007 makes the two a single concept with two emitters,
so the prose half is one emitter plus one decoration spec on a foundation that already exists — it
is cheaper to ship now than to retrofit.

**MVP = Phase 1 + Phase 2 + Phase 3 + Phase 4** (T001–T032).

### Incremental delivery

1. **Phase 1 + 2** — the bar appears, refuses code and stale positions, writes nothing. Not shippable
   on its own, but it is the point at which the shared shape is proven and the two emitters become
   small.
2. **+ Phase 3 (US1)** — the feature the user asked for first. Demoable against the derivation in
   quickstart.
3. **+ Phase 4 (US2)** — **ship here.** Both P1 stories, portable in Obsidian and on GitHub.
4. **+ Phase 5 (US3)** — revisability. The feature stops being one-way.
5. **+ Phase 6 (US4)** — speed for repeated use.
6. **Phase 7** — docs, changelog, the full gate.

### Two rules that must not be traded away under time pressure

- **Never write text that fails to render.** On any doubt, refuse with a notice (FR-009). A partial
  write that breaks a formula is worse than no feature.
- **Never split a highlight action across two dispatches.** Undo granularity (FR-011) has no
  recovery path once the discipline is broken.
