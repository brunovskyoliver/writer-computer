# Phase 0 Research: Color Highlights in Formulas and Prose

Every decision below was checked against the installed code or the installed library, not
recalled. Commands that produced the evidence are included so they can be re-run.

---

## R1 — How the colour reaches the rendered formula

**Decision**: Write `\textcolor{#rrggbb}{fragment}` into the document. Leave `renderMath`'s
`trust: false` untouched.

**Rationale**: `\textcolor` is a core KaTeX command, not a trust-gated one. Verified against the
installed KaTeX 0.16.47:

```
$ node -e "…katex.renderToString('\\textcolor{#e0a000}{\\cos(4*1.190)}', {throwOnError:true, trust:false})"
hex textcolor: OK
named:         OK
```

This satisfies FR-010 directly: the colour needs no renderer capability that would let document
text emit markup or links, so `\href`/`\htmlClass` stay refused. `math-renderer.ts` already
documents why `trust: false` matters for documents that arrive from external vaults and repos —
this feature does not weaken it.

**Alternatives considered**:

- `\color{#hex}` — switches colour for the rest of the group rather than wrapping an argument.
  It leaks past the fragment and has no natural end, making removal (FR-012) ambiguous. Rejected.
- `\colorbox` / `\bbox[background]` — a background box. Rejected by the spec itself (FR-004): it
  would force the fragment to be re-enterable as standalone math, which a lone exponent or half a
  fraction is not, making the refusal path the common case.
- KaTeX `macros` or a CSS class over the rendered output — the colour would live outside the file,
  breaking FR-003 and Constitution I.

---

## R2 — The balanced-expansion rule (FR-008/FR-009)

**Decision**: a short **ordered ladder of structural candidate ranges**, each screened by three
cheap syntactic guards and then adjudicated by `katex.__parse`. The first candidate that passes
both is written; if none does, the document is left untouched and a notice is shown (FR-009).

`__parse` is a _validator_, not a structure oracle — it answers yes/no on a candidate and cannot
hand back "the enclosing group" of an arbitrary character range. So the ladder has to name its
candidates. It does, and it is four entries long:

| #   | Candidate                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| C0  | the user's exact range                                                                                                                   |
| C1  | C0 trimmed of leading and trailing whitespace                                                                                            |
| C2  | C0 widened left over a partial control sequence and right until brace depth returns to zero                                              |
| C3  | the contents of the enclosing `{…}` group, widened left over an owning command name (`\frac`, `\sqrt`) and over any `^`/`_` and its base |

Locating C2 and C3 needs a **brace-depth counter over the formula string** — roughly fifteen lines
that count `{` and `}`. That is not a second LaTeX parser and does not become one: it never learns
command arity, `\left`/`\right`, or environments, because it does not have to. `__parse` owns
every one of those judgements.

### The guards, and why the ladder cannot skip them

**"First candidate that parses" is not safe on its own.** Verified:

```
x^\textcolor{c}{2}     err       ← the raw selection, correctly refused
\textcolor{c}{^2}      PARSES    ← WRONG: a superscript with no base, silently accepted
\textcolor{c}{x^2}     PARSES    ← right
```

A naive widening loop would stop at the middle line and colour something the user did not mean.
Three guards, applied before `__parse` sees a candidate, close it:

1. The candidate must not begin with `^` or `_` — an operator torn from its base.
2. Brace depth must return to zero and never go negative inside the candidate.
3. The candidate must not end mid-escape (a trailing lone `\`).

Checked against the ladder's real inputs:

| Candidate                           | Guard                                        |
| ----------------------------------- | -------------------------------------------- |
| `^2`                                | rejected — starts with `^`                   |
| `x^2`                               | pass                                         |
| `a}{b`                              | rejected — unbalanced                        |
| `{a}`                               | pass (then `__parse` refuses it — see below) |
| `\cos`, `\co`, `a+b`, `\sqrt{ 24 }` | pass                                         |

The guards are deliberately _syntactic and few_. They exist only to kill candidates that parse but
mean the wrong thing; everything else is KaTeX's call.

### The ladder walked on the hard case

`\frac{a}{b}+1`, user selects `a`:

```
C0  \frac{\textcolor{c}{a}}{b}+1        PARSES → written. Correct.
```

`\frac{a}{b}+1`, user selects `{a}` (braces included):

```
C0/C1  \frac\textcolor{c}{{a}}{b}+1     err    (\frac's first argument becomes \textcolor)
C2     same                               err
C3     \textcolor{c}{\frac{a}{b}}+1      PARSES → written, expanded, shown to the user.
```

Note what did **not** happen: the intermediate widenings `\frac\textcolor{c}{{a}{}b}+1` and
`\frac\textcolor{c}{{a}{b}}+1` both fail to parse, so a character-at-a-time loop would have
walked through them harmlessly — but only by luck. The ladder does not rely on that luck.

**Rationale**: this is the correction to the spec's assumption. The "existing LaTeX source parser"
(`latexSourceLanguage`, `components/editor-area/latex-highlighting.ts`) is a flat `StreamLanguage`
tokenizer producing six token classes with **no nested structure** — it physically cannot report
whether a range is a balanced group. The assumption's intent (introduce no new parser) is
satisfied better by the parser already in the bundle.

The empirical result is decisive. Every case the spec calls out behaves correctly under
`throwOnError: true`, and expansion rescues each failure:

| Case                                | Raw selection                                                                            | After expansion                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------- |
| Unmatched parens — spec scenario 3  | `(\sqrt{24})^4(\textcolor{c}{\cos(4*1.190})+1)` → **OK**                                 | not needed                                |
| `\sqrt{ 24 }` boundary — scenario 4 | crosses `}` → **ERR**                                                                    | `(\textcolor{c}{\sqrt{ 24 }})^4` → **OK** |
| Split control sequence              | `\textcolor{c}{\co}s` → **ERR** (`Undefined control sequence: \co`)                      | `\textcolor{c}{\cos}(x)` → **OK**         |
| Bare superscript                    | `x^\textcolor{c}{2}` → **ERR** (`no arguments as superscript`)                           | `\textcolor{c}{x^2}` → **OK**             |
| `\frac` argument                    | `\frac\textcolor{c}{{a}}{b}` → **ERR**                                                   | `\frac{\textcolor{c}{a}}{b}` → **OK**     |
| Already-coloured fragment nested    | `\textcolor{c}{a+\textcolor{d}{b}}` → **OK** — see R8, this is a hazard, not reassurance | n/a                                       |

Three consequences worth stating in the plan:

- **Unmatched parentheses never trigger expansion**, exactly as FR-008 requires — parens are
  ordinary characters to the parser, so the candidate simply parses.
- **Range expansion alone is sufficient.** `x^{\textcolor{c}{2}}` also parses, but reaching it
  requires _inserting braces outside the user's selection_. Expanding left to include the base
  (`\textcolor{c}{x^2}`) parses too and touches nothing the user did not select, which is what
  FR-008's "expansion MUST stop at the enclosing group" describes. **No brace insertion is
  needed anywhere**, so the write is always a pure wrap of a contiguous range.
- **KaTeX never refuses a nested wrapper** (last row above). FR-013's no-nesting rule therefore gets
  no backstop from validation and rests entirely on the detector running first. See R8.

**Alternatives considered**:

- Write a brace/group scanner by hand — ~60 lines that would then have to learn `\left(`…`\right)`,
  `\begin{}`…`\end{}`, `\frac` arity, and every other command's argument count. It would be a
  second, worse LaTeX parser sitting next to the real one. Rejected on Constitution II and VI.
- Optimistically write and let the widget show the error state — violates SC-002 and FR-009, which
  require the document to be left untouched rather than made unrenderable.

**Cost check**: `__parse` runs once (twice on the expansion path) per colour press — a user
gesture, not a keystroke — so it adds nothing to an interactive path.

---

## R3 — Deciding math vs prose (FR-007, FR-002)

**Decision**: reuse `mathContext(state, pos)` from `lib/latex-snippets/math-context.ts`.

**Rationale**: it already returns exactly the discrimination this feature needs —
`prose | code | inline | display | text` — with the delimiter edge cases solved (`side: -1` puts
the caret outside the node on the opening `$` and inside on the closing `$`), and it already
returns `code` for `InlineCode`, `FencedCode`, `CodeBlock` and `HTMLBlock`. That single call
delivers FR-002's code exclusion and the spec's "selection spanning out of a math block is treated
as prose" edge case for free.

The one addition: this feature must call it for **both ends** of the selection and require they
agree. A selection that starts in math and ends in prose is prose per the spec, and the math
delimiters must not be swallowed — checking both ends is how that is enforced.

`{kind: "text"}` (inside `\text{…}`) is treated as **math** for emission purposes: the content is
still inside the math block, so an HTML span there would not render. It goes through the same
validate-before-write path, which will accept or refuse it on its merits.

---

## R4 — The prose form, and how the editor shows it (FR-006, FR-015, FR-016)

**Decision**: `<span style="color:#rrggbb">text</span>`. Conceal the two tags with a
`hidableNodeFacet` entry keyed on `HTMLTag`.

**Rationale**: verified that this parser configuration emits addressable nodes for inline HTML:

```
$ node -e "parser.parse('text <span style=\"color:#e0a000\">frag</span> more')…"
Paragraph  "text <span style=\"color:#e0a000\">frag</span> more"
HTMLTag    "<span style=\"color:#e0a000\">"
HTMLTag    "</span>"
```

Two facts this establishes:

1. The open and close tags are **separate sibling nodes** with the inner text unwrapped between
   them. The concealment spec therefore matches the opening tag, scans forward for its partner, and
   emits three ranges: replace the open tag, `Decoration.mark` the inner text with the colour,
   replace the close tag.
2. A `<span>` at the **start of a line** still parses as `Paragraph` + `HTMLTag`, **not**
   `HTMLBlock`. This matters: `HTMLBlock` is in `mathContext`'s `CODE_NODES`, so had it been
   swallowed, the bar would have refused to reopen on the feature's own output and the recolour
   path (US3) would have broken on line-initial highlights. It does not.

Use `hideInlineReplaceDecoration` (`removeFromDOM`), not the `font-size: 0` mark. `hide/core.ts`
documents why: a collapsed bounding rect destabilises `view.coordsAtPos`, which this feature's own
bar depends on for placement.

`unhideZone` is set to the whole highlight (open tag through close tag) so the markup reveals as
one unit when the caret enters any part of it, which is what FR-016 describes.

**Alternatives considered**:

- `==highlight==` — the common Markdown convention, but it carries no colour, and multi-colour
  tracking is the entire point of the feature. Rejected by the spec.
- `<mark>` — semantically a background marker; FR-004 requires the colour on the glyphs.
- A CodeMirror-only decoration with no document text — breaks FR-003 and SC-004.

---

## R5 — The selection-anchored bar (FR-001, FR-017)

**Decision**: a new `highlight-bar.tsx` positioned from `view.coordsAtPos`, following
`pdf-quote-button.tsx`'s _rule_, not its code.

**Rationale**: `pdf-quote-button.tsx` is the precedent the spec names, and the rule worth copying is
explicit in its header — **resolve the target at press time, never at capture time**, because the
document can move between the selection and the press. That is FR-017 verbatim, and the same
failure mode applies here (an external edit, a watcher-driven reload).

But its _geometry_ comes from PDF.js text-layer rects in a scroll container; this bar anchors to a
CodeMirror selection. A grep of `editor-area` found no existing selection-anchored popover
(`coordsAtPos` appears only in scroll and block-quote measurement code), so there is no component
to reuse and no second popover pattern being invented — this is the first one in the editor.

Two constraints inherited from `docs/editor.md` and `hide/core.ts`:

- Measure inside `view.requestMeasure`, never directly in an update handler.
- Concealed markup must use replace-based hides (R4) or the measured rects drift.

---

## R6 — Palette size and colour choice (FR-014, SC-006)

**Decision**: six colours in one exported table in `lib/highlight/palette.ts`, each a literal
`#rrggbb` chosen for legibility on both the light and dark editor backgrounds.

**Rationale**: FR-014 and Constitution III both demand a single definition. The table is the source
for the bar's swatches, for what is written into the document, and for the detector that reads a
colour back out — adding a seventh colour must touch this file and nothing else, and a test asserts
each entry is a valid `#rrggbb` and clears a contrast threshold against both theme backgrounds
(SC-006).

A literal hex rather than a theme-aware CSS variable is forced by Constitution I: the file has to
render the same colour in Obsidian and on GitHub, where Writer's variables do not exist. The
consequence — stated plainly — is that the palette is tuned for _cross-theme adequacy_ rather than
maximum contrast on either theme alone. The spec already accepts this trade.

---

## R7 — Undo granularity and byte-exact removal (FR-011, FR-012, SC-005)

**Decision**: one `view.dispatch` per colour/recolour/remove action.

**Rationale**: CodeMirror's history groups a single transaction into a single undo step, so
FR-011 needs no custom annotation — it needs the discipline of never splitting a highlight action
across two dispatches. Recolour is one `changes` set replacing the old wrapper's colour argument
in place, not a remove followed by an apply.

Byte-exactness (FR-012/SC-005) follows from the wrapper being purely additive: the emitted forms
insert a prefix and a suffix and change nothing in between, so removal deletes exactly those two
ranges. A round-trip test — apply then remove, assert the string is identical to the original — is
the runnable check that guards it, and it is the cheapest possible guard for the strongest claim
in Success Criteria.

---

## R8 — Overlapping an existing highlight (FR-013 and the partial-overlap edge case)

**Decision**: normalise, then re-emit per region. Before any write, strip every Writer wrapper that
intersects the union of the selection and the highlights it touches, then emit up to three wrappers
over the resulting plain text: the old colour on the leading remainder, the new colour on the
selection, the old colour on the trailing remainder. One dispatch, so one undo step (FR-011).

**Rationale**: R2 showed that `\textcolor{c}{a+\textcolor{d}{b}}` **parses happily**. The validator
will never refuse a nest, so FR-013 has no safety net below the detector — it has to be structural,
not checked. Normalise-then-re-emit makes nesting unrepresentable rather than merely discouraged:
the write path only ever emits wrappers over text that carries none.

It also settles the spec edge case that the first draft of this plan left undefined — _"a selection
partially overlapping an existing highlight: the resulting text has one highlight per region and no
unbalanced or orphaned markup."_ The three-region emission is precisely "one highlight per region",
and because the union is stripped first, orphaned markup cannot survive.

The three cases collapse into one code path:

| Situation                                                    | Regions emitted                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| No overlap                                                   | new colour only                                                     |
| Selection exactly covers / sits inside an existing highlight | new colour only — this _is_ the FR-013 recolour, not a special case |
| Partial overlap                                              | old, new, old — whichever remainders are non-empty                  |

**Alternatives considered**:

- _Refuse partial overlap with a notice._ Smaller, but it contradicts the spec's stated edge case,
  which asks for one highlight per region rather than a refusal. Rejected: the spec is the authority
  and this is a gesture the user will make constantly while revising a derivation.
- _Remove, then apply, as two dispatches._ Breaks FR-011's single-undo-step requirement.

In math context each emitted region still goes through R2's ladder independently; a remainder that
cannot be re-wrapped safely fails the whole action under FR-009 rather than writing a partial
result.

---

## R9 — Two mechanism checks behind User Story 2

Both were run rather than assumed, because a wrong answer to either would have changed the file
list rather than a detail.

**`onHide` may return ranges outside the matched node.** `hide/core.ts` pushes an `onHide` result
straight into a flat array and finishes with `Decoration.set(decorations, true)` — the `true` sorts
them — so a spec that matches the _opening_ `HTMLTag` and returns three ranges spanning past the
close tag is handled correctly. The predicate must match the opening tag only, or every highlight
gets its decorations emitted twice.

**A span straddling a paragraph break does not pair.** Probed:

```
one <span style="color:#e0a000">start

end</span> two
```

```
Paragraph  "one <span …>start"
HTMLTag    "<span style=\"color:#e0a000\">"
Paragraph  "end</span> two"
HTMLTag    "</span>"
```

The open tag sits in one `Paragraph` and the close tag in another, so a partner scan inside the
block finds nothing and the concealment silently fails. This makes the contract's _one span per
paragraph_ rule **load-bearing rather than cosmetic**: Writer must never emit the straddling form,
and the multi-paragraph split in `document-format.md` is what guarantees the pairing scan always
succeeds on Writer's own output.
