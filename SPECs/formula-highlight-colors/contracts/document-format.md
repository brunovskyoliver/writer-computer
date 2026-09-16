# Contract: What Lands in the Markdown File

This is the feature's **only external interface**. Writer does not expose an API here — it writes
text into the user's file, and that file is opened by Obsidian, by GitHub, and by whatever the user
reaches for next. This document is the promise those readers depend on, and it is what SC-004 and
SC-005 test against.

Two forms, one per context. There is no third, and no fallback form.

---

## Math context

```
\textcolor{#rrggbb}{FRAGMENT}
```

- Written **inside** the `$…$` / `$$…$$` delimiters. The delimiters themselves are never touched
  and never enter the highlight.
- `#rrggbb` is lowercase, taken from the palette table.
- `FRAGMENT` is the document text of the applied range, byte-for-byte, unmodified.
- The wrapper keeps its content in math mode (FR-005), so the rendered output is identical to the
  uncoloured formula except for the colour of that fragment.
- Renders under KaTeX with `trust: false` — this form requires **no** renderer capability that
  would let document text emit markup or links (FR-010). Verified in research R1.

### The safety rule that governs what may be wrapped

Before writing, candidate ranges are screened by three syntactic guards and then parsed with
`katex.__parse`. The first candidate clearing both is written. The candidates, in order:

1. The user's exact range.
2. The same, trimmed of surrounding whitespace.
3. Widened left over a partial control sequence and right until brace depth returns to zero.
4. The enclosing `{…}` group, widened left over an owning command name and over any `^`/`_` and its
   base.

The guards — no leading `^` or `_`, brace depth returns to zero and never goes negative, no trailing
lone `\` — reject candidates that _parse but mean the wrong thing_. `\textcolor{c}{^2}` is the
worked example: it parses, and it denotes a superscript with no base.

If every candidate fails, **write nothing** and show a notice (FR-009). When the written range is
wider than what the user selected, the applied range is surfaced to them (FR-008).

Consequences that are part of this contract:

- Unmatched _parentheses_ never cause expansion — they parse fine.
- Expansion is always a **contiguous range widening**. No braces are ever inserted outside the
  user's selection; no character between `from` and `to` is ever altered. Confirmed against every
  spec scenario in research R2.
- A colour is never written that makes the formula fail to render (SC-002).
- **Wrappers never nest.** KaTeX would accept a nested `\textcolor`, so this is guaranteed by the
  write path rather than by validation: every write first strips the Writer wrappers intersecting
  the affected range, then re-emits over plain text. A selection that partially overlaps an existing
  highlight therefore yields adjacent wrappers — old colour, new colour, old colour — and never a
  nested or orphaned one (FR-013 and the spec's partial-overlap edge case).

### Example

Source:

```markdown
$$(2+5j)^4=(\sqrt{24})^4(\cos(4*1.190)+\sin(4*1.190)j)$$
```

After colouring `\cos(4*1.190)` amber:

```markdown
$$(2+5j)^4=(\sqrt{24})^4(\textcolor{#e0a000}{\cos(4*1.190)}+\sin(4*1.190)j)$$
```

---

## Prose context

```html
<span style="color:#rrggbb">TEXT</span>
```

- Inline HTML, which every CommonMark reader passes through to the rendered output — the text stays
  visible and coloured rather than showing as raw syntax (FR-006, SC-004).
- The colour is on the glyphs, not a background box (FR-004), matching the math form exactly.
- `TEXT` is the selected text byte-for-byte.
- A multi-paragraph selection produces **one span per paragraph**, never a single span across a
  block boundary (spec edge case). This is load-bearing, not stylistic: a span straddling a blank
  line parses as an opening `HTMLTag` in one paragraph and a closing one in the next, which the
  editor's pairing scan cannot match, so the concealment would silently fail. Verified in research
  R9.
- Overlap behaves exactly as in math: wrappers are stripped and re-emitted per region, never
  nested.
- Writer conceals both tags in the editor when the caret is outside them and reveals them when it
  enters (FR-015, FR-016). The concealment is a display decoration only; the file always holds the
  full markup.

---

## Removal is byte-exact

Both forms are **purely additive**: a prefix, the untouched original text, a suffix. Removing a
highlight deletes exactly the prefix and suffix ranges.

Therefore removing every highlight from a document returns the file **byte-for-byte** to its
pre-highlight state (FR-012, SC-005). This is a property of the format, not of the removal code —
which is why the round-trip test asserts string identity rather than approximate equivalence.

---

## Reading a highlight back

The detector recognises exactly these two forms. Anything else in the document — a hand-written
`\color{...}`, a `<span>` carrying other CSS, a `<mark>` — is **not** a Writer highlight, is left
strictly alone, and raises no bar state.

A recognised form whose `#rrggbb` is not in the palette is displayed as written, and the bar shows
no active swatch. It is never rewritten to the nearest palette colour (spec edge case).
