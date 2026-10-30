# Git pull and push

Two buttons in the top-right corner of the window, Pull and Push, and nothing else: no panel, no status, no palette commands, no shortcut. Oliver cut the first version (a full sidebar panel with Sync, merge handling and abort, commit `387f005`) down to this on 2026-10-30. It uses the system `git` and existing credentials, and never asks for, stores or logs a password or token. Credentials are stripped from remote URLs in every message.

## Behaviour

**Push** saves open notes and drawings, checks the remote, `git add`s each file edited inside Writer, commits them as `Edited a.md, b.md` (eight names, then "and N more"), and pushes. A branch with no upstream is published automatically.

**Pull** saves open notes and drawings, fetches, and fast-forwards only. If it can't take everything, nothing changes and the message says why.

## Decisions

- **Fast-forward only, no merge.** "Pull only if it's possible to pull everything" is what `git merge --ff-only` does: git checks first and either applies all of it or changes nothing. Conflicts can't start from Writer, so all the conflict, abort and resolve code is gone.
- **Push checks the remote before committing.** Committing while behind would create two histories that Pull then refuses to join. So when the remote has moved, Push says "pull first" and commits nothing, and the edit stays queued.
- **What counts as edited in Writer.** Text and drawing saves, new files, renames (both names), deletes and pasted images are appended to `.git/writer-edited`. The record survives a restart and is never committed. After a commit it keeps only paths that still have changes, so an edit landing mid-push isn't forgotten. Files changed outside Writer stay uncommitted unless Writer also edits them.
- **Credentials.** A credential-looking file edited in Writer is left out and named in the message, with no confirmation step, and it stays queued. `.gitignore` is respected.
- **Never done:** force-push (explicit `HEAD:<ref>` with no `+`), `reset --hard`, any merge.
- **Open files.** After a pull, open files go through the existing external-edit handling. Clean drawing tabs changed by the pull close with a message to reopen them, because they can't reload. A tab with an unresolved disk conflict stops both buttons.
- **Process handling.** Git runs off the main thread with one operation per repo. Local commands stop at 120s, network at 300s. Saves wait on `WORKTREE_GATE` during the fast-forward.

## Report (2026-10-30)

### What changed

`commands/git.rs` reduced to `git_pull` and `git_push`. `note_edited` is called from the save, create, rename, delete and paste-image paths. New `components/git-buttons.tsx`, with `stores/git-store.ts` and `hooks/use-git.ts` reduced to match. The panel, palette commands, Cmd+Shift+S and their doc entry are removed.

### Verification

`vp check` 0 errors and 10 warnings, the same count as before this work. `vp test` from the repo root 1,848 passed. `cargo test` 333 passed, including 21 git tests on real temp repos with a local bare remote. `cargo clippy` shows no warnings in `git.rs`; the lib's 15 were already there. `cargo fmt --check` is clean.

Native: 11 of 11 on an isolated build (`com.writer-computer.gitsync`) with temp repos and a local bare remote:

- two buttons top-right, no panel
- push flushes unsaved text, commits only the Writer-edited file, leaves an outside edit alone
- pull fast-forwards and reloads an open buffer
- push when behind commits nothing, then pull and push works
- pull with an overlapping local edit changes nothing and keeps the text
- pull with diverged history changes nothing
- held `index.lock`, no network with the token stripped, detached HEAD
- the edit record lives in `.git` and empties after a push

Rust tests only, not in the app: credential file left out, gitignored edit, rename and delete, staged deletion, decomposed file name, failing hook, rejected push, first-push publish, no repo, no remote, rebase in progress, git missing, timeout. Store test only: closing a stale drawing tab.

### What remains

- **Same file changed on both sides needs a terminal.** Push says pull first, Pull refuses, and the message says to use `git pull` in a terminal. That follows from pulling only when everything applies.
- **Edits from before this feature aren't known.** Only edits made after it ships are recorded. Already-changed files commit once edited in Writer again.
- **Drawing edited during a pull.** That tab stays open with a warning, and saving it replaces what was pulled. The fix is in `lib/drawings.ts`, which was off limits because of parallel work.
- **Other windows.** Only the window that pressed the button is flushed. Other windows' unsaved text isn't committed.
- **Very long tab rows.** The buttons float over the tab strip and can cover the end of it.
- **Windows.** Never built or run there: the record stores native path separators, and a cross-compile check fails on `ring`.

### Install (2026-10-30)

`master` (`019837c`, including AUD-11) was merged into `feat/git-sync` as `59142f1`; `master` itself is unchanged. After the merge: `vp test` 1,849 passed, `cargo test` 333 passed, native 11 of 11 on the isolated build. That commit is built and installed at `/Applications/Writer.app`, ad-hoc signed like the build it replaced. The previous app is at `~/agent-runs/2026-10-30-git-sync/Writer-before-git-buttons.app`. The installed app was not launched, because launch runs lesson sorting on the real vault; the bundle's identifier, signature and feature strings were checked instead. A first install attempt put the test bundle in `/Applications` for about three minutes after a failed release build (a stale `sccache` temp path) and was replaced. Nothing launched it.
