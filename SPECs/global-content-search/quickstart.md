# Quickstart: Global Content Search

Runnable validation for `global-content-search`. Contract details live in
`contracts/`; this guide proves the feature works end-to-end, not how it's
built.

## Prerequisites

- Repo deps installed (`vp install`), Rust toolchain for `apps/desktop/src-tauri`.
- A fixture workspace. Create one:

```bash
mkdir -p /tmp/search-fixture/docs && cd /tmp/search-fixture
cat > notes.md <<'EOF'
# Trip notes
The ferry departs at dawn.
Packing list: boots, map, compass.
EOF
cat > docs/plan.txt <<'EOF'
Budget review
The ferry tickets cost 40.
EOF
cp /path/to/any-text.pdf report.pdf        # a PDF with a text layer containing "ferry"
mkdir -p .git && cat > .gitignore <<'EOF'
ignored.md
EOF
cat > ignored.md <<'EOF'
This ferry mention must never appear.
EOF
```

- A scanned/image-only PDF helps for the skip-check but isn't required.

## Run

```bash
cd apps/desktop && vp dev        # or the app's normal dev command
```

Open `/tmp/search-fixture` as the workspace, wait for indexing to finish.

## Scenarios (map to spec user stories)

### US1 — search inside every file (P1)

1. `Cmd+Shift+F` → palette opens with a content-search placeholder.
2. Type `ferry` → `notes.md`, `docs/plan.txt`, and `report.pdf` all appear,
   each showing the matched line with `ferry` highlighted; the text rows show
   `L<n>`, the PDF row shows `Page <n>` (acceptance 1, 2).
3. Type a string present in no file → clear no-results state (acceptance 3).
4. `ignored.md` never appears; hidden files are absent (acceptance 4).
5. Type `plan` (matches `plan.txt`'s _name_; use a name whose content lacks the
   string) → no result from filename matching alone (acceptance 5 / FR-013).
6. While typing on a larger workspace, results grow incrementally and a
   scanning state is visible before "no results" is ever claimed (FR-015).

### US2 — context preview (P2)

1. With results shown, arrow through rows → the preview pane shows ~5 lines
   centred on the match for text results; PDF results show the page's text
   excerpt plus the page number (acceptance 1, 2).
2. Hover rows with the pointer → preview follows hover too (FR-006).
3. A match in the first or last line of a file → preview shows what exists, no
   error (acceptance 4).

### US3 — jump to the match (P3)

1. Enter on the `notes.md` result → the file opens (or its open tab activates)
   scrolled to the line with `ferry` selected (acceptance 1, 3).
2. Enter on the PDF result → `report.pdf` opens at the match's page with the
   passage emphasised (acceptance 2).
3. Re-open the palette, activate the same result → the existing tab is reused,
   not duplicated (acceptance 3).

### Edge checks

- Empty query → hint state, not a workspace listing.
- Rapid typing (`fer` → `ferry` → `zebra`) → results only ever reflect the
  latest query (FR-012); watch that a slow first scan can't overwrite a newer
  one.
- A query with ~20+ matches in one file or 200+ total → the truncation
  indicator appears (FR-010). Fixture: `seq 1 300 | sed 's/^/match-/' > many.md`.
- Scanned/image-only PDF in the workspace → absent from results, no error.
- `Cmd+Shift+F` in a compact standalone window (open a file via
  `writer <file>` / Open in Compact Window) → nothing happens (spec Q4).
- Smart-case: `ferry` matches `Ferry`; `Ferry` does not match `ferry` (FR-011).

## Automated coverage (the seams)

- `cargo test` (in `apps/desktop/src-tauri/`): the pure matcher (smart-case,
  multi-range lines), walk filters (gitignore/hidden/`node_modules`), per-file
  and total caps, `done.truncated`, PDF candidacy vs text-decode skipping —
  same tempdir style as `commands/search.rs`'s existing tests.
- `vp test` (in `apps/desktop/`): merge/sort/truncate reducer, PDF page-line
  splitting (`hasEOL`), the seq-guard dropping stale events.
- Full gate before merge: `vp check`, `vp test`, `cargo test`,
  `cargo clippy`, `cargo fmt --check`.

## Expected outcome

All acceptance scenarios in `spec.md` pass; the palette behaves identically to
`Cmd+P` in structure (keyboard nav, Esc, overlay close) plus the preview pane.
