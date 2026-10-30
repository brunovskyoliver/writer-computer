# Writer comprehensive audit

## Scope and acceptance

User request, 2026-10-29: inspect and improve Writer's desktop UI, performance,
reliability and academic workflows, using the SDU Obsidian vault as the primary
reference. Preserve original notes, metadata and attachments. Resolve one task
at a time, record evidence, review, verify and commit each completed fix.

Acceptance requires real desktop interaction and visual inspection, not just
passing unit tests. Measure before optimizing. Record blocked workflows honestly.
Do not run the source vault's synchronization or modify its files during audit.

## Starting state

- Starting HEAD: `c0a2750`.
- Existing uncommitted work: math evaluation/plot completion, Mermaid rendering,
  editor extensions, dependencies, related tests/specs and CHANGELOG. Preserve
  these changes; do not stash, revert or include them in audit commits.
- Read TODOS, agent-loop, agent-review, vite-plus, current E2E setup.
- Prior review report and memory investigations are relevant historical evidence,
  not proof of the current tree's runtime behavior.
- Evidence: `~/agent-runs/2026-10-29-writer-audit/`.
- Temporary fixtures and scripts: session `$TMPDIR`.
- `vp` missing from shell PATH; repo `node_modules/.bin/vp` works. Its `env doctor`
  command is unavailable. Dependency installation succeeded without lockfile edits.
- Frontend baseline: 1,692 tests in 111 files pass. `vp check`: zero errors,
  ten pre-existing warnings. Rust baseline: 278 tests pass. Isolated release build
  and native WebDriver interaction succeeded.
- No Memcrate context files found in the usual locations. User confirmed SDU docs
  are the main reference, so continue using repository and vault evidence.

## Work plan

1. Read-only parallel academic workflow and reliability inspections.
2. Build an isolated native E2E app, seed synthetic study notes, inspect normal
   and minimum-size layouts, dialogs, search, editing and attachments.
3. Turn reproduced defects into prioritized tickets with regression checks.
4. Review plans, implement sequentially, review changes, verify in native app.
5. Repeat across unresolved findings and record limits.

## Findings

| ID     | Priority  | Finding                                                                                                | Status                                                                                                      |
| ------ | --------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| AUD-01 | P1        | External reload overwrites newer edits or completed saves; dirty conflicts silently discard local text | Fixed in `2a71ac0`; 1,720 frontend / 292 Rust tests and native recovery verified                            |
| AUD-02 | P2        | Atomic text save replaces permissions and symlink identity                                             | Fixed in `3aef86f`; 286 Rust tests and native IPC verified                                                  |
| AUD-03 | P2        | SDU Obsidian Excalidraw Markdown drawings/embeds unsupported                                           | Preview/copy in `96e835d`; 1,801 frontend / 305 Rust tests; full migration remains open                     |
| AUD-04 | P2        | Active tab clipped after window/pane resize                                                            | Fixed in `7ae7721`; 1,696 frontend tests and native layout checks pass                                      |
| AUD-05 | P2        | Existing course plugin persistence queue stays rejected after one IO failure                           | Static finding; source plugin not modified                                                                  |
| AUD-06 | P2        | Calendar refresh interval, course-folder mapping and dedup map drift                                   | Design written ([report](worksheet-audit-calendar-ingestion.md)); not implemented, needs a real feed sample |
| AUD-07 | P2        | Minimum split pane clips tab chrome; conflict notice leaves zero editor height                         | Fixed in `ba29d11`; 1,726 frontend tests and native layout/conflict/Vim checks pass                         |
| AUD-08 | P2        | Wiki note fragment not passed to navigation; moves do not rewrite note links                           | Fixed; 1,822 frontend / 305 Rust tests and native checks ([report](worksheet-audit-links-on-move.md))       |
| AUD-09 | Untriaged | PDF rectangle encoding compatibility                                                                   | Inspect actual grammar before claiming compatibility; no PDF++ selection anchors observed in SDU            |

AUD-10 (P1): expected-missing saves can replace an external file created between
check and rename. Fixed in `430e347` and verified with exclusive publication; 298 Rust / 1,727
frontend tests and repeated native recreation pass. Report: [atomic new-file publication](worksheet-audit-create-publication.md).

## Verification and remaining work

Audit remains in progress. Seven improvements implemented and tested; AUD-12 uses the documented trivial-review exception. No production
installation, deployment or vault migration. No original notes changed.

- Evidence reports: `academic-workflow.md`, `reliability.md` under the evidence directory.
- Real app: isolated `com.writer-computer.audit`, loopback WebDriver port 4457.
  Source was rebuilt for each fix. Repo's E2E script requires missing `cargo tauri`;
  installed JS CLI works via `PATH="$PWD/node_modules/.bin:$PATH" vp exec tauri build`
  from the desktop package (use absolute repo bin path from that cwd).
- Native screenshots: empty tab, study note, palette, settings, 1200/800 CSS-pixel
  windows, tab resize before/after and split pane. Dark mode inspected; full light,
  focus, accessibility, dialog and error-state passes remain.
- AeroSpace: initial opening and reopening tile automatically. Neighboring T3 Code
  shrank from 2998 to 1494 pixels; Writer parent is TilingContainer. Audit window
  temporarily floated for controlled sizes, then closed after validation; the
  neighboring window returned to its original layout. Audit app is not running.
- Large-note baseline: 1,105,014 bytes before edits, 40 inserted characters confirmed
  on disk. `large-note-typing-baseline.json` stores synchronous insertion and next
  animation-frame timings. This is synthetic DOM text input in focused WebKit,
  not hardware keyboard latency. No performance improvement claimed. First hidden
  window/rAF measurement failed and was discarded. Broader profiling remains.
- Known harness limits: `osascript quit` returns -128 because Writer cancels the
  initial quit and asynchronously completes its save handshake; process actually
  exits. W3C pointer actions emitted no DOM pointer events; split testing used
  synthetic events, explicitly distinguished from native mouse acceptance.
- SDU reference: 29 Markdown files, 6 PDFs, 8 Excalidraw Markdown drawings, 16
  calendar-generated lesson notes. Existing itslearning integration is ICS/webcal
  calendar ingestion only, not a resource/assignment sync API. Preserve semantic
  frontmatter and stable lesson identities when adding Writer support.

AUD-07 report: [usable small split panes](worksheet-audit-small-panes.md). Native
800/1200 light/dark checks, properties, conflicts, Find, Vim, undo and synthetic
tab moves pass. The final app also fixes a measured Vim coordinate race.

AUD-03 preview/copy report: [Obsidian drawings](worksheet-audit-obsidian-drawings.md).
Native copy editing/save/reopen and source preservation, standalone watcher
recovery, empty states, small panes and live tiling pass. Full migration remains.

AUD-11 (P2): large drawing SVG export still blocks the main thread. A synthetic
430-stroke scene showed roughly 100ms of SVG construction. Preview-only editable
metadata generation was removed; copy/save still retain metadata. Post-change
maximum frame gap was 143ms in one valid diagnostic, but its viewport differed
from the baseline. Comparable runs lost foreground visibility and were excluded.
Investigate export architecture and obtain controlled measurements before claiming
a speedup. Evidence and scope are in the AUD-03 report.

Next: resolve drawing export stalls, fragment links and course navigation. Full metadata
preservation, save concurrency with external processes, performance profiling,
accessibility and remaining UI states are still open. AUD-01 report has final native
and automated evidence; no broad completion claim is made.

AUD-12 (P2): deleted drawing elements inflated SVG export bounds, reducing visible
content to a tiny area. Reproduced natively with a mixed fixture containing a
far-away deleted rectangle. Shared-export filter verified with 1,802 frontend tests, native bounds/path comparison
and copy/reload/source preservation ([report](worksheet-audit-deleted-drawing-bounds.md)).

Audit paused at Oliver's request after AUD-12, pending review. AUD-11 research and
controlled baseline are recorded; no performance patch has been implemented.

Resumed 2026-10-30 at Oliver's request. AUD-08 fixed, plus two defects native checks exposed: `../`
images never loaded and heading jumps landed short. AUD-11 deferred: SDU's largest drawing is 394KB
against the 1.4MB benchmark. The vault now lives at `~/Documents/Obsidian/SDU`.

AUD-13 (P1): `migrate_from_preferences` in `config.rs` deleted `preferences.json` on every launch, while
`lib/preferences.ts` still uses that file for pinned files. Found when layouts vanished on restart; reproduced by
watching the file during a plain launch. Removed the migration, whose theme import has run on every launch since the
initial commit. Pinned files themselves were not driven natively; layouts in the same store were.

Course navigation done: [named layouts](worksheet-audit-course-layouts.md).

Next: AUD-06 implementation once a feed sample is approved, full metadata-preserving
drawing migration, accessibility and light-mode passes, and broader performance profiling.
