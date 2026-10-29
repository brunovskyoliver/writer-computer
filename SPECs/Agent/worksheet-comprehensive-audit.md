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
  ten pre-existing warnings. Rust baseline and isolated desktop build in progress.
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

| ID     | Priority     | Finding                                                               | Status                                                         |
| ------ | ------------ | --------------------------------------------------------------------- | -------------------------------------------------------------- |
| AUD-01 | Candidate P1 | External reload may overwrite edits made during its asynchronous read | Reproduction pending                                           |
| AUD-02 | P2           | Atomic text save replaces permissions and symlink identity            | Fixed; 286 Rust tests and native IPC verified; separate ticket |
| AUD-03 | Candidate P1 | SDU PDF++ anchors and Excalidraw Markdown compatibility               | Inspection in progress                                         |

## Verification and remaining work

Audit remains in progress. Native screenshots, benchmark measurements, actual
workflow verification, implementation and commits are not yet complete.
