# Git sync

Per-workspace git in the sidebar: branch, ahead and behind, changed files, last result, and one Sync button. Writer runs the system `git` with the credentials already set up. It never asks for, stores or logs a password or token, and it strips credentials from remote URLs in every message it shows.

## Behaviour

- **Sync** (Cmd+Shift+S, palette `Git: Sync`): saves open notes and drawings, stages everything in the workspace, commits if anything changed, pulls, pushes, and reports the result in plain words.
- **Separately**: Pull, Push, Publish branch, and Commit for chosen files with an editable message. The default message is generated from the files.
- **Scope**: if the workspace is a subfolder of a repo, Sync stages only that subfolder and shows how many changes sit outside it.
- **Result**: the last result is kept per workspace while the app runs.

## Decisions

**Merge, not rebase.** A pull fetches, then runs `git merge` with a fixed message. Reasons:

- Merge doesn't rewrite commits, so nothing that was already pushed changes identity.
- A conflict stops once and shows all its files at the same time. A rebase can stop once per commit, and the same file can conflict again.
- One command undoes it (`merge --abort`).
- HEAD stays on the branch throughout. A rebase detaches it, which is a poor state for someone who only wanted to sync notes.

The cost is merge commits in the history. For a notes repo that's acceptable.

**Never done:** force-push (push is an explicit `HEAD:<ref>` with no `+`), `reset --hard`, or resolving a conflict in favour of one side without being told.

**Abort keeps a copy.** `merge --abort` drops everything staged, including fixes and changes unrelated to the merge. Before aborting, Writer writes all non-ignored files to a commit under `refs/writer/before-abort/<id>`, using a temporary index, and names the commit in the result. If the copy fails, the abort doesn't run. These refs are never pushed and are never cleaned up automatically. A credential-looking file that wasn't ignored is in that local commit too.

**Conflicts with nothing to edit need a choice.** With a binary or modify/delete conflict, the file on disk is exactly one side or is gone, so staging it would drop the other side silently. Commit stops, names the files and requires "Commit the version on disk". That answer covers the named files only, and is separate from the credential confirmation. A file still holding markers is refused outright.

**All conflict checks run before `git add`.** Staging marks a conflict resolved, and leaves staged work for an abort to drop.

**Saves and merges can't interleave.** `WORKTREE_GATE` is held for writing during merge and abort, and for reading across a checked save, so an overtaken save becomes a visible conflict instead of a lost pull. `ponytail:` the gate is process-wide; make it per-repo if unrelated repos ever contend.

**Open files.** After the worktree changes, Writer re-checks open files through the existing external-edit handling, so clean buffers reload and dirty ones raise the conflict notice. Sync refuses while a tab has an unresolved conflict. Drawing tabs can't reload and saving one writes without a check, so clean drawing tabs changed by a pull are closed with a message to reopen them.

**Process handling.** All git work runs off the main thread with one operation per repo. Status has a 30s limit, local commands 120s, network 300s. On timeout the child's process group gets TERM, then KILL after 5s, and the status is read again so the report matches what's on disk. Each child has its own session, no terminal prompts and no askpass, so ssh can't hang waiting for a passphrase.

**Credential warning.** Before committing, names and a few content patterns are checked. Files matched are listed by name, never by value, and need confirmation. `.gitignore` is respected.

**Passive status and untrusted repos.** Opening a folder runs `git status`, with `core.fsmonitor` disabled. Clean filters from that repo's `.git/config` can still run, as they can with any git client, and can't be turned off generally without breaking LFS. Don't open a repo you don't trust.

## Report (2026-10-30)

### What changed

- Backend: `commands/git.rs`, 8 IPC commands, the gate in `write_file_checked_impl`.
- Frontend: `stores/git-store.ts`, `hooks/use-git.ts`, `lib/git.ts`, `components/sidebar/git-panel.tsx`, `use-git-status-updates.ts`, `recheckOpenFiles`, palette commands, Cmd+Shift+S.

### Verification

Gates on the final code: `vp check` 0 errors and 10 warnings, none in these files. `vp test` from the repo root 1,863 passed. `cargo test` 348 passed, including 36 git tests on real temp repos with a local bare remote. `cargo clippy` shows no warnings in `git.rs`, and the lib's 15 warnings were already there. `cargo fmt --check` is clean.

Native: 25 of 25 cases on an isolated build (`com.writer-computer.gitsync`) driven over WebDriver, against temp repos with a local bare remote. Output and screenshots are in `~/agent-runs/2026-10-30-git-sync`. Failure cases exercised in the real app:

- real text conflict: stops, lists the file, pushes nothing, keeps both sides on disk
- abort, including abort with unrelated staged work, recovered from the named commit
- resolving: markers refused, then commit and sync
- binary conflict: refused until the version on disk is explicitly chosen
- dirty buffer through a pull: survives, notice shown, Sync refuses
- UI during a slow fetch: longest main-thread gap 28ms; 400-file pull with the watcher running: 37ms, no false save conflicts
- credential warning, held `index.lock`, rejected push (never forced), no network with the token stripped, failing hook, detached HEAD, rebase in progress, no upstream then publish, no remote, no repo with explicit Initialize

Rust tests only, not in the native app: git not installed, timeout. Tests only, not native: closing a stale drawing tab (store test), staged deletion, modify/delete conflict, lock on a file other than the index (Rust tests).

An independent review found one P0 and two P1s. All three are fixed above: abort discarding staged work, marker-less conflicts auto-resolving, and stale drawing tabs overwriting pulled content, the last with the limit below.

### What remains

- **Drawing edited during a pull.** A drawing tab edited while the pull runs can't be closed safely, so it stays open with a warning, and saving it replaces what was pulled. The full fix is an expected-content check in `lib/drawings.ts`, which was off limits to this work because of parallel drawing changes.
- **Other windows.** Flush and tab closing cover only the window that started the operation. Unsaved text in another window is not committed.
- **Watcher race.** A watcher read in the moment a merge replaces a file can raise a false conflict notice. It's harmless and clears on choosing a version. Reads don't take the gate.
- **Late files.** The chosen list is an opt-out, so a file appearing after you reviewed the panel is included in a commit. The credential check still covers it.
- **Windows.** Unix-only calls are guarded and a timed-out git is killed without its children, but a Windows build couldn't be checked here because `ring` fails to cross-compile. Nothing git-related has been run on Windows.
- **Skipped.** No background fetch, so "behind" is only as fresh as the last fetch. No cancel button; the timeouts are the limit. The last result isn't kept across restarts.
