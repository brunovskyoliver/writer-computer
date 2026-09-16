# Phase 1 Data Model: Color Highlights in Formulas and Prose

**Nothing here is persisted as a record.** The document _is_ the store (FR-003, Constitution I), so
these are value types that exist between a selection and a `view.dispatch`, plus one static table.
No schema, no migration, no identity.

---

## PaletteColour — the one static table

The single source of truth for the feature (FR-014, Constitution III). Lives in
`lib/highlight/palette.ts`. See [contracts/palette.md](./contracts/palette.md) for the entries.

| Field  | Type               | Notes                                                                                                   |
| ------ | ------------------ | ------------------------------------------------------------------------------------------------------- |
| `id`   | `string`           | Stable, kebab-case. Used by the command palette and any future shortcut. Never written to the document. |
| `name` | `string`           | Shown in the bar and read by screen readers.                                                            |
| `hex`  | `` `#${string}` `` | Lowercase `#rrggbb`. **This is what lands in the file**, in both emitted forms.                         |

**Validation**

- `hex` matches `/^#[0-9a-f]{6}$/`. Enforced by a test over the whole table, not by a comment.
- `id` is unique across the table.
- Each `hex` clears the contrast threshold against both the light and the dark editor background
  (SC-006), asserted by the same test.

**Why no theme-aware value**: a CSS variable does not exist in Obsidian or on GitHub. Constitution I
forces a literal. Consequence recorded in research R6.

---

## HighlightContext — derived, never stored

Produced by `mathContext(state, pos)` (`lib/latex-snippets/math-context.ts`), collapsed to the two
cases this feature emits for:

```
"math"   ← mathContext kind is inline | display | text
"prose"  ← mathContext kind is prose
refused  ← mathContext kind is code, or the two ends of the selection disagree
```

**State transitions**: none. It is recomputed from the document on every selection change and again
at press time (FR-017). It is never cached across a document change.

**Rules**

- Computed for **both ends** of the selection; they must agree. A selection starting in math and
  ending in prose is refused rather than guessed at, so math delimiters are never swallowed into a
  highlight (spec edge case).
- `code` in either end means no bar appears at all (FR-002).
- `text` (inside `\text{…}`) counts as math: the content still sits inside the math block, where an
  HTML span would not render.

---

## Highlight — a range and a colour, with no identity

What the user perceives and what the emitters read and write. Never instantiated as a stored object;
it is the shape passed from the bar to the write path and back out of the detector.

| Field        | Type                               | Notes                                                                                             |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `from`, `to` | `number`                           | Document positions of the **inner text** — the glyphs that get the colour, excluding the wrapper. |
| `colour`     | `PaletteColour \| { hex: string }` | A palette entry when the document's hex matches one; a bare hex when it does not.                 |
| `context`    | `"math" \| "prose"`                | Which wrapper surrounds it.                                                                       |

**Rules**

- **No identity, no name, no stored link to any other highlight.** Sameness of colour is the entire
  mechanism the reader gets (spec, Key Entities). Nothing in the codebase may add a cross-reference.
- **Unknown colour**: a hex present in the document but absent from the palette is rendered exactly
  as written, and the bar shows _no_ active swatch. It is never silently rewritten to the nearest
  palette entry (spec edge case).
- **Never nested, structurally.** KaTeX accepts a nested `\textcolor`, so validation will never
  refuse one — FR-013 cannot be enforced by checking. Instead every write **normalises first**:
  strip every Writer wrapper intersecting the union of the selection and the highlights it touches,
  then re-emit over the resulting plain text. Nesting becomes unrepresentable rather than merely
  avoided.
- **Partial overlap is defined, not refused.** The normalise step emits up to three regions — old
  colour on the leading remainder, new colour on the selection, old colour on the trailing
  remainder — giving the spec's "one highlight per region and no unbalanced or orphaned markup".
  Fully-inside is the same code path with both remainders empty, so the FR-013 recolour is not a
  special case. All of it is one dispatch, hence one undo step (FR-011). See research R8.
- **Additive wrapper**: the emitted text inserts a prefix and a suffix and alters nothing between
  them, which is what makes byte-exact removal (FR-012, SC-005) a property of the format rather than
  a best effort.

---

## AppliedRange — the outcome of the math safety rule

Returned by `expandAndValidate` in `lib/highlight/math-range.ts` (FR-008, FR-009). Not stored; it is
consumed by the write path and then discarded.

```
{ ok: true;  from: number; to: number; expanded: boolean }
{ ok: false; reason: string }
```

The range is chosen by walking an ordered ladder — exact selection, trimmed, brace-balanced
widening, enclosing group with its owning command — and accepting the first entry that clears both
three syntactic guards (no leading `^`/`_`, brace depth returns to zero, no trailing lone `\`) and
`katex.__parse`. The guards are required, not belt-and-braces: `\textcolor{c}{^2}` parses while
meaning the wrong thing.

- `expanded: true` means the written range differs from what the user selected, and the caller
  **must** make that range visible to the user — FR-008 requires the user can see what was actually
  coloured.
- `ok: false` means the document is left untouched and `reason` goes to `showEditorNotice`
  (FR-009, Constitution IV). It is never downgraded to a silent no-op and never to a write that
  breaks rendering.

The full algorithm and the evidence behind it are in [research.md](./research.md) R2.
