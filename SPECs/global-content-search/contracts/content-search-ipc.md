# Contract: `content_search` IPC

The boundary between the workspace scan (Rust) and the palette (frontend).
One command, one channel enum, one error path.

## Command

```text
content_search(query: string, on_event: Channel<ContentSearchEvent>) -> Result<(), AppError>
```

- Invoked per dispatched query (debounced ~150ms frontend-side). Empty `query`
  is an `AppError` — the frontend never sends one (empty input is the hint
  state).
- Runs the walk inside `tauri::async_runtime::spawn_blocking`; the invoke
  returns when the walk finishes or is cancelled. The channel carries
  everything the UI needs — the return value is only the error path.
- Requires an open workspace: `NoWorkspace` when the window has none. The
  command is unreachable in compact windows (the shortcut is gated on `root`),
  so this error means a race (workspace closed mid-call), not a reachable UI
  state.
- **One active scan per window.** Entry installs a fresh `Arc<AtomicBool>` in
  `state.cancel_search`, first flipping the outgoing flag — a superseded walk
  exits at the next directory entry, same discipline as `cancel_index`.
  Cancellation is not an error: a cancelled scan sends no `done`.
- Walk filters are exactly `index_workspace_impl`'s: hidden files, `.gitignore`
  (local + global + exclude), `node_modules` safety net, ≤8 walker threads.
  FR-009 is satisfied by construction — there is no second ignore matcher.

## Channel events

Serde-tagged enum; TS mirror in `types/fs.ts`. Order within a batch is the
walk's arrival order — **not** result order. Result ordering (file mtime desc)
is the receiver's job (research R5).

```text
{ "type": "matches", "matches": SearchMatch[] }   // text-file batch
{ "type": "pdf",     "candidate": PdfCandidate }  // a .pdf in the corpus
{ "type": "done",    "truncated": boolean }       // terminal event
```

- `matches` batches arrive per file as matched, ≤ ~20 matches per file. Rust
  self-caps total text emissions at ~200 and sets `done.truncated` when either
  cap engaged. The 200-result _display_ cap is the frontend's (PDF matches
  count toward it but are produced there — see data-model `Scan.truncated`).
- `pdf` events only enumerate; matching happens frontend-side. Candidates may
  keep arriving after the text cap — they carry no `truncated` implication of
  their own.
- `done` is the last event on a completed scan. No events follow. A cancelled
  scan sends nothing further — the receiver's seq guard already invalidates it.

## `SearchMatch` / `PdfCandidate` / `ContextLine` shapes

Text lines over 400 chars arrive as a window around the first match, and
`clip_start` is where that window starts in the line (0 otherwise), so the
column is `clip_start + char_start`.

As defined in `data-model.md`. `match_ranges` are char offsets within
`line_text`; `context` holds the matched line plus up to ~2 either side.

## Error contract

| Condition                         | Surface                                                                     |
| --------------------------------- | --------------------------------------------------------------------------- |
| Empty query                       | `AppError` (unreachable from the UI path)                                   |
| No workspace on this window       | `AppError::NoWorkspace`                                                     |
| Per-file read/decode failure      | Skip the file — same discipline as the index walker; not surfaced per entry |
| Undecodable/oversized/binary file | Skip — corpus scope per research R8                                         |
| Scan cancelled by a newer query   | Silent termination; no `done`, no error                                     |

## Semantics

- **Matching**: literal substring, per line. Smart-case: query containing an
  uppercase character → case-sensitive; otherwise case-insensitive.
- **Corpus**: every walked file that is `.pdf` or decodes as strict UTF-8
  within ~4 MiB. Everything else is skipped.
- **Ordering**: none promised on the wire; `modified_at` rides every result.
- **Staleness**: results describe disk at scan time. Activation re-resolves
  defensively (`contracts/line-target.md`); a vanished file hits the normal
  open-failure path.
