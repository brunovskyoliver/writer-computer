# Line-anchored relations + sparse suggestions (v2)

Delta spec on top of [spec.md](./spec.md). Request: suggestions should be far
sparser (≈2–3 items), and relations should point at _the place_ in another
note where the same content lives — "if I have a formula which is reused
somewhere else, a link to that note and the line it corresponds to."

## Decisions

- **Formula reuse is matched deterministically, not by embeddings.** LaTeX
  embeds poorly (see [research.md](./research.md) R9) and fuzzy matching
  produces exactly the noise the user is pushing back on. Two notes relate
  when they contain the _same normalized formula_. Exact-normalized matching
  is precise, explainable, free, and yields line anchors for free.
- **Normalization is token-level.** Formulas equal in TeX semantics compare
  equal: whitespace removed, no-op commands dropped (`\left`, `\right`,
  `\displaystyle`, `\limits`, `\nolimits`, spacing `\,` `\;` `\:` `\!` `\ `
  `\quad` `\qquad`, `\bigl` family), single-atom braces collapsed
  (`x_{i}` ≡ `x_i`, `mc^{2}` ≡ `mc^2`). Tokens join with a space separator
  so `\alpha x` ≠ `\alphax`.
- **Extraction**: `$$…$$` display blocks and `\[…\]` (multi-line ok), plus
  inline `$…$` only when formula-ish (contains `\`, `^`, `_`, or `=` and
  ≥8 normalized chars — keeps `$x$` and prices out). Skips frontmatter,
  fenced code, and inline code spans. Line numbers are absolute (1-based,
  frontmatter included).
- **Relations surface in two places**:
  - `ai_related` returns `RelatedItem {kind: "formula"|"similar", path,
line?, score?, snippet?}` — formula items first (strongest evidence),
    then top similar notes. The card renders formula rows as
    `name :line  snippet`; clicking opens the note _at that line_ via the
    existing line-target machinery (`openSearchMatch`'s landing path,
    extracted into `openFileAtLineTarget`; needle = first source line of the
    matched formula so `applyLineTarget` re-finds it if the line drifted).
  - `ai_graph` gains edge kind `formula` — a deduped note pair sharing ≥1
    normalized formula. Styled solid + accent (vs. link = subtle solid,
    similar = accent dashed).
- **Sparsity**: `SUGGEST_TAG_CAP` 8→3 (prompt asks for ≤3 most specific),
  `SIMILARITY_TOP_K` 3→2 + floor 0.55→0.6, `RELATED_TOP_K` 8→3 + floor
  0.3→0.5, formula items capped at 5 in the related list.
- **Sidecar v2**: `NoteEntry.math_blocks: Vec<MathBlock{normalized, line,
source}>`; `SIDECAR_VERSION` 1→2 — the old file is ignored and repopulates
  on the next scan (existing designed behavior). Formula matching needs no
  endpoint: it works with embeddings down and adds zero network traffic.

## Non-goals

- No semantic (embedding) matching of math blocks — revisit only if exact
  matching demonstrably misses too much.
- No writing `[[links]]` into notes — relations stay read-only suggestions.
- No `\begin{env}` standalone environments or `\(...\)` inline delimiters.

## Tasks

- [ ] Rust: `extract_math_blocks` + `normalize_math` + `formula_relations`,
      `MathBlock`/`RelatedItem` types, sidecar v2, caps, `Formula` edge kind,
      unit tests.
- [ ] IPC: `ai_related` → `RelatedItem[]`; `ai_graph` emits formula edges.
- [ ] Frontend: `RelatedItem` type, card groups (Shared formulas / Similar),
      `openFileAtLineTarget` extracted from `openSearchMatch`, graph edge
      styling for `formula`.
- [ ] E2E: seed a formula-sharing probe pair; assert `ai_related` returns a
      `formula` item with a line and the click lands on it.
- [ ] Checks + CHANGELOG + TODOS + commit.
