# Contract: Pending Line Target

How a text-file `SearchMatch` becomes a scroll position + selection in the
editor. Extends the existing `lib/pending-anchor.ts` handoff — the module that
already carries "where in the file should this tab land" across the async
open/swap gap.

## Payload

`PendingTarget` replaces the bare `string` the map holds today:

```text
PendingTarget =
  | { kind: "anchor"; slug: string }                      // existing heading links
  | { kind: "line"; line: number; offset: number;         // content-search matches
      length: number; needle: string }
```

- `line` — 1-based line number from the scan.
- `offset`, `length` — char units within that line (same units as
  `SearchMatch.match_ranges`).
- `needle` — the query text as scanned; the consume site re-finds it rather
  than trusting `offset` blindly, because the file may have changed on disk or
  in a dirty tab since the scan.

## Producer

`setPendingLineTarget(tabId, path, target)` — written before
`navigateToFile`, same rule `setPendingAnchor` follows: the handoff must exist
before the layout mutation that creates or reveals the tab.

## Consumer

The existing `consumePendingAnchor` site in `use-prosemark-editor`
(document-swap effect) returns a `PendingTarget`:

- `anchor` — unchanged: `findHeadingBySlug` → `scrollPosToSafeTop` → notice if
  missing.
- `line` — clamp `line` to `doc.lines`; resolve `doc.line(n)`; search that
  line's text for `needle` (first occurrence at or after `offset`, else the
  first occurrence on the line). Found → select that range and scroll it into
  view. Not found → scroll the line into view with no selection.

  The re-find, not blind offset application, is the spec's "re-resolves the
  location rather than jumping to a stale position". Landing on the clamped
  line with nothing selected is the graceful floor — never a wrong-range
  selection, never an error dialog for a file that merely moved on.

## Semantics kept from `pending-anchor.ts`

- Keyed by `(tabId, path)`; consumed exactly once; a later navigation
  overwrites, never replays.
- The selection on arrival _is_ the "match briefly highlighted" marking
  (research R7) — no timed decoration machinery is added.
