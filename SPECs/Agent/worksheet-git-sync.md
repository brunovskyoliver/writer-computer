# Git pull and push worksheet

Task and final report: [spec](../git-sync-spec.md). Branch `feat/git-sync`, own worktree, not pushed or merged. Parallel drawing-export work (AUD-11) owns `lib/drawings.ts`, so this task doesn't touch it.

Native harness: a raw WebDriver script drove a copied bundle, because another thread pattern-kills `bundle/macos/Writer.app`. Build identifier `com.writer-computer.gitsync`, temp repos and a local bare remote only. The real vault and the installed app were not used.

Notes for the next agent:

- Run `vp test` from the repo root. From `apps/desktop` it leaves out the website tests, so counts are lower.
- The watcher hides recently self-written paths, which is why worktree changes call `recheckOpenFiles` directly.
- `387f005` holds the larger first version with the panel, merges and abort. Oliver asked for two buttons instead, so `git.rs` was cut down; start from the spec, and treat that commit as history.
