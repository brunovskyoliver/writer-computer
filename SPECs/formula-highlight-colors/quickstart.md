# Quickstart: Validating Color Highlights

How to prove the feature works. Two halves, and the split is deliberate: the automated half covers
the branch-heavy logic where a regression would be silent, and the manual half covers the editor
surface, because the test runner is node-only (no jsdom) and `EditorView` cannot be constructed in
it — the same constraint recorded in `SPECs/latex-suite`. Constitution VI ("do not over-test,
especially in UI") points the same way.

## Prerequisites

```bash
vp install                     # after pulling
```

## Automated

```bash
vp check                       # format, lint, types
vp test                        # includes apps/desktop/tests/highlight.test.ts
```

`highlight.test.ts` covers, and only covers, what can break silently:

| What                                                                                                                                                                                                        | Guards                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Every palette `hex` is `#rrggbb`, ids unique, contrast clears on both themes                                                                                                                                | FR-014, SC-006                       |
| Both emitters produce exactly the forms in [contracts/document-format.md](./contracts/document-format.md)                                                                                                   | FR-005, FR-006                       |
| `expandAndValidate` over the research R2 table: parens pass unexpanded, `\sqrt{…}` boundary expands, split control sequence expands, bare superscript expands, an unrescuable selection returns `ok: false` | FR-008, FR-009, SC-002               |
| The guards reject `^2`, `a}{b` and a trailing lone `\` **before** `__parse` sees them — the case that parses but means the wrong thing                                                                      | research R2                          |
| `{a}` selected in `\frac{a}{b}` walks the ladder to C3 and yields `\textcolor{…}{\frac{a}{b}}`                                                                                                              | FR-008                               |
| Apply → remove round-trip asserts **string identity** with the original                                                                                                                                     | FR-012, SC-005                       |
| Applying to an already-highlighted range replaces the colour and produces no nested wrapper                                                                                                                 | FR-013                               |
| A selection **partially** overlapping an existing highlight yields three adjacent wrappers (old, new, old), no nesting, no orphaned markup                                                                  | FR-013, spec edge case               |
| A multi-paragraph prose selection emits one span per paragraph, none straddling a blank line                                                                                                                | contract, research R9                |
| The detector ignores `\color{…}`, `<mark>`, and spans carrying other CSS                                                                                                                                    | contract, "Reading a highlight back" |

No test constructs an editor, mounts the bar, or asserts on rendered pixels.

## Manual walk

Create a scratch note:

```markdown
$$(2+5j)^4=(\sqrt{24})^4(\cos(4*1.190)+\sin(4*1.190)j)$$

$$= 41 - 840j$$

Plain prose for the second half of the feature.
```

Run the app (`vp run tauri dev` or `/run`) and open it.

### US1 — colour a formula fragment

1. Click the first rendered formula so it unfolds to source. Select `\cos(4*1.190)`. → The bar
   appears beside the selection (FR-001).
2. Pick amber. → The document now reads `\textcolor{#e0a000}{\cos(4*1.190)}` and the preview above
   repaints with **only** that fragment amber, no flash of uncoloured output (SC-003). Under 3
   seconds end to end, no dialog (SC-001).
3. Colour a fragment of the second formula the same amber. → Both render amber; the correspondence
   is visible by colour alone.
4. Select `\cos(4*1.190` — deliberately unbalanced parens. → Colours exactly that range, **no
   expansion**, formula still renders (scenario 3).
5. Select from inside `\sqrt{ 24 }` to past its `}`. → The applied range is **expanded**, the
   expansion is visible to you, and the formula renders (scenario 4).
6. Select a fragment that cannot be rescued. → Document unchanged, notice explains why. Confirm the
   formula still renders and nothing was written (scenario 5, FR-009).
7. Repeat step 1 in an inline `$…$` formula. → Identical behaviour (scenario 6).

### US2 — colour prose

8. Select a sentence in the prose paragraph, pick green. → Text shows green; the `<span>` markup is
   concealed while the caret is elsewhere (FR-016).
9. Put the caret inside the coloured run. → The markup reveals. Move out. → It conceals again.
10. Select text spanning part of a link or a bold span, colour it. → The surrounding construct still
    renders correctly.
11. Save, open the file in Obsidian (or `gh` preview). → The text shows in its colour, not as raw
    syntax (SC-004).

### US3 — recolour and remove

12. Select an existing highlight. → The bar shows that colour as active and offers remove (FR-011).
13. Pick a different colour. → Colour changes, no nested wrapper appears in the source.
    13b. Select a range that covers only the _second half_ of an existing highlight plus some text after
    it, and pick a third colour. → The source now holds two adjacent wrappers, the original colour
    on the untouched first half and the new colour on the selection. Nothing is nested and nothing
    is orphaned.
14. Remove it. → Source returns to exactly the original text.
15. Press undo once after each of steps 13 and 14. → Each reverts in a **single** step (FR-011).
16. Remove every highlight, then `git diff` the file. → **Empty** (SC-005).

### US4 — keyboard

17. With a selection, invoke the highlight command from the command palette. → The bar opens
    focused, arrow keys move between swatches, Enter applies (FR-018).
18. Press Escape. → The bar closes, document unchanged.

### Refusals and edges

19. Caret only, no selection. → No bar (FR-002).
20. Select inside a fenced code block, and inside inline code. → No bar in either (FR-002).
21. Select from inside a math block out into the prose after it. → Treated as prose, and the `$$`
    delimiters are **not** swallowed into the highlight.
22. With the bar open, edit the file externally (touch it from another editor). → The bar closes
    without writing (FR-017).
23. Hand-edit a `#rrggbb` in the file to a colour not in the palette, then select it. → It renders
    as written and the bar shows **no** active swatch — it is not rewritten.

## Before calling it done

- [ ] `vp check`, `vp test` pass
- [ ] `cargo test`, `cargo clippy`, `cargo fmt --check` from `apps/desktop/src-tauri/` (unchanged by
      this feature, but they are the gate)
- [ ] `CHANGELOG.md` updated (Constitution V)
- [ ] `docs/editor.md` gains the validate-before-write rule — it owns editor-extension rules
- [ ] `docs/keyboard-shortcuts.md` updated **only if** a shortcut was bound (FR-018)
- [ ] `TODOS.md:5` moved to Done
