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

- inside a matrix cell environment (`pmatrix`, `bmatrix`, `Bmatrix`,
  `vmatrix`, `Vmatrix`, `matrix`, their starred variants, `smallmatrix`,
  `array` or `subarray`), the spacing commands `\;` `\,` `\:` used between
  row elements become `&` only at that body's cell level, outside brace
  groups, nested environments, recognized optional command arguments and
  comments. Array/subarray column specifications and optional array/matrix
  arguments stay intact; incomplete specifications are not scanned.
  `cases` and aligned environments keep their
  deliberate spacing. Nested matrix bodies rewrite each source separator once;
- a `*` between plausible operands becomes `\cdot`. Conjugate stars,
  complete superscript groups, starred command suffixes, environment names,
  column specifications, text/operator-name arguments and known metadata
  arguments (including URLs) stay unchanged. Comments between commands or
  superscripts and their argument groups do not break protection. Unknown starred macros and their immediate
  argument groups also stay unchanged;
- unescaped `%` comments keep their contents; commented braces do not affect
  protected argument boundaries.
  Escaped percent signs remain literal.
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
imaginary unit (complex arithmetic, `a+bj` display). Superscripts follow TeX
token boundaries: an unbraced digit or letter is one token; multi-token
exponents need braces. Bare pi/fraction script nuclei are supported, while
roots/grouping and nested fraction arguments need braces. Unsupported tokens
and repeated superscripts stay open. Bare multi-letter function/pi aliases
are reserved for plot syntax; TeX uses explicit control commands. `\%`, `\text`,
environments, `\\`, unknown commands, and any letter that is not a known
constant mark the formula as _open_ — it is skipped entirely.

A zero base with a finite positive real exponent evaluates to zero, including
roots and inverse-function boundary cases. The existing `0^0 = 1` convention
remains; undefined negative or complex zero powers stay open.

Every rendered Math widget whose formula is closed gets a muted ` ≈ value`
annotation appended. Formatting trims fractional zeros while preserving
integer place values and scientific exponents, including complex components.
A single top-level `=` with two closed sides gets `✓`
when both sides agree (relative epsilon) and `✗` with both values in the
tooltip. Results memoize per formula string. Behind `latex.eval-annotations`
(default on).

## FR-7 Math: check step (command)

`math.check`: compares the caret's `$$` formula with the previous `$$`
block in the same run. Two bare expressions compare their numeric values
within relative epsilon. Two single equations compare `lhs − rhs` residuals
up to a constant nonzero factor, allowing transformations such as
`2x = 6` to `x = 3`. Mixed expression/equation inputs and equation chains
report unsupported rather than a result. Free variables get deterministic
sample values. Equality requires three usable finite comparisons (one for
closed inputs), trying up to eight candidate assignments past singularities.
Equation scaling ratios must be finite and nonzero. Insufficient evidence
reports indeterminate; a counterexample reports "differs" with its values. Unparseable or open-ended formulas report why. This is a numeric
check, not a symbolic proof.

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
- `x = c` (any constant expression, e.g. `x = pi/2`) draws a vertical line.
- One expression in `x` and `y` (e.g. `T(x,y) = 20*sinh(pi*y)*sin(pi*x)/sinh(pi)`)
  draws an 80×46 heatmap under the curves: accent opacity scales from the
  sampled minimum to the maximum, and the min … max is printed top-right.
  `range=` sets its y extent; without it the y axis mirrors `domain`. A second
  x,y expression is an error line.
- Plot expressions use ordinary signed, multi-digit, right-associated powers
  (`x^12`, `2^3^2`), separate from TeX superscript token rules.
- ~240 samples per series across the domain; non-finite or steeply jumping
  samples break the polyline (asymptotes stay gaps, not walls).
- Axes through 0 when in view, light tick labels, first series in
  `--accent`, the rest cycling the six formula-highlight palette colours.
- Typing a word on a fence body line suggests the plot functions (`sin`,
  `sinh`, `sqrt`, … — accepting inserts `name()` with the caret inside),
  `pi` and `e`; at the start of a line it also suggests `domain=`, `range=`,
  `x =`, `y =` and `T(x,y) =`. Nothing is suggested on the info line or
  outside a `plot` fence (`plot-completion.ts`).
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
