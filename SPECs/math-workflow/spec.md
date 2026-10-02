# Math workflow

Nine features that make derivations — the dominant pattern in the user's
vault (one `$$` block per step, each an edited copy of the previous) —
faster to write and safer to trust.

## Observed note style (from the user's Obsidian vault)

- Derivations are chains of `$$` blocks, one step each, under `### Ex.N`
  headers.
- `*` is typed for multiplication, `j` is the imaginary unit, solutions are
  collected into `\begin{bmatrix} … \\ … \end{bmatrix}` columns.
- `\;` is used as a matrix _column_ separator (`2\;1\;0\;4\;6`), which KaTeX
  renders as one spaced cell — almost certainly not the intent.
- Intermediate results are written as decimals (`=1.543`,
  `= 2660-2565*j`), so wrong arithmetic ships silently.

## FR-1 Continue step — `Mod-Enter` inside math

Inside a `Math` node (inline or display), `Mod-Enter` closes the current
formula, opens a new `$$` block below separated by a blank line, copies the
current formula into it, and leaves the caret at the end of the copy. One
undo step. Outside math it falls through to the usual `Mod-Enter` handling
(insert line below). Single caret only; suppressed while Vim is not in an
insert-like mode.

## FR-2 Enter at the end of a display formula opens the next step's block

With the caret inside a `$$ … $$` block, on its last content line with only
whitespace between the caret and the closing `$$`, and _not_ inside an
unclosed `\begin{…}` environment (those belong to `latex.matrix-rows`), a
plain `Enter` closes the block and opens a fresh `$$\n\n$$` below with the
caret on the empty content line. Mid-formula Enter is unchanged. Both this
and FR-1 sit behind `latex.derivation-steps` (default on).

## FR-3 `$` autopair

`$` joins the CodeMirror close-brackets set: typing `$` inserts `$$` with
the caret between; typing the closing `$` steps over it. This only
autopairs in the default text context — inside existing math, strings, and
comments it stays literal, and the existing `mk`/`dm` snippets are
untouched.

## FR-4 Math: tidy notation (command)

Command on the enclosing Math node (or every Math node intersecting a
selection):

- inside a delimited matrix environment (`pmatrix`, `bmatrix`, `Bmatrix`,
  `vmatrix`, `Vmatrix`, `matrix`, `smallmatrix`, `cases`, `dcases`,
  `rcases`), the spacing commands `\;` `\,` `\:` used between row elements
  become `&`;
- a `*` between operands becomes `\cdot` — except the conjugate forms
  `^*`, `^{*}`, and a `*` directly after `^` or inside a `^{…}` exponent
  group, which stay.

Nothing else is touched. Zero changes → a notice says so; otherwise the
notice reports the count. One undo step. Palette entry + Math context
submenu.

## FR-5 Math: align steps / split into steps (commands)

`math.align`: find the run of `$$` blocks around the caret — consecutive
display-math blocks separated only by blank lines — and rewrite them as one
`$$\begin{aligned}…\end{aligned}$$` block. Each step becomes one row; the
first top-level `=`/`\implies`/`\equiv`/`\approx`/`\leq`/`\geq`/`\neq` in
the step (outside `\begin…\end` and braces) gains a leading `&`. Steps
without a relation go in unchanged. `\\` inside nested environments is left
alone.

`math.split`: a formula consisting only of an aligned-family environment
(`aligned`, `alignedat`, `align`, `align*`, `gathered` or `split`) is
rewritten back into one `$$` block per row, with top-level `&` markers
stripped. Surrounding expressions, sibling environments and other wrappers
cause refusal, preserving the whole source. Nested rows/cells stay intact.
Every resulting formula must render in display mode before the single
transaction is dispatched; one invalid row leaves the document untouched.

Both refuse with a notice when no run/env exists at the caret.

## FR-6 Evaluate constant formulas (annotation)

`math-eval.ts`: a strict evaluator for a subset of LaTeX — numbers,
`+ - * / \cdot \times \div`, juxtaposition, `^{…}`/`^x`, `\frac`,
`\sqrt{…}`, `\sqrt[n]{…}`, parentheses including `\left( \right)`,
`\sin \cos \tan \arcsin…`, `\sinh \cosh \tanh` + `^{-1}` inverses,
`\exp \ln \log`, `\lvert…\rvert`/`|…|` abs, `\pi`, `e`, and `i`/`j` as the
imaginary unit (complex arithmetic, `a+bj` display). `\%`, `\text`,
environments, `\\`, unknown commands, and any letter that is not a known
constant mark the formula as _open_ — it is skipped entirely.

Every rendered Math widget whose formula is closed gets a muted ` ≈ value`
annotation appended; a single top-level `=` with two closed sides gets `✓`
when both sides agree (relative epsilon) and `✗` with both values in the
tooltip. Results memoize per formula string. Behind `latex.eval-annotations`
(default on).

## FR-7 Math: check step (command)

`math.check`: compares the caret's `$$` formula with the previous `$$`
block in the same run. Each formula reduces to `lhs − rhs` (or the whole
expression with no `=`); free variables get deterministic sample values
(three trials). All trials within epsilon → "looks equal (numerically)";
any trial outside → "differs", with the counterexample values in the
notice. Unparseable or open-ended formulas report why. Deliberately
numeric, not symbolic — it catches dropped signs and bad arithmetic, which
is what actually goes wrong in these notes.

## FR-8 ` ```plot ` fenced block

A `plot` code fence renders an inline SVG function plot:

    ```plot
    x^2 - 4
    sin(x)
    domain=-6:6
    ```

- Each non-empty line is an expression in `x` (a leading `y =`/`f(x) =` is
  stripped) or a `domain=a:b` / `range=a:b` setting. Multiple expressions
  draw multiple series.
- ~240 samples per series across the domain; non-finite or steeply jumping
  samples break the polyline (asymptotes stay gaps, not walls).
- Axes through 0 when in view, light tick labels, first series in
  `--accent`, the rest cycling the six formula-highlight palette colours.
- Same fold contract as math: selection inside the fence shows the source
  with the plot rendered above it; outside, the fence is replaced by the
  plot.
- Parse/eval failures render as an inline error line inside the widget,
  never a blank space.

## FR-9 Insert Math Symbol (palette intent)

`Cmd-Shift-M` (and the palette command "Insert Math Symbol") opens the
command palette in an `insert-symbol` intent: a searchable list of ~150
common LaTeX symbols — name, `\code`, and a live KaTeX-rendered glyph per
row. Selecting inserts the code at the caret; in prose it wraps the code in
`$…$`. Pure client-side table in `lib/math/symbols.ts`.

## Non-goals

- No symbolic CAS dependency (no nerdamer/mathjs). Checking is numeric
  sampling, stated as such.
- No new visual chrome: annotations reuse `--text-muted`, series reuse the
  existing palette, widgets reuse the math/mermaid fold contract.
- `.excalidraw.md` import, backlinks, frontmatter table views — noted,
  not part of this batch.

## Files

- `src/lib/math/` — `evaluator.ts`, `steps.ts`, `tidy.ts`, `align.ts`,
  `plot.ts`, `symbols.ts` (all pure, unit-tested)
- `src/components/editor-area/` — `math-commands.ts` (StateCommands),
  `plot-decorations.ts` (+`.css`), edits to `math-decorations.ts`
  (annotation), `latex-snippets-extension.ts` (Enter/Mod-Enter),
  `markdown-formatting.ts` (registry), `editor-context-menu.ts` (Math
  submenu), `command-palette/index.tsx` (commands + symbol intent)
- `shared/settings.schema.json` — `latex.derivation-steps`,
  `latex.eval-annotations`
- `shared/latex-snippets.default.js` — `sol`/`ans` solution-vector snippet
- `src/lib/prosemark-core/basicSetup.ts` — `$` in close-brackets set
