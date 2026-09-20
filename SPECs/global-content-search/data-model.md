# Data Model: Global Content Search

Entities for `global-content-search`. Rust-side types live in
`commands/search.rs`; frontend mirrors in `types/fs.ts` — the two are held to
the IPC contract in `contracts/content-search-ipc.md`.

## SearchMatch

One match occurrence — the unit of the results list, the preview, and
activation. One type covers both file kinds; `kind` discriminates the location
fields.

| Field           | Type              | Rules                                                                                                                                        |
| --------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`          | string (absolute) | Existing file at scan time; re-validated implicitly at activation (a stale path follows the normal open-failure path).                       |
| `relative_path` | string            | Workspace-root-relative, for display.                                                                                                        |
| `modified_at`   | u64 (unix secs)   | File mtime at scan time — the FR-014 sort key.                                                                                               |
| `kind`          | `"text" \| "pdf"` | Determines which location field is meaningful.                                                                                               |
| `line_number`   | u32 ≥ 1           | Text files: 1-based line of the match in the file. `null` for PDFs.                                                                          |
| `page`          | u32 ≥ 1           | PDFs: 1-based page where the match begins (a match spanning a page boundary reports the page it starts on). `null` for text.                 |
| `line_text`     | string            | The matched line — the full source line for text files; the matched extracted-text line for PDFs.                                            |
| `match_ranges`  | `[u32, u32][]`    | `[char_start, len]` pairs within `line_text`, in document order, non-overlapping. Char offsets (not bytes) so the frontend can slice safely. |
| `context`       | `ContextLine[]`   | ~5 lines centred on the match — see below.                                                                                                   |

### ContextLine

| Field         | Type   | Rules                                                                                              |
| ------------- | ------ | -------------------------------------------------------------------------------------------------- |
| `line_number` | u32    | Text files: absolute file line. PDFs: line index within the page's extracted lines (display-only). |
| `text`        | string | Raw line content; may be empty.                                                                    |

`context` contains the matched line itself plus up to ~2 lines before and ~2
after (~5 total). Fewer near file/page boundaries — never an error (spec edge
case). The preview renders `context` verbatim and marks `match_ranges` on the
matched line. PDF `context` is built by the frontend from the same extracted
page lines it searched, so preview and match can never disagree.

## PdfCandidate

Emitted by the walk for each `.pdf` file; the frontend's extraction queue.

| Field         | Type              | Rules                                                                                  |
| ------------- | ----------------- | -------------------------------------------------------------------------------------- |
| `path`        | string (absolute) | `.pdf` suffix, case-insensitive match on the filename — same predicate as `isPdfPath`. |
| `modified_at` | u64               | Sort key shared with `SearchMatch.modified_at`.                                        |

## ContentSearchEvent

The `Channel` payload enum (serde tagged).

| Variant   | Payload               | Meaning                                                                                      |
| --------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `matches` | `SearchMatch[]`       | A batch of text matches (per-file as the walk yields it).                                    |
| `pdf`     | `PdfCandidate`        | A PDF in the corpus, for the frontend to extract.                                            |
| `done`    | `{ truncated: bool }` | Scan finished; `truncated` is true when the per-file (~20) or text-total (~200) cap engaged. |

## Scan (frontend lifecycle, not serialized)

| Field       | Type                             | Meaning                                                                                                                  |
| ----------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `seq`       | number                           | Monotonic id per dispatched query — the FR-012 staleness guard.                                                          |
| `query`     | string                           | Raw input; empty → hint state, no scan.                                                                                  |
| `state`     | `"idle" \| "scanning" \| "done"` | `scanning` until the `done` event _and_ the PDF queue drains — the FR-015 "still searching" vs "no results" distinction. |
| `matches`   | `SearchMatch[]`                  | Merged, sorted by `modified_at` desc (document order within a file), display-capped at ~200.                             |
| `truncated` | bool                             | Any source overflowed — Rust `done.truncated`, unprocessed PDF candidates, or merged length over cap.                    |

### Scan state transitions

```text
idle ──query non-empty──▶ scanning ──done + pdf queue drained──▶ done
  ▲                        │
  │              query changed / palette closed
  │                        ▼
  └──────────────── superseded (seq invalid; Rust cancel flag flipped)
```

## PendingTarget (extends `lib/pending-anchor.ts`)

The tab-and-path-keyed handoff becomes a union; existing slug callers are the
`anchor` variant.

| Variant  | Fields                                                | Consumer behavior                                                                                                                                                                                                                                                          |
| -------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anchor` | `slug: string`                                        | Unchanged — `findHeadingBySlug` → `scrollPosToSafeTop`.                                                                                                                                                                                                                    |
| `line`   | `line: u32; offset: u32; length: u32; needle: string` | Scroll `doc.line(line)` (clamped to `doc.lines`) into view; re-locate `needle` on that line and select it — the selection is the arrival highlight. If the needle is gone (file changed since scan), land on the line with no selection — graceful, no wrong-range select. |

Consumed exactly once per navigation, as today. `length`/`offset` are char
units within the line, matching `match_ranges` units.

## Relationships

```text
Walk (Rust)                Frontend
─────────────              ─────────────────────────────────────
file ──text?──▶ SearchMatch ──Channel──▶ Scan.matches ──▶ list + preview
file ──.pdf───▶ PdfCandidate ──Channel──▶ pdf.js lines ──▶ SearchMatch
                                             │
activation: SearchMatch ──kind──▶ text: PendingTarget.line ──▶ editor scroll+select
                              └─▶ pdf:  requestPdfAnchor("page=N&text=hint")
                                        ──▶ pdf-pane re-find + emphasis
```

## Validation rules (from requirements)

- `line_number`/`page` are ≥ 1; `line` is clamped to the document at consume.
- `match_ranges` lie within `line_text` and never overlap.
- `context` is ~5 lines, fewer at boundaries.
- Results carry content matches only — a filename-only match produces nothing
  (FR-013).
- Smart-case: if `query` contains an uppercase char, matching is
  case-sensitive; otherwise insensitive. The rule lives in both matchers
  (research R3) and is pinned by tests on each side.
- Caps: ≤ ~20 matches per file, ~200 displayed results; overflow sets
  `truncated`, never silently drops (FR-010).
