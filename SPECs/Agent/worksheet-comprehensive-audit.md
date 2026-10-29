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

| ID     | Priority  | Finding                                                                                                | Status                                                                                           |
| ------ | --------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| AUD-01 | P1        | External reload overwrites newer edits or completed saves; dirty conflicts silently discard local text | Reproduced in isolated hook harness; conflict design next                                        |
| AUD-02 | P2        | Atomic text save replaces permissions and symlink identity                                             | Fixed in `3aef86f`; 286 Rust tests and native IPC verified                                       |
| AUD-03 | P2        | Eight SDU Obsidian Excalidraw Markdown drawings/embeds unsupported                                     | Source and vault inventory confirmed; import/preview pending                                     |
| AUD-04 | P2        | Active tab clipped after window/pane resize                                                            | Fixed; 1,696 frontend tests and native layout checks pass                                        |
| AUD-05 | P2        | Existing course plugin persistence queue stays rejected after one IO failure                           | Static finding; source plugin not modified                                                       |
| AUD-06 | P2        | Calendar refresh interval, course-folder mapping and dedup map drift                                   | Static findings plus stored-data mismatch; synthetic reproduction pending                        |
| AUD-07 | P2        | Minimum split pane leaves tab strip narrower than one tab                                              | Native observed; layout refinement pending                                                       |
| AUD-08 | P2        | Wiki note fragment not passed to navigation; moves do not rewrite note links                           | Static inspection; runtime reproduction pending                                                  |
| AUD-09 | Untriaged | PDF rectangle encoding compatibility                                                                   | Inspect actual grammar before claiming compatibility; no PDF++ selection anchors observed in SDU |

## Verification and remaining work

Audit remains in progress. Two fixes implemented, reviewed and tested. No production
installation, deployment or vault migration. No original notes changed.

- Evidence reports: `academic-workflow.md`, `reliability.md` under the evidence directory.
- Real app: isolated `com.writer-computer.audit`, loopback WebDriver port 4457.
  Source was rebuilt for both fixes. Repo's E2E script requires missing `cargo tauri`;
  installed JS CLI works via `PATH="$PWD/node_modules/.bin:$PATH" vp exec tauri build`
  from the desktop package (use absolute repo bin path from that cwd).
- Native screenshots: empty tab, study note, palette, settings, 1200/800 CSS-pixel
  windows, tab resize before/after and split pane. Dark mode inspected; full light,
  focus, accessibility, dialog and error-state passes remain.
- AeroSpace: initial opening and reopening tile automatically. Neighboring T3 Code
  shrank from 2998 to 1494 pixels; Writer parent is TilingContainer. Audit window
  temporarily floated for controlled sizes. Restore tiling or close at session end.
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

Next: resolve AUD-01 with a reviewed conflict policy and guarded asynchronous reads,
then evaluate drawing import, fragment links and course navigation. Full metadata
preservation, save concurrency, performance profiling and remaining UI states are
not complete. The goal must remain active.
