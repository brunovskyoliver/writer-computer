# Workspace Index + Fuzzy Universal Search Spec

## Summary

Universal search (`Cmd+P`) is already backed by a background workspace index,
but the index only knows Markdown files — drawings and PDFs are invisible to
search even though the sidebar and open routes handle them — and the matcher
is substring-only, so "wtr" never finds "writer". Widen the index to every
sidebar-visible file and give `fuzzy_search` a real subsequence fuzzy matcher.

## Problem

- `index_workspace_impl`, `index_written_file`, and the watcher's membership
  updates all gate on `is_markdown_file`. A workspace holding `paper.pdf` or
  `sketch.excalidraw.svg` can never surface them in the palette.
- `fuzzy_search_from` lowercases each relative path per query and looks for a
  substring hit, synthesizing space/hyphen query variants. Subsequence queries
  ("wtr", "mf" for "my-file") miss entirely.
- The frontend hook applies whichever IPC response resolves last — a slow
  earlier query can overwrite a newer one — and keeps showing results for a
  query the input no longer holds.

## Behaviour

- The index covers every file the sidebar lists: `.md`/`.markdown`,
  `.excalidraw.svg`, `.pdf` (`is_sidebar_file`). Only metadata is stored —
  path, relative path, name, mtime — never file contents, so widening costs a
  bounded record per file.
- `dirs_with_markdown` is renamed `dirs_with_sidebar_files`: its meaning was
  always "directories containing at least one indexed file", and the indexed
  set is what changed.
- `fuzzy_search` does subsequence matching over the relative path:
  - query chars must appear in order; separators in the query (` `, `-`, `_`)
    match any separator position in the path (`/`, ` `, `-`, `_`), so
    "foo bar" finds `foo/bar.md`;
  - scoring rewards consecutive runs, word/camelCase boundaries, matches
    inside the filename, tight spans, and shorter paths;
  - `match_indices` are the matched character positions, unchanged contract
    for `HighlightedPath`.
- Watcher maintenance (`prepare_*` paths) and `index_written_file` follow the
  same predicate. Modify events update mtimes for all indexed kinds.
- `useFuzzySearch` drops stale responses (latest-wins sequence guard) and
  returns results only for the query that produced them.

## Non-Goals

- Indexing file _contents_ — content search already scans on demand with its
  own caps; the filename index stays metadata-only.
- Indexing file kinds the app cannot open (images, binaries): surfacing them
  would open garbage in the Markdown editor.
- Reordering the palette's commands/recents/file groups.

## Files Expected To Change

- `apps/desktop/src-tauri/src/commands/search.rs` — fuzzy matcher, index filter
- `apps/desktop/src-tauri/src/commands/fs.rs` — comment updates
- `apps/desktop/src-tauri/src/state.rs` — `index_written_file` filter,
  `dirs_with_sidebar_files` rename
- `apps/desktop/src-tauri/src/watcher.rs` — same rename + predicate
- `apps/desktop/src-tauri/src/commands/workspace.rs` — same rename
- `apps/desktop/src/components/command-palette/use-fuzzy-search.ts` — seq guard
- Rust + frontend tests

## Acceptance Criteria

- A `.pdf` or `.excalidraw.svg` created in the workspace appears in `Cmd+P`
  results and opens in its own surface when selected.
- Subsequence queries ("wtr" → "writer-notes.md") rank sensibly; filename
  hits outrank path-only hits; `match_indices` highlight correctly.
- New/renamed/deleted sidebar files update the index through the watcher.
- Rapid typing never displays results for a superseded query.
