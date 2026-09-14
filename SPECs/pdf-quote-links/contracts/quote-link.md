# Contract: Quote Link Syntax

The user-facing, on-disk contract. It lives in the user's Markdown forever, so it is the
one thing here that cannot be changed later without breaking existing notes.

## Inserted text

A text quote:

```markdown
> The unexamined life is not worth living.

[[papers/apology.pdf#page=12&text=The%20unexamined%20life|apology.pdf p.12]]
```

A region quote (caption is placeholder text the user can edit — FR-016):

```markdown
> Figure 3 — decay curve

[[papers/apology.pdf#page=14&rect=0.12,0.31,0.44,0.18|apology.pdf p.14]]
```

Read in any other editor this is a blockquote and a link naming the PDF and page —
SC-007 and Principle I satisfied with no custom block and no HTML.

## Grammar

```
link      := "[[" path "#" params ("|" alias)? "]]"
path      := workspace-relative path, ".pdf" extension retained
params    := "page=" digits ("&" (textParam | rectParam))?
textParam := "text=" percent-encoded snippet
rectParam := "rect=" num "," num "," num "," num
alias     := display text, e.g. "apology.pdf p.12"
```

**Rules**

- `page` is 1-based and always present.
- Exactly one of `text` or `rect` is present. Neither → the link is a plain page link and
  resolves to the top of that page with no highlight.
- `text` is percent-encoded and truncated to 120 characters. It is a _re-find hint_
  (FR-019), not the quote itself — the blockquote above holds the full passage.
- `rect` components are fractions of the page's unrotated crop box, `x,y,w,h`, each in
  `[0,1]`, at most 6 significant digits (FR-020).
- The path is **always workspace-relative and extension-qualified**. This is required:
  bare-stem resolution cannot find PDFs, because the fuzzy index is Markdown-only
  (research.md R3). Writer generates these links, so it always emits the qualified form.
- `|` inside `text` or the alias is escaped `\|`, matching `lib/wiki-links.ts`.
- `]` may not appear unescaped anywhere — it would terminate the link.

## Parsing

`parseWikiLink` in `lib/wiki-links.ts` already splits alias and fragment and needs no
change. `lib/pdf-anchor.ts` parses the fragment into a `PdfAnchor`.

A fragment that does not parse (unknown key, bad number, out-of-range rect) resolves to the
recorded page **with no highlight**, and reports that the anchor was unreadable. It must
never paint a guessed region — Principle IV, and FR-025's rule against highlighting the
wrong thing.

## Compatibility

`[[file.pdf]]` with no fragment is valid and opens the PDF at page 1. Unknown future
parameters are ignored rather than failing the link, so a note written by a later version
still opens here at the right page.
