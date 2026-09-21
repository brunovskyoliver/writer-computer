# Open Without Replace Spec

## Summary

`openFile` currently delegates to `navigateToFile` whenever the resolved pane's
active tab holds a Markdown file — so every "open" route (sidebar click,
universal search, content search, drag-drop, MCP `open_file`, palette create)
can silently replace the document the user is looking at. `openFile` becomes a
non-destructive open: focus an existing tab showing the file, or open a new
tab in the resolved pane. In-place navigation stays the private behaviour of
`navigateToFile`, which link-following keeps using.

## Problem

In `editor-store.ts`, `openFile` reuses the active file tab by navigating it
in place. The tab keeps its id but its location moves, so the file the user
was reading disappears with no tab-level trace (the previous location lands
in `back` history, but the user asked for an open, not a navigation).
Affected routes: sidebar tree/pinned/recents clicks, `Cmd+P` file results,
content-search activation (`openSearchMatch` calls `navigateToFile`), palette
create-file/create-drawing routes, Finder drops, startup payloads, and MCP
`open_file` without `new_tab`.

## Rules

`openFile(path, target)` for a Markdown path now means:

1. The resolved tab is a launcher → fill it (`replaceTabWithFile`), same as
   today. A launcher holds no file, so nothing is lost; the existing
   duplicate-on-launcher behaviour is unchanged.
2. The path is a standalone surface (drawing, PDF) → `navigateToFile`'s
   existing rule: focus a tab showing it, else open a new tab. Unchanged.
3. Some tab already shows the file → focus that tab. Never a duplicate from
   an open route; `openFileInNewTab` remains the explicit duplicate.
4. Otherwise → a new tab in the resolved pane. The currently open file keeps
   its tab.

`navigateToFile` is unchanged: following a link inside a document is a
_navigation_, recorded in tab history for Back/Forward. The two verbs now
mean what they say — `openFile` never moves a file tab's location.

`openFile` returns the `Tab` that ended up showing the file (or `null` when
the open did not land), so callers that need the destination id get it
deterministically instead of re-finding it by path.

## Content-search handoff

`openSearchMatch` stops calling `navigateToFile`:

- A tab already showing the file → focus it; apply the line target to its
  live view, or queue a pending target when the view has not mounted yet.
- Not open → `openFile(path, { pendingTarget })`; the store queues the
  pending line target on the freshly minted tab inside the same `set` that
  publishes it — the rule `revealPdfAnchor` established: a pane mounting in
  the same commit must already find its target.
- `OpenTarget` gains `pendingTarget?: PendingTarget`. It is applied on the
  launcher-fill and new-tab branches only — dedupe-focus drops it (the
  caller's own live-view branch covers that case), and it is meaningless for
  standalone surfaces (PDFs carry `page=N&text=` anchors through the PDF
  anchor store instead).

## Files Expected To Change

- `apps/desktop/src/stores/editor-store.ts` — `openFile` rewrite, `OpenTarget`
  field, `Promise<Tab | null>` return
- `apps/desktop/src/hooks/editor-api.ts` — `openSearchMatch` rework
- `apps/desktop/src/lib/pending-anchor.ts` — `setPendingTarget` taking the
  union type
- `docs/mcp-server.md` — `open_file` semantics note
- `apps/desktop/tests/` — open-semantics tests

## Acceptance Criteria

- No open route (sidebar, palette, universal/content search, drop, MCP,
  startup) replaces the file showing in a pane's active tab.
- Re-opening an open file focuses its existing tab instead of duplicating.
- Content-search results still land on the matched line, including into a
  newly created tab.
- Link clicks still navigate in place with working Back/Forward.
