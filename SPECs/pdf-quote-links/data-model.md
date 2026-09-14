# Phase 1 Data Model: PDF Viewing, Highlighting and Quote Links

Shapes only. Field-level detail that crosses a boundary lives in `contracts/`.

## PdfLocation — the page-kind location

The registry entry. Mirrors `DrawingLocation`, plus the page the tab was last showing so
FR-005 (session restore at that page) is satisfied by `serialize`/`fromPayload`.

| Field  | Type     | Notes                                              |
| ------ | -------- | -------------------------------------------------- |
| `kind` | `"pdf"`  | Discriminator; registry map key                    |
| `path` | `string` | Absolute workspace path to the `.pdf`              |
| `page` | `number` | 1-based page last shown. Restored on session load. |

Validation: `fromPayload` returns `null` unless `path` is a string. A missing or
non-numeric `page` restores as `1` rather than failing the whole tab — a bad page number
is not a reason to lose the tab, and page clamping happens at open anyway.

**Why `page` lives in the location and not in tab view state.** Cursor and scroll live in
`lib/editor-views.ts`, keyed by `tabId`. That store documents itself as _"Runtime only —
never serialized, never in the store"_. FR-005 requires the page to survive quit and
relaunch, so view state cannot carry it; only the serialized location can.

**Mutation discipline — required, not optional.** `page` is the one mutable field on any
location in this registry, and locations are cloned into `back`/`forward` nav history
(`cloneTab`, `back: [...activeTab.back, activeTab.location]`). Two rules follow:

1. A page change is **not a navigation**. It updates the tab's location in place and must
   never push onto `back`/`forward`, or scrolling a PDF would fill the history with
   near-identical entries and break Back.
2. The write-back is **coalesced**, not per-scroll-event: update on settle (and on tab
   close / session save), not on every frame. An un-debounced write would clone the tab
   map on a scroll path — the added store churn on an interactive path that the
   Technology and Quality Constraints require be justified, and here it has no
   justification.

A page write that violates either rule is a defect, not a tuning question.

`primaryPath` stays `null`, exactly as `drawing` does: a PDF is not an open _file_. It must
never enter `openFiles`, never reach the markdown save scheduler, and never be published as
`activeFilePath`. `paths` still reports it so rename/delete and session restore see it.

## PdfAnchor — a location inside a document

A tagged union. Both variants carry `page`; only the text variant carries the quoted text.

**Text anchor**

| Field  | Type     | Notes                                                                                                                                                                          |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kind` | `"text"` |                                                                                                                                                                                |
| `page` | `number` | 1-based, where the selection _starts_ (spec scenario 2.3)                                                                                                                      |
| `text` | `string` | The quoted passage. Required by FR-019 — this is what re-finds the passage when pagination shifts (research.md R6). Truncated in the link; the blockquote holds the full text. |

**Region anchor**

| Field  | Type             | Notes                                                                                        |
| ------ | ---------------- | -------------------------------------------------------------------------------------------- |
| `kind` | `"region"`       |                                                                                              |
| `page` | `number`         | 1-based                                                                                      |
| `rect` | `{ x, y, w, h }` | Fractions in `[0,1]` of the page's unrotated crop box. Zoom- and DPR-independent per FR-020. |

Validation: `page >= 1`; every rect component finite and within `[0,1]` after clamping;
`w > 0 && h > 0`. A zero-area rect is rejected at capture (spec: "zero-width or accidental
selections" raise no button) and on parse (a malformed link must not paint a degenerate
highlight — Principle IV).

State transitions: none. An anchor is immutable once written into the note. Editing the
note's quoted text does not change the anchor (spec edge case: "the user edits the quoted
text in the note").

## Quote — what lands in the note

Not a runtime object; the Markdown text produced at insert time. One blockquote plus one
link, inserted as a single undoable edit (FR-017, scenario 2.4). Grammar in
`contracts/quote-link.md`.

## PdfDocument — the loaded document handle

Runtime only, owned by `lib/pdf.ts`. Never serialized.

| Field       | Type                      | Notes                                                 |
| ----------- | ------------------------- | ----------------------------------------------------- |
| `path`      | `string`                  | Identity within the cache                             |
| `proxy`     | pdf.js `PDFDocumentProxy` | Parsing/rasterizing lives in the worker               |
| `pageCount` | `number`                  | Used to clamp an anchor past the end (spec edge case) |

Load outcome is an explicit result, not a throw-or-empty: `{ ok: true, doc }` or
`{ ok: false, error }` distinguishing _corrupt_, _encrypted_ and _missing_ so FR-012 and
FR-026 can name the cause. This mirrors `DrawingLoadResult` in `lib/drawings.ts`.

Lifetime: cached per path while at least one PDF tab references it; destroyed when the last
tab closes. Rendered page canvases are held only for a window around the viewport, which is
what makes SC-003 (flat memory across a full scroll) hold.

## PdfView — an open PDF in a pane

Runtime view state keyed by `tabId`, matching how the editor keys cursor and scroll. The
same PDF open in two panes therefore keeps two independent views.

| Field           | Type                | Notes                                                                                              |
| --------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| `tabId`         | `string`            | View identity                                                                                      |
| `path`          | `string`            | Which document                                                                                     |
| `page`          | `number`            | Current page — coalesced write-back into `PdfLocation.page` for restore, under the two rules above |
| `zoom`          | `number`            | Scale factor                                                                                       |
| `pendingAnchor` | `PdfAnchor \| null` | Set by resolution; consumed by the pane on mount/scroll, then cleared                              |

`pendingAnchor` is the handoff between "a link was clicked" and "the viewer scrolled and
flashed". It is a one-shot: resolution writes it, the pane consumes and clears it. This
keeps resolution from needing a direct imperative handle on a component that may not be
mounted yet (FR-021 case c opens a _new_ pane), and keeps the flow race-safe without
relying on mount ordering — Principle IV's "explicit sequencing" over "incidental order".

## Resolution order (FR-021)

Given a clicked link's path and anchor, in the current window only (FR-028):

1. A pane already **showing** that PDF → reuse; set `pendingAnchor`. No new tab.
2. A **background tab** in some pane holding it → activate that tab; set `pendingAnchor`.
3. **Not open** → open in a split beside the note; set `pendingAnchor` on the new tab.

If the path does not exist, none of the above run: report the missing path (FR-026). This
check comes first so a stale link never creates an empty viewer.
