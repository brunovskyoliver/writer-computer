# Contract: The `pdf` Page Kind

What the registry requires, and what this kind must do to be a well-behaved surface.
Source of truth for the interface: `components/editor-area/page-kinds/types.ts`.

## Behavior entry (`page-kinds/pdf.ts`)

| Member                    | Value                                 | Why                                                                                                                                                                                              |
| ------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kind`                    | `"pdf"`                               | Map key and session `kind` tag                                                                                                                                                                   |
| `title`                   | filename stem                         | FR-002 — no title extraction from contents                                                                                                                                                       |
| `description`             | `"Open PDF"`                          | Command-palette subtitle                                                                                                                                                                         |
| `keepAlive`               | `true`                                | Matches `drawing`. Re-parsing a large PDF on every tab switch would break SC-001's spirit.                                                                                                       |
| `supportsFileContextMenu` | `false`                               | FR-002 — no note-only actions on a PDF                                                                                                                                                           |
| `fromPayload`             | path required, `page` defaults to `1` | Restores the tab at its page (FR-005)                                                                                                                                                            |
| `paths`                   | `[path]`                              | Rename/delete rewriting and session restore see the file                                                                                                                                         |
| `primaryPath`             | `null`                                | **Load-bearing.** A PDF is not an open file. Publishing it would hand it to the markdown editor mount, the save scheduler and the statusbar.                                                     |
| `rewritePath`             | path match → new path                 | Renamed PDF keeps its open tab (FR-027, tab half only)                                                                                                                                           |
| `removePath`              | path match → `null`                   | Deleted PDF closes its tab                                                                                                                                                                       |
| `serialize`               | `{ path, page }`                      | Session payload. `page` is the only mutable location field in the registry — see data-model.md for the two rules governing its write-back (never a nav-history push; coalesced, not per-scroll). |

## View entry (`page-kinds/views.tsx`)

`{ Component: PdfPane }`. No `renderFooter` — a PDF has no word count, frontmatter or
document date, exactly as `drawing` has none.

`PdfPane` receives `isVisible` and `isFocused` separately and must respect the difference:
several panes are visible at once but only one is the keyboard target. A visible but
unfocused viewer must not steal the caret or run focus effects, or panes fight.

## Registration

Two one-line edits, and nothing else in the registry changes:

- `page-kinds/index.ts` — add `pdfKind` to the `kinds` tuple and `PdfLocation` to the
  `Location` union.
- `page-kinds/views.tsx` — add the `pdf` view entry.

## The standalone-surface predicate (prerequisite refactor)

Before this kind is added, `editor-store.ts` must ask the registry rather than the path.
The concept — _opens as its own surface, reused if already open, never enters `openFiles`_ —
is `primaryPath(location) === null`.

Required behavior after the refactor, verified per site (research.md R4):

- `locationForPath` dispatches `.pdf` → `{ kind: "pdf", path, page: 1 }`.
- `ensureFileLoaded` drops any location whose `primaryPath` is `null` from `openFiles`.
- `openFile`'s `activeTab?.location.kind === "file" || isDrawingPath(path)` keeps its left
  half unchanged; only the right half becomes the registry predicate.
- `navigateToFile`'s reuse branch matches on **the location built from the path** — same
  `kind` _and_ same `path` — not on a boolean. Matching on a boolean is the specific bug
  that would let PDFs open twice while drawings kept working.
- **Branch ordering is load-bearing.** The standalone-surface branch must stay _above_
  `navigateToFile`'s `if (!activeTab) { openFile(...); return; }` guard, exactly where the
  drawing branch sits today. `openFile` routes standalone surfaces to `navigateToFile`; if
  `navigateToFile` then falls through to the `!activeTab` guard it calls `openFile` again.
  Reordering these two produces an infinite bounce when a PDF is opened into an empty
  window. Drawings are safe today only because the branch returns first.

**Acceptance for the refactor**: every existing drawing behavior is unchanged, and adding a
future kind requires touching `locationForPath` only.

## Invariants

- The PDF file is opened read-only and never written (FR-011). No code path in this kind or
  its view calls a write command.
- PDF text is never added to the workspace index or search (FR-006) — already true, since
  `commands/search.rs` filters to `.md`.
- Page rendering and text extraction run in the pdf.js worker (FR-010).
