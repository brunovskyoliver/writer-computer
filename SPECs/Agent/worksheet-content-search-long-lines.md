# Content search freeze on very long lines

## Problem

Cmd+Shift+F with the query `dwd` in the SDU vault locked the window permanently.

## Cause

`drawing.excalidraw.svg` is one line of 218,046 characters and contains `dwd`. Rust sent the whole line, and `HighlightedRanges` renders one `<span>` per character, in both the result row and the preview.

PDF extraction was the first suspect and was ruled out: the hang was the same with every PDF removed. A workspace holding only that SVG hung within 1.8s.

## Fix

`clip_line` in `commands/search.rs` sends about 400 characters around the first match for text files and a `clip_start` offset, which `openSearchMatch` adds back to get the true column. Context rows are cut to the same length. Matched PDF lines stay whole because `line_text` is their page anchor; extracted lines are short.

## Verification

- Before, in the isolated app on a vault clone: web view unresponsive from about 2s, still hung at 113s, with and without PDFs.
- After, same clone with its PDFs and an empty cache: 29 rows, scan finished in about 7s, no heartbeat gap over 200ms. Opening a long-line SVG result and a drawing result both left the app responsive.
- `cargo test` (335 passed), `cargo fmt --check`, Rust tests for clipping, multi-byte columns and over-long queries. `vp test` covers the column offset.
- `vp check` reports no errors and 10 warnings, none from this change. `cargo clippy` warnings are in other files.

## Remaining

The installed `/Applications/Writer.app` doesn't have this fix. The line position in the editor wasn't asserted natively: the two results opened in the test are drawings, which don't open in the text editor.
