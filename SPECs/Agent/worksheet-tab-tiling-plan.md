# Tab tiling planning worksheet

Task: Plan feature 002 using `speckit-plan`. See [spec](../tab-tiling-splits/spec.md) and [plan](../tab-tiling-splits/plan.md). TODO is In Progress; planning is complete, implementation remains pending.

Read the local `.claude/skills/speckit-plan/SKILL.md`, constitution, relevant React/Zustand/consolidation/editor docs, editor/tab/session code, Rust session persistence, and existing sidebar drag and drawing code. Research agents investigated buffers and drag/resize independently. Planning stops after research, data model, contracts, and validation guide; no `tasks.md` or implementation is included.

The current branch is `excalidraw-embed`. Pre-existing edits include TODOS, the feature spec/checklist, command palette, editor API, drawing helpers, UI store and tests. Preserve those edits. The feature is selected explicitly with SPECIFY_FEATURE_DIRECTORY; no branch switch or stash is needed for planning.

Decisions: one editor store owns layout/tab transitions, shared path buffers and drawing sessions own writes, per-tab state owns view behavior, stable tab hosts preserve instances during moves, react-resizable-panels handles resizing, one pointer coordinator predicts final geometry before preview/commit, v2 sessions migrate legacy flat lists.

The spec's session-write race assertion is stale: Rust already has sessions_file_lock. Record the correction in research and preserve the lock. No user-visible editor behavior changes in this planning commit; the shipping changelog entry belongs to implementation.

Validation: repo-local vp install succeeded. Check generated Markdown links, unresolved placeholders and diff whitespace before handoff. Full code/runtime checks are listed in quickstart for implementation.

Concurrent work appeared during planning in drawing persistence, shutdown, editor/workspace stores and related files. It was not edited or staged by this task. Re-read drawing-sessions.ts and updated the plan to extend its per-path ownership while preserving its current explicit save triggers.

Independent Systems Architect review found no P1 issues and one P2 contradiction between a global dedup invariant and legacy/Open in new tab duplicates. Resolved by making dedup operation-specific and adding a legacy-duplicate fixture requirement.

Final checks: all seven artifacts passed Markdown formatting and local link/placeholder checks. The commit hook ran vp check --fix successfully on the staged documents. Only newly authored planning artifacts are committed; TODOS remains in the shared working changes so unrelated concurrent tracking edits are not swept into this commit. No extension hooks were configured.
