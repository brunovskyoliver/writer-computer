//! Workspace git: one Pull and one Push through the system `git`, so ssh keys and
//! credential helpers keep working. See `SPECs/git-sync-spec.md`.
//!
//! Git never gets a terminal, and Writer never sees a password or token. Push
//! commits only the files edited inside Writer; Pull only ever fast-forwards.
//! Nothing here can force-push, hard-reset or start a merge.

use crate::error::AppError;
use crate::AppState;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

const LOCAL_TIMEOUT: Duration = Duration::from_secs(120);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(300);
/// SIGTERM lets git remove its lock files; SIGKILL follows only after this.
const TERM_GRACE: Duration = Duration::from_secs(5);
/// A forked ssh ControlMaster can hold our pipes open long after git exits.
const PIPE_GRACE: Duration = Duration::from_secs(2);
const MAX_SCANNED_BYTES: u64 = 1024 * 1024;
const MAX_ERROR_LINES: usize = 12;
const MAX_LISTED: usize = 8;

/// Held for writing during the short local fast-forward, and for reading by every
/// Writer text save. A save that arrives mid-pull waits, then meets the pulled
/// bytes in its expected-content check, so it becomes a visible conflict rather
/// than a write into a half-updated tree.
///
/// ponytail: one process-wide gate, so a pull in one repo briefly pauses saves
/// in another. Key it by repo root if pulls ever take long enough to notice.
pub static WORKTREE_GATE: RwLock<()> = RwLock::new(());

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitKind {
    Ok,
    NotInstalled,
    NoRepo,
    NoRemote,
    NoUpstream,
    Detached,
    InProgress,
    IndexLocked,
    Network,
    Auth,
    PushRejected,
    Hook,
    BehindRemote,
    CantPull,
    Timeout,
    NoIdentity,
    Busy,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOutcome {
    pub ok: bool,
    pub kind: GitKind,
    pub message: String,
    pub worktree_changed: bool,
    /// Absolute paths the pull changed.
    pub pulled: Vec<String>,
}

struct Stop {
    kind: GitKind,
    message: String,
}

fn stop(kind: GitKind, message: impl Into<String>) -> Stop {
    Stop {
        kind,
        message: message.into(),
    }
}

/// What an operation achieved before it finished or stopped, so a failed push
/// still reports the commit that landed.
#[derive(Default)]
struct Progress {
    said: Vec<String>,
    worktree_changed: bool,
    pulled: Vec<String>,
}

struct Output {
    success: bool,
    timed_out: bool,
    stdout: String,
    stderr: String,
}

pub struct Git {
    program: String,
    cwd: PathBuf,
    local_timeout: Duration,
    network_timeout: Duration,
}

impl Git {
    pub fn new(cwd: &Path) -> Self {
        Self {
            program: "git".into(),
            cwd: cwd.to_path_buf(),
            local_timeout: LOCAL_TIMEOUT,
            network_timeout: NETWORK_TIMEOUT,
        }
    }

    fn at(&self, cwd: &Path) -> Self {
        Self {
            program: self.program.clone(),
            cwd: cwd.to_path_buf(),
            local_timeout: self.local_timeout,
            network_timeout: self.network_timeout,
        }
    }

    fn spawn(&self, args: &[&str], timeout: Duration) -> Result<Output, Stop> {
        let mut command = Command::new(&self.program);
        // `--literal-pathspecs`: a note named `:(top)x` is just a note.
        command
            .args(["--literal-pathspecs"])
            .args(args)
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .env("LC_ALL", "C")
            .env("PATH", child_path())
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .env("GIT_EDITOR", "true")
            .env("SSH_ASKPASS_REQUIRE", "never")
            .env("GIT_HTTP_LOW_SPEED_LIMIT", "1")
            .env("GIT_HTTP_LOW_SPEED_TIME", "60");
        // Own session: no controlling terminal for ssh to prompt on, and one
        // process group to signal, which also reaches hooks and ssh.
        // SAFETY: setsid is async-signal-safe and touches no parent state.
        #[cfg(unix)]
        unsafe {
            use std::os::unix::process::CommandExt;
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                self.not_installed()
            } else {
                stop(GitKind::Other, format!("Couldn't start git: {error}"))
            }
        })?;
        let stdout = read_on_thread(child.stdout.take());
        let stderr = read_on_thread(child.stderr.take());

        let started = Instant::now();
        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {}
                Err(error) => return Err(stop(GitKind::Other, format!("Git failed: {error}"))),
            }
            if started.elapsed() > timeout && !timed_out {
                timed_out = true;
                ask_to_stop(&child);
                let term_at = Instant::now();
                while term_at.elapsed() < TERM_GRACE {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                force_stop(&mut child);
                break child.wait().ok();
            }
            std::thread::sleep(Duration::from_millis(10));
        };

        let stdout = stdout.finish();
        let stderr = stderr.finish();
        let output = Output {
            success: !timed_out && status.is_some_and(|status| status.success()),
            timed_out,
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        };
        // Apple's /usr/bin/git is a stub until the developer tools are installed.
        if !output.success && output.stderr.contains("xcode-select") {
            return Err(self.not_installed());
        }
        Ok(output)
    }

    fn not_installed(&self) -> Stop {
        stop(
            GitKind::NotInstalled,
            "Git isn't installed. Install the Xcode command line tools (xcode-select --install) \
             or git from git-scm.com, then try again.",
        )
    }

    fn local(&self, args: &[&str]) -> Result<Output, Stop> {
        self.spawn(args, self.local_timeout)
    }

    /// A local command whose failure has no special meaning to the caller.
    fn must(&self, args: &[&str]) -> Result<String, Stop> {
        let output = self.local(args)?;
        if output.success {
            Ok(output.stdout)
        } else {
            Err(classify(&output, args[0], self.local_timeout))
        }
    }

    fn has_hook(&self, names: &[&str]) -> bool {
        names.iter().any(|name| {
            let spec = format!("hooks/{name}");
            self.local(&["rev-parse", "--git-path", &spec])
                .is_ok_and(|output| self.cwd.join(output.stdout.trim()).is_file())
        })
    }
}

struct PipeReader {
    bytes: Arc<Mutex<Vec<u8>>>,
    done: mpsc::Receiver<()>,
}

impl PipeReader {
    /// A background child of a hook can hold the pipe open for good, so this
    /// takes what has arrived once the grace runs out.
    fn finish(self) -> Vec<u8> {
        let _ = self.done.recv_timeout(PIPE_GRACE);
        std::mem::take(&mut *self.bytes.lock())
    }
}

fn read_on_thread<R: Read + Send + 'static>(pipe: Option<R>) -> PipeReader {
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let (sender, done) = mpsc::channel();
    let sink = bytes.clone();
    std::thread::spawn(move || {
        if let Some(mut pipe) = pipe {
            let mut chunk = [0u8; 8192];
            while let Ok(read) = pipe.read(&mut chunk) {
                if read == 0 {
                    break;
                }
                sink.lock().extend_from_slice(&chunk[..read]);
            }
        }
        let _ = sender.send(());
    });
    PipeReader { bytes, done }
}

#[cfg(unix)]
fn ask_to_stop(child: &std::process::Child) {
    // SAFETY: plain syscall. The child leads its own session, so its pid is the group id.
    unsafe {
        libc::killpg(child.id() as libc::pid_t, libc::SIGTERM);
    }
}

#[cfg(unix)]
fn force_stop(child: &mut std::process::Child) {
    // SAFETY: as in `ask_to_stop`.
    unsafe {
        libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
    }
}

// ponytail: Windows has no group signal here, so hooks and ssh can outlive a
// timed-out git. Use a job object when Windows ships.
#[cfg(not(unix))]
fn ask_to_stop(_child: &std::process::Child) {}

#[cfg(not(unix))]
fn force_stop(child: &mut std::process::Child) {
    let _ = child.kill();
}

/// A Finder-launched app has a minimal PATH, which would hide Homebrew git and
/// the helpers and hooks that live beside it.
fn child_path() -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();
    format!("{inherited}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
}

/// Remove credentials from any `scheme://user:secret@host` in `text`.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let (head, tail) = rest.split_at(at + 3);
        out.push_str(head);
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '/' | '<' | '>'))
            .unwrap_or(tail.len());
        let authority = &tail[..end];
        let host = authority
            .rsplit_once('@')
            .map_or(authority, |(_, host)| host);
        out.push_str(host);
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// The last lines of git's output, safe to show.
fn said_by_git(output: &Output) -> String {
    let text = if output.stderr.trim().is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = &lines[lines.len().saturating_sub(MAX_ERROR_LINES)..];
    redact(&tail.join("\n"))
}

fn classify(output: &Output, action: &str, timeout: Duration) -> Stop {
    if output.timed_out {
        return stop(
            GitKind::Timeout,
            format!(
                "git {action} was still running after {} seconds, so Writer stopped it. \
                 Your notes are on disk; check the state below before trying again.",
                timeout.as_secs()
            ),
        );
    }
    let text = output.stderr.as_str();
    let has = |needles: &[&str]| needles.iter().any(|needle| text.contains(needle));
    if has(&[
        ".lock': File exists",
        "Another git process seems to be running",
    ]) {
        if text.contains("index.lock") {
            return lock_stop();
        }
        return stop(
            GitKind::IndexLocked,
            format!(
                "Another git process holds a lock in this repo. Wait for it to finish, then try \
                 again.\n{}",
                said_by_git(output)
            ),
        );
    }
    if has(&["dubious ownership"]) {
        return stop(
            GitKind::Other,
            "Git refuses this folder because another user owns it. Run the \
             `git config --global --add safe.directory` command it suggests if you trust it.",
        );
    }
    if has(&[
        "Please tell me who you are",
        "empty ident",
        "unable to auto-detect email",
    ]) {
        return stop(
            GitKind::NoIdentity,
            "Git doesn't know your name and email yet. Set user.name and user.email with \
             `git config --global`, then try again. Your changes are staged, not lost.",
        );
    }
    if has(&[
        "gpg failed to sign",
        "failed to write commit object",
        "error: Load key",
    ]) {
        return stop(
            GitKind::Hook,
            format!(
                "Git couldn't sign the commit, and Writer can't show a passphrase prompt. \
                 Your changes are staged, not lost.\n{}",
                said_by_git(output)
            ),
        );
    }
    if has(&[
        "Permission denied (publickey",
        "Authentication failed",
        "could not read Username",
        "could not read Password",
        "terminal prompts disabled",
        "Host key verification failed",
        "Invalid username or password",
        "The requested URL returned error: 401",
        "The requested URL returned error: 403",
        "passphrase",
    ]) {
        return stop(
            GitKind::Auth,
            format!(
                "The remote refused your credentials. Writer uses your existing ssh key or \
                 credential helper and never asks for a password; check they work in a terminal. \
                 Nothing was lost.\n{}",
                said_by_git(output)
            ),
        );
    }
    if has(&[
        "Could not resolve host",
        "Could not resolve hostname",
        "Connection refused",
        "Connection timed out",
        "Operation timed out",
        "Network is unreachable",
        "No route to host",
        "Failed to connect",
        "unable to access",
        "Could not read from remote repository",
        "does not appear to be a git repository",
        "Connection closed",
        "Connection reset",
    ]) {
        return stop(
            GitKind::Network,
            format!(
                "Couldn't reach the remote, or it refused access. Check your connection, the \
                 remote address and your access to it, then try again. Nothing was lost.\n{}",
                said_by_git(output)
            ),
        );
    }
    stop(
        GitKind::Other,
        format!("git {action} failed:\n{}", said_by_git(output)),
    )
}

fn lock_stop() -> Stop {
    stop(
        GitKind::IndexLocked,
        "Another git process holds .git/index.lock. Wait for it to finish. If nothing is using \
         the repo, an earlier git crashed: delete .git/index.lock yourself, then try again.",
    )
}

struct Repo {
    top: PathBuf,
    git_dir: PathBuf,
}

fn open_repo(git: &Git) -> Result<Repo, Stop> {
    let output = git.local(&["rev-parse", "--show-toplevel", "--absolute-git-dir"])?;
    if !output.success {
        if output.stderr.contains("not a git repository") {
            return Err(stop(GitKind::NoRepo, "This folder isn't a git repository."));
        }
        // Includes a bare repo or being inside .git, which have no work tree.
        return Err(classify(&output, "rev-parse", git.local_timeout));
    }
    let mut lines = output.stdout.lines();
    let (Some(top), Some(git_dir)) = (lines.next(), lines.next()) else {
        return Err(stop(GitKind::Other, "Git didn't report a repository root."));
    };
    Ok(Repo {
        top: PathBuf::from(top),
        git_dir: PathBuf::from(git_dir),
    })
}

fn list(names: &[String]) -> String {
    let shown = names[..names.len().min(MAX_LISTED)].join(", ");
    match names.len().saturating_sub(MAX_LISTED) {
        0 => shown,
        more => format!("{shown} and {more} more"),
    }
}

fn count(n: usize, noun: &str) -> String {
    format!("{n} {noun}{}", if n == 1 { "" } else { "s" })
}

/// States in which Writer must not start anything. Returns the branch.
fn preflight(git: &Git, repo: &Repo) -> Result<String, Stop> {
    if repo.git_dir.join("index.lock").exists() {
        return Err(lock_stop());
    }
    let busy = [
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("BISECT_LOG", "bisect"),
    ]
    .iter()
    .find(|(file, _)| repo.git_dir.join(file).exists());
    if let Some((_, name)) = busy {
        return Err(stop(
            GitKind::InProgress,
            format!(
                "A {name} is in progress in this repo. Finish or abort it in a terminal; Writer \
                 won't touch it."
            ),
        ));
    }
    let branch = git.local(&["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    if !branch.success {
        return Err(stop(
            GitKind::Detached,
            "HEAD is detached, so this repo isn't on a branch and new commits could get lost. \
             Check out a branch in a terminal, then try again.",
        ));
    }
    Ok(branch.stdout.trim().to_string())
}

/// The record of what Writer edited lives in the repo's git dir: it survives a
/// restart, is never committed, and goes away with the repo.
fn edited_record(git_dir: &Path) -> PathBuf {
    git_dir.join("writer-edited")
}

static EDITED_LOCK: Mutex<()> = Mutex::new(());

/// Remember that Writer changed `path`, for the next Push. A path outside any
/// repo is ignored. A failure here must not fail the save that called it.
pub fn note_edited(path: &Path) {
    if let Some((record, relative)) = record_for(path) {
        let _guard = EDITED_LOCK.lock();
        let line = format!("{relative}\0");
        let written = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&record)
            .and_then(|mut file| file.write_all(line.as_bytes()));
        if let Err(error) = written {
            eprintln!("Couldn't record an edit for git: {error}");
        }
    }
}

fn record_for(path: &Path) -> Option<(PathBuf, String)> {
    // The file may be gone already, after a delete or a rename.
    let full = std::fs::canonicalize(path).ok().or_else(|| {
        let parent = std::fs::canonicalize(path.parent()?).ok()?;
        Some(parent.join(path.file_name()?))
    })?;
    let top = full
        .ancestors()
        .skip(1)
        .find(|dir| dir.join(".git").exists())?;
    let dot_git = top.join(".git");
    // A linked worktree or submodule has a `.git` file pointing at its git dir.
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        let text = std::fs::read_to_string(&dot_git).ok()?;
        top.join(text.strip_prefix("gitdir:")?.trim())
    };
    let relative = full.strip_prefix(top).ok()?.to_string_lossy().into_owned();
    Some((edited_record(&git_dir), relative))
}

fn read_edited(repo: &Repo) -> Vec<String> {
    let _guard = EDITED_LOCK.lock();
    let text = std::fs::read_to_string(edited_record(&repo.git_dir)).unwrap_or_default();
    let mut paths: Vec<String> = text
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(String::from)
        .collect();
    paths.sort();
    paths.dedup();
    paths
}

/// Which of `paths` git sees as changed, in git's own spelling of the names.
/// Asking git avoids comparing Unicode forms: macOS paths can be decomposed
/// while git reports them composed. Ignored files never appear.
fn changed_among(at_top: &Git, paths: &[String]) -> Result<Vec<String>, Stop> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut args = vec![
        "--no-optional-locks",
        "status",
        "--porcelain",
        "--no-renames",
        "--untracked-files=all",
        "-z",
        "--",
    ];
    args.extend(paths.iter().map(String::as_str));
    let stdout = at_top.must(&args)?;
    Ok(stdout
        .split('\0')
        .filter_map(|record| record.get(3..))
        .filter(|path| !path.is_empty())
        .map(String::from)
        .collect())
}

/// Keep only what still has changes. An edit landing after the commit is still
/// changed, so it isn't forgotten.
fn forget_committed(at_top: &Git, repo: &Repo) -> Result<(), Stop> {
    let remaining = changed_among(at_top, &read_edited(repo))?;
    let _guard = EDITED_LOCK.lock();
    let text: String = remaining.iter().map(|path| format!("{path}\0")).collect();
    std::fs::write(edited_record(&repo.git_dir), text).map_err(|error| {
        stop(
            GitKind::Other,
            format!("Couldn't update the edit list: {error}"),
        )
    })
}

/// Stage and commit what Writer edited. Credential-looking files stay out.
fn commit_edited(at_top: &Git, repo: &Repo, progress: &mut Progress) -> Result<(), Stop> {
    let changed = changed_among(at_top, &read_edited(repo))?;
    let (held, chosen): (Vec<String>, Vec<String>) = changed
        .into_iter()
        .partition(|path| looks_like_credentials(&repo.top, path));
    if !held.is_empty() {
        progress.said.push(format!(
            "Left out {}: it looks like credentials.",
            list(&held)
        ));
    }
    if chosen.is_empty() {
        return Ok(());
    }
    let pathspec: Vec<&str> = chosen.iter().map(String::as_str).collect();
    // `add` fails on a deletion that is already staged: gone from disk and index.
    let tracked = at_top.must(&[&["ls-files", "-z", "--"], pathspec.as_slice()].concat())?;
    let tracked: Vec<&str> = tracked.split('\0').collect();
    let addable: Vec<&str> = pathspec
        .iter()
        .copied()
        .filter(|path| tracked.contains(path) || repo.top.join(path).symlink_metadata().is_ok())
        .collect();
    if !addable.is_empty() {
        at_top.must(&[&["add", "-A", "--"], addable.as_slice()].concat())?;
    }
    let names: Vec<String> = chosen
        .iter()
        .map(|path| {
            Path::new(path)
                .file_name()
                .map_or(path.clone(), |name| name.to_string_lossy().into_owned())
        })
        .collect();
    commit(at_top, &format!("Edited {}", list(&names)), &pathspec)?;
    forget_committed(at_top, repo)?;
    progress
        .said
        .push(format!("Committed {}.", count(chosen.len(), "file")));
    Ok(())
}

struct Upstream {
    remote: String,
    merge_ref: String,
}

/// The branch's linked remote branch; `None` when it hasn't been published yet.
fn upstream_of(git: &Git, branch: &str) -> Result<Option<Upstream>, Stop> {
    if git.must(&["remote"])?.trim().is_empty() {
        return Err(stop(
            GitKind::NoRemote,
            "This repo has no remote yet, so there's nowhere to pull from or push to. Add one \
             with `git remote add origin <url>`.",
        ));
    }
    let remote = config_value(git, &format!("branch.{branch}.remote"))?;
    let merge_ref = config_value(git, &format!("branch.{branch}.merge"))?;
    Ok(match (remote, merge_ref) {
        (Some(remote), Some(merge_ref)) if remote != "." => Some(Upstream { remote, merge_ref }),
        _ => None,
    })
}

fn fetch(git: &Git, upstream: &Upstream) -> Result<(), Stop> {
    let output = git.spawn(&["fetch", &upstream.remote], git.network_timeout)?;
    if output.success {
        Ok(())
    } else {
        Err(classify(&output, "fetch", git.network_timeout))
    }
}

/// All or nothing: a fast-forward either applies whole or leaves every file and
/// commit as it was, so this needs no conflict handling at all. Fetching first
/// keeps the slow network part outside the save gate.
fn pull_op(git: &Git, repo: &Repo, progress: &mut Progress) -> Result<(), Stop> {
    let branch = preflight(git, repo)?;
    let Some(upstream) = upstream_of(git, &branch)? else {
        return Err(stop(
            GitKind::NoUpstream,
            format!("Branch {branch} isn't on the remote yet, so there's nothing to pull."),
        ));
    };
    fetch(git, &upstream)?;
    let Some(target) = verify(git, "@{u}^{commit}")? else {
        progress.said.push("Nothing to pull.".into());
        return Ok(());
    };
    let before = verify(git, "HEAD^{commit}")?;
    let incoming = match &before {
        Some(before) => {
            let range = format!("{before}..{target}");
            if git.must(&["rev-list", "--count", &range])?.trim() == "0" {
                progress.said.push("Already up to date.".into());
                return Ok(());
            }
            if !git
                .local(&["merge-base", "--is-ancestor", before, &target])?
                .success
            {
                return Err(stop(
                    GitKind::CantPull,
                    "Didn't pull, nothing changed. This branch and the remote each have commits \
                     the other doesn't. Sort it out in a terminal with `git pull`.",
                ));
            }
            git.must(&["diff", "--name-only", "--no-renames", "-z", &range])?
        }
        None => git.must(&["ls-tree", "-r", "--name-only", "-z", &target])?,
    };

    let output = {
        let _gate = WORKTREE_GATE.write();
        // Stated explicitly so a user's merge.autoStash can't change what Pull does.
        git.local(&["merge", "--ff-only", "--no-autostash", &target])?
    };
    if output.timed_out {
        progress.worktree_changed = true;
        return Err(classify(&output, "merge", git.local_timeout));
    }
    if !output.success {
        let said = format!("{}\n{}", output.stdout, output.stderr);
        if said.contains("would be overwritten") {
            return Err(stop(
                GitKind::CantPull,
                format!(
                    "Didn't pull, nothing changed. Files you changed locally also changed on the \
                     remote. Sort it out in a terminal with `git pull`.\n{}",
                    said_by_git(&output)
                ),
            ));
        }
        return Err(classify(&output, "merge", git.local_timeout));
    }
    let pulled: Vec<String> = incoming
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(|path| repo.top.join(path).to_string_lossy().into_owned())
        .collect();
    progress
        .said
        .push(format!("Pulled {}.", count(pulled.len(), "file")));
    progress.worktree_changed = true;
    progress.pulled = pulled;
    Ok(())
}

/// Check the remote first: committing onto a branch that is behind would leave
/// two histories that Pull then refuses to join.
fn push_op(git: &Git, repo: &Repo, progress: &mut Progress) -> Result<(), Stop> {
    let branch = preflight(git, repo)?;
    let upstream = upstream_of(git, &branch)?;
    if let Some(upstream) = &upstream {
        fetch(git, upstream)?;
        if verify(git, "@{u}^{commit}")?.is_some()
            && git.must(&["rev-list", "--count", "HEAD..@{u}"])?.trim() != "0"
        {
            return Err(stop(
                GitKind::BehindRemote,
                "Didn't push, nothing changed. The remote has newer commits: pull first.",
            ));
        }
    }
    commit_edited(&git.at(&repo.top), repo, progress)?;
    match &upstream {
        Some(upstream) => push_step(git, upstream, progress),
        None => publish(git, &branch, progress),
    }
}

fn push_step(git: &Git, upstream: &Upstream, progress: &mut Progress) -> Result<(), Stop> {
    let unpushed = match verify(git, "@{u}^{commit}")? {
        Some(_) => git
            .must(&["rev-list", "--count", "@{u}..HEAD"])?
            .trim()
            .parse()
            .unwrap_or(0),
        None => 1,
    };
    if unpushed == 0 {
        progress.said.push("Nothing to push.".into());
        return Ok(());
    }
    // An explicit refspec without `+`, so push.default and configured refspecs
    // can't widen it or turn it into a force-push.
    let refspec = format!("HEAD:{}", upstream.merge_ref);
    let output = git.spawn(&["push", &upstream.remote, &refspec], git.network_timeout)?;
    if !output.success {
        return Err(push_failure(git, &output));
    }
    progress
        .said
        .push(format!("Pushed {}.", count(unpushed, "commit")));
    Ok(())
}

/// First push of a branch: create it on the remote and link it.
fn publish(git: &Git, branch: &str, progress: &mut Progress) -> Result<(), Stop> {
    let remotes = git.must(&["remote"])?;
    let remotes: Vec<&str> = remotes.lines().collect();
    let remote = match remotes.as_slice() {
        [only] => *only,
        many if many.contains(&"origin") => "origin",
        _ => {
            return Err(stop(
                GitKind::NoUpstream,
                "This repo has several remotes and none is called origin. Run \
                 `git push -u <remote> <branch>` in a terminal to pick one.",
            ))
        }
    };
    let refspec = format!("HEAD:refs/heads/{branch}");
    let output = git.spawn(&["push", "-u", remote, &refspec], git.network_timeout)?;
    if !output.success {
        let failure = push_failure(git, &output);
        if failure.kind == GitKind::PushRejected && output.stderr.contains("[rejected]") {
            return Err(stop(
                GitKind::PushRejected,
                format!(
                    "A different branch called {branch} already exists on {remote}. Nothing was \
                     overwritten. Link them in a terminal if they belong together."
                ),
            ));
        }
        return Err(failure);
    }
    progress
        .said
        .push(format!("Published {branch} to {remote}."));
    Ok(())
}

/// Files that look like credentials, by name or by a key-shaped string inside.
/// Only names ever leave this function.
fn looks_like_credentials(top: &Path, path: &str) -> bool {
    const NAMES: &[&str] = &[
        ".env",
        ".netrc",
        ".npmrc",
        ".pypirc",
        ".git-credentials",
        ".htpasswd",
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
    ];
    const EXTENSIONS: &[&str] = &[".pem", ".key", ".p12", ".pfx", ".ppk", ".jks", ".keystore"];
    const WORDS: &[&str] = &[
        "secret",
        "credential",
        "password",
        "passwd",
        "token",
        "apikey",
    ];
    // A lecture note called "Password hashing" is not a credentials file.
    const PROSE: &[&str] = &[".md", ".markdown", ".txt", ".tex", ".pdf", ".svg"];
    const CONTENT: &[&str] = &[
        "PRIVATE KEY-----",
        "aws_secret_access_key",
        "ghp_",
        "github_pat_",
        "glpat-",
        "sk-ant-",
        "xoxb-",
    ];
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if NAMES.contains(&name.as_str()) || EXTENSIONS.iter().any(|ext| name.ends_with(ext)) {
        return true;
    }
    if name.starts_with(".env.") {
        return !["example", "sample", "template"]
            .iter()
            .any(|safe| name.ends_with(safe));
    }
    let is_prose = PROSE.iter().any(|ext| name.ends_with(ext));
    if !is_prose && WORDS.iter().any(|word| name.contains(word)) {
        return true;
    }
    let file = top.join(path);
    let small = std::fs::metadata(&file).is_ok_and(|m| m.is_file() && m.len() <= MAX_SCANNED_BYTES);
    if !small {
        return false;
    }
    let Ok(bytes) = std::fs::read(&file) else {
        return false;
    };
    let text = String::from_utf8_lossy(&bytes);
    CONTENT.iter().any(|needle| text.contains(needle))
}

fn commit(git: &Git, message: &str, pathspec: &[&str]) -> Result<(), Stop> {
    let mut args = vec!["commit", "-m", message];
    if !pathspec.is_empty() {
        args.push("--");
        args.extend_from_slice(pathspec);
    }
    let output = git.local(&args)?;
    if output.success {
        return Ok(());
    }
    let failure = classify(&output, "commit", git.local_timeout);
    // A commit doesn't touch the network, so words like "Connection refused"
    // came from a hook's own output.
    if matches!(
        failure.kind,
        GitKind::Other | GitKind::Network | GitKind::Auth
    ) && git.has_hook(&["pre-commit", "prepare-commit-msg", "commit-msg"])
    {
        return Err(stop(
            GitKind::Hook,
            format!(
                "A git hook rejected the commit. Your changes are staged, not lost.\n{}",
                said_by_git(&output)
            ),
        ));
    }
    Err(failure)
}

fn config_value(git: &Git, key: &str) -> Result<Option<String>, Stop> {
    let output = git.local(&["config", "--get", key])?;
    let value = output.stdout.trim();
    Ok((output.success && !value.is_empty()).then(|| value.to_string()))
}

fn verify(git: &Git, rev: &str) -> Result<Option<String>, Stop> {
    let output = git.local(&["rev-parse", "--quiet", "--verify", rev])?;
    Ok(output.success.then(|| output.stdout.trim().to_string()))
}

fn push_failure(git: &Git, output: &Output) -> Stop {
    if output.stderr.contains("[remote rejected]") {
        return stop(
            GitKind::PushRejected,
            format!(
                "The remote refused the push, for example because the branch is protected. Your \
                 commits are safe locally.\n{}",
                said_by_git(output)
            ),
        );
    }
    if output.stderr.contains("[rejected]") || output.stderr.contains("Updates were rejected") {
        return stop(
            GitKind::PushRejected,
            "Push rejected: the remote has commits you don't have yet. Nothing was overwritten. \
             Pull, then push again.",
        );
    }
    let failure = classify(output, "push", git.network_timeout);
    if failure.kind == GitKind::Other && git.has_hook(&["pre-push"]) {
        return stop(
            GitKind::Hook,
            format!(
                "The pre-push hook stopped the push. Your commits are safe locally.\n{}",
                said_by_git(output)
            ),
        );
    }
    failure
}

/// One operation at a time per repo.
fn repo_lock(top: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(Default::default).lock();
    locks.entry(top.to_path_buf()).or_default().clone()
}

fn operate(git: &Git, op: impl FnOnce(&Repo, &mut Progress) -> Result<(), Stop>) -> GitOutcome {
    let mut progress = Progress::default();
    let result = open_repo(git).and_then(|repo| {
        let lock = repo_lock(&repo.top);
        let Some(_guard) = lock.try_lock() else {
            return Err(stop(
                GitKind::Busy,
                "Another git operation is still running in this repo.",
            ));
        };
        op(&repo, &mut progress)
    });
    let (ok, kind, failure) = match result {
        Ok(()) => (true, GitKind::Ok, None),
        Err(failure) => (false, failure.kind, Some(failure.message)),
    };
    let mut message = progress.said;
    message.extend(failure);
    GitOutcome {
        ok,
        kind,
        message: redact(&message.join(" ")),
        worktree_changed: progress.worktree_changed,
        pulled: progress.pulled,
    }
}

pub fn pull_impl(git: &Git) -> GitOutcome {
    operate(git, |repo, progress| pull_op(git, repo, progress))
}

pub fn push_impl(git: &Git) -> GitOutcome {
    operate(git, |repo, progress| push_op(git, repo, progress))
}

async fn on_workspace<T: Send + 'static>(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    work: impl FnOnce(&Git) -> T + Send + 'static,
) -> Result<T, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let (root, _) = state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;
    tauri::async_runtime::spawn_blocking(move || work(&Git::new(&root)))
        .await
        .map_err(|error| AppError::Io(format!("Git task failed: {error}")))
}

#[tauri::command]
pub async fn git_pull(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<GitOutcome, AppError> {
    on_workspace(webview, app, pull_impl).await
}

#[tauri::command]
pub async fn git_push(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<GitOutcome, AppError> {
    on_workspace(webview, app, push_impl).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// A bare remote with two clones, so one clone can move the remote.
    struct Fixture {
        _dir: TempDir,
        remote: PathBuf,
        a: PathBuf,
        b: PathBuf,
    }

    fn raw(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn configure(repo: &Path) {
        raw(repo, &["config", "user.name", "Test"]);
        raw(repo, &["config", "user.email", "test@example.com"]);
        raw(repo, &["config", "commit.gpgsign", "false"]);
        raw(repo, &["config", "core.hooksPath", ".git/hooks"]);
    }

    fn fixture() -> Fixture {
        let dir = TempDir::new().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let remote = root.join("remote.git");
        fs::create_dir(&remote).unwrap();
        raw(&remote, &["init", "--bare", "-b", "main"]);
        let a = root.join("a");
        raw(&root, &["clone", remote.to_str().unwrap(), "a"]);
        raw(&a, &["checkout", "-B", "main"]);
        configure(&a);
        fs::write(a.join("note.md"), "one\ntwo\nthree\n").unwrap();
        raw(&a, &["add", "-A"]);
        raw(&a, &["commit", "-m", "first"]);
        raw(&a, &["push", "-u", "origin", "main"]);
        let b = root.join("b");
        raw(&root, &["clone", remote.to_str().unwrap(), "b"]);
        configure(&b);
        Fixture {
            _dir: dir,
            remote,
            a,
            b,
        }
    }

    /// Put a commit on the remote through clone `b`.
    fn remote_edit(fx: &Fixture, name: &str, text: &str) {
        raw(&fx.b, &["pull", "--ff-only"]);
        fs::write(fx.b.join(name), text).unwrap();
        raw(&fx.b, &["add", "-A"]);
        raw(&fx.b, &["commit", "-m", "from b"]);
        raw(&fx.b, &["push"]);
    }

    fn head(repo: &Path) -> String {
        raw(repo, &["rev-parse", "HEAD"])
    }

    fn remote_head(fx: &Fixture) -> String {
        raw(&fx.remote, &["rev-parse", "main"])
    }

    fn hook(repo: &Path, name: &str, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        let path = repo.join(".git/hooks").join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn edit(repo: &Path, name: &str, text: &str) {
        fs::write(repo.join(name), text).unwrap();
        note_edited(&repo.join(name));
    }

    #[test]
    fn push_commits_only_what_writer_edited() {
        let fx = fixture();
        edit(&fx.a, "mine.md", "mine\n");
        edit(&fx.a, "note.md", "changed\n");
        fs::write(fx.a.join("outside.md"), "edited elsewhere\n").unwrap();

        let outcome = push_impl(&Git::new(&fx.a));

        assert!(outcome.ok, "{}", outcome.message);
        assert_eq!(remote_head(&fx), head(&fx.a));
        assert_eq!(
            raw(&fx.a, &["log", "-1", "--format=%s"]),
            "Edited note.md, mine.md"
        );
        assert_eq!(raw(&fx.a, &["status", "--porcelain"]), "?? outside.md");

        let again = push_impl(&Git::new(&fx.a));
        assert!(again.ok);
        assert_eq!(again.message, "Nothing to push.");
    }

    #[test]
    fn push_refuses_when_behind_and_commits_nothing() {
        let fx = fixture();
        remote_edit(&fx, "theirs.md", "from b\n");
        edit(&fx.a, "mine.md", "mine\n");
        let before = head(&fx.a);

        let outcome = push_impl(&Git::new(&fx.a));

        assert_eq!(outcome.kind, GitKind::BehindRemote, "{}", outcome.message);
        assert_eq!(head(&fx.a), before);

        // Pull goes through around the unrelated edit, and the edit is still queued.
        assert!(pull_impl(&Git::new(&fx.a)).ok);
        let pushed = push_impl(&Git::new(&fx.a));
        assert!(pushed.ok, "{}", pushed.message);
        assert_eq!(raw(&fx.a, &["log", "-1", "--format=%s"]), "Edited mine.md");
    }

    #[test]
    fn pull_fast_forwards_and_reports_files() {
        let fx = fixture();
        remote_edit(&fx, "theirs.md", "from b\n");

        let outcome = pull_impl(&Git::new(&fx.a));

        assert!(outcome.ok, "{}", outcome.message);
        assert!(outcome.worktree_changed);
        assert_eq!(head(&fx.a), remote_head(&fx));
        assert_eq!(
            outcome.pulled,
            vec![fx.a.join("theirs.md").to_string_lossy().into_owned()]
        );
        assert_eq!(pull_impl(&Git::new(&fx.a)).message, "Already up to date.");
    }

    #[test]
    fn pull_refuses_diverged_history_and_changes_nothing() {
        let fx = fixture();
        remote_edit(&fx, "theirs.md", "from b\n");
        fs::write(fx.a.join("mine.md"), "mine\n").unwrap();
        raw(&fx.a, &["add", "-A"]);
        raw(&fx.a, &["commit", "-m", "local"]);
        let before = head(&fx.a);

        let outcome = pull_impl(&Git::new(&fx.a));

        assert_eq!(outcome.kind, GitKind::CantPull, "{}", outcome.message);
        assert!(!outcome.worktree_changed);
        assert_eq!(head(&fx.a), before);
        assert!(!fx.a.join("theirs.md").exists());
        assert!(!fx.a.join(".git/MERGE_HEAD").exists());
    }

    #[test]
    fn pull_refuses_when_a_local_change_overlaps_and_keeps_it() {
        let fx = fixture();
        remote_edit(&fx, "note.md", "theirs\n");
        remote_edit(&fx, "other.md", "also theirs\n");
        fs::write(fx.a.join("note.md"), "mine\n").unwrap();
        let before = head(&fx.a);

        let outcome = pull_impl(&Git::new(&fx.a));

        assert_eq!(outcome.kind, GitKind::CantPull, "{}", outcome.message);
        assert_eq!(head(&fx.a), before);
        assert_eq!(fs::read_to_string(fx.a.join("note.md")).unwrap(), "mine\n");
        assert!(!fx.a.join("other.md").exists(), "must be all or nothing");
    }

    #[test]
    fn credentials_stay_out_and_are_named() {
        let fx = fixture();
        edit(&fx.a, ".env", "API_KEY=abc\n");
        edit(&fx.a, "ok.md", "fine\n");

        let outcome = push_impl(&Git::new(&fx.a));

        assert!(outcome.ok, "{}", outcome.message);
        assert!(outcome.message.contains(".env"));
        assert!(!outcome.message.contains("abc"));
        assert_eq!(raw(&fx.a, &["log", "-1", "--format=%s"]), "Edited ok.md");
        assert_eq!(raw(&fx.a, &["status", "--porcelain"]), "?? .env");
    }

    #[test]
    fn gitignored_edits_are_not_committed() {
        let fx = fixture();
        fs::write(fx.a.join(".git/info/exclude"), "secret.md\n").unwrap();
        edit(&fx.a, "secret.md", "private\n");
        let before = head(&fx.a);

        assert!(push_impl(&Git::new(&fx.a)).ok);
        assert_eq!(head(&fx.a), before);
    }

    #[test]
    fn deletes_and_renames_made_in_writer_are_committed() {
        let fx = fixture();
        crate::commands::fs::rename_entry_impl(
            fx.a.join("note.md").to_str().unwrap(),
            fx.a.join("moved.md").to_str().unwrap(),
        )
        .unwrap();

        let outcome = push_impl(&Git::new(&fx.a));

        assert!(outcome.ok, "{}", outcome.message);
        assert_eq!(raw(&fx.a, &["ls-files"]), "moved.md");
        assert_eq!(raw(&fx.a, &["status", "--porcelain"]), "");
    }

    #[test]
    fn a_staged_deletion_can_be_committed() {
        let fx = fixture();
        raw(&fx.a, &["rm", "-q", "note.md"]);
        note_edited(&fx.a.join("note.md"));

        let outcome = push_impl(&Git::new(&fx.a));

        assert!(outcome.ok, "{}", outcome.message);
        assert_eq!(raw(&fx.a, &["ls-files", "note.md"]), "");
    }

    #[test]
    fn decomposed_file_names_are_found() {
        let fx = fixture();
        edit(&fx.a, "cast\u{030C}.md", "text\n");
        let outcome = push_impl(&Git::new(&fx.a));
        assert!(outcome.ok, "{}", outcome.message);
        assert_eq!(raw(&fx.a, &["status", "--porcelain"]), "");
    }

    #[test]
    fn edits_survive_in_the_record_until_committed() {
        let fx = fixture();
        hook(&fx.a, "pre-commit", "echo hook said no >&2; exit 1");
        edit(&fx.a, "mine.md", "mine\n");

        let outcome = push_impl(&Git::new(&fx.a));
        assert_eq!(outcome.kind, GitKind::Hook, "{}", outcome.message);
        assert!(outcome.message.contains("hook said no"));
        assert_eq!(remote_head(&fx), raw(&fx.a, &["rev-parse", "HEAD"]));

        fs::remove_file(fx.a.join(".git/hooks/pre-commit")).unwrap();
        assert!(push_impl(&Git::new(&fx.a)).ok);
        assert_eq!(raw(&fx.a, &["log", "-1", "--format=%s"]), "Edited mine.md");
    }

    #[test]
    fn rejected_push_keeps_the_commit_and_never_forces() {
        let fx = fixture();
        hook(&fx.remote, "pre-receive", "exit 1");
        raw(&fx.remote, &["config", "core.hooksPath", "hooks"]);
        fs::create_dir_all(fx.remote.join("hooks")).unwrap();
        fs::rename(
            fx.remote.join(".git/hooks/pre-receive"),
            fx.remote.join("hooks/pre-receive"),
        )
        .unwrap();
        let before = remote_head(&fx);
        edit(&fx.a, "mine.md", "mine\n");

        let outcome = push_impl(&Git::new(&fx.a));

        assert_eq!(outcome.kind, GitKind::PushRejected, "{}", outcome.message);
        assert!(outcome.message.contains("Committed 1 file"));
        assert_eq!(remote_head(&fx), before);
    }

    #[test]
    fn first_push_publishes_the_branch() {
        let fx = fixture();
        raw(&fx.a, &["checkout", "-q", "-b", "topic"]);
        edit(&fx.a, "mine.md", "mine\n");

        let outcome = push_impl(&Git::new(&fx.a));

        assert!(outcome.ok, "{}", outcome.message);
        assert_eq!(raw(&fx.remote, &["rev-parse", "topic"]), head(&fx.a));
        let pull = pull_impl(&Git::new(&fx.a));
        assert!(pull.ok, "{}", pull.message);
    }

    #[test]
    fn states_that_must_stop_say_why() {
        let dir = TempDir::new().unwrap();
        assert_eq!(pull_impl(&Git::new(dir.path())).kind, GitKind::NoRepo);
        raw(dir.path(), &["init", "-q"]);
        assert_eq!(push_impl(&Git::new(dir.path())).kind, GitKind::NoRemote);

        let fx = fixture();
        let git = Git::new(&fx.a);
        fs::write(fx.a.join(".git/index.lock"), "").unwrap();
        assert_eq!(push_impl(&git).kind, GitKind::IndexLocked);
        fs::remove_file(fx.a.join(".git/index.lock")).unwrap();

        fs::create_dir(fx.a.join(".git/rebase-merge")).unwrap();
        assert_eq!(pull_impl(&git).kind, GitKind::InProgress);
        fs::remove_dir(fx.a.join(".git/rebase-merge")).unwrap();

        raw(&fx.a, &["checkout", "-q", "--detach"]);
        assert_eq!(push_impl(&git).kind, GitKind::Detached);
    }

    #[test]
    fn no_network_commits_nothing_and_strips_the_token() {
        let fx = fixture();
        raw(
            &fx.a,
            &[
                "remote",
                "set-url",
                "origin",
                "https://me:tok3n@127.0.0.1:9/x.git",
            ],
        );
        edit(&fx.a, "mine.md", "mine\n");
        let before = head(&fx.a);

        let outcome = push_impl(&Git::new(&fx.a));

        assert_eq!(outcome.kind, GitKind::Network, "{}", outcome.message);
        assert!(!outcome.message.contains("tok3n"), "{}", outcome.message);
        assert_eq!(head(&fx.a), before);
    }

    #[test]
    fn git_missing_is_reported() {
        let fx = fixture();
        let mut git = Git::new(&fx.a);
        git.program = "/nonexistent/git".into();
        assert_eq!(pull_impl(&git).kind, GitKind::NotInstalled);
    }

    #[test]
    fn a_stuck_command_times_out() {
        let fx = fixture();
        hook(&fx.a, "pre-commit", "sleep 60");
        edit(&fx.a, "mine.md", "mine\n");
        let mut git = Git::new(&fx.a);
        git.local_timeout = Duration::from_secs(3);
        let started = Instant::now();
        let outcome = push_impl(&git);
        assert_eq!(outcome.kind, GitKind::Timeout, "{}", outcome.message);
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn a_lock_on_another_file_does_not_blame_the_index() {
        let output = Output {
            success: false,
            timed_out: false,
            stdout: String::new(),
            stderr: "fatal: Unable to create '/r/.git/refs/x.lock': File exists.".into(),
        };
        let stopped = classify(&output, "fetch", LOCAL_TIMEOUT);
        assert_eq!(stopped.kind, GitKind::IndexLocked);
        assert!(!stopped.message.contains("index.lock"));
    }

    #[test]
    fn redaction_handles_a_quote_in_the_password() {
        assert_eq!(redact("https://u:p'q@host/x"), "https://host/x");
        assert_eq!(redact("'https://host/x'"), "'https://host/x'");
    }

    #[test]
    fn saves_wait_for_the_merge_gate() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a.md");
        fs::write(&path, "before").unwrap();
        let held = WORKTREE_GATE.write();
        let writer = {
            let path = path.to_string_lossy().into_owned();
            std::thread::spawn(move || crate::commands::fs::write_file_impl(&path, "after"))
        };
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(fs::read_to_string(&path).unwrap(), "before");
        drop(held);
        writer.join().unwrap().unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "after");
    }

    #[test]
    fn redaction_strips_credentials_from_urls() {
        assert_eq!(
            redact("fatal: unable to access 'https://bob:hunter2@host.example/r.git/': 403"),
            "fatal: unable to access 'https://host.example/r.git/': 403"
        );
        assert_eq!(
            redact("https://ghp_abc@github.com/x"),
            "https://github.com/x"
        );
        assert_eq!(
            redact("a ssh://git:pw@h:22/r b http://u:p@q/ c"),
            "a ssh://h:22/r b http://q/ c"
        );
        assert_eq!(
            redact("git@github.com:me/repo.git"),
            "git@github.com:me/repo.git"
        );
        assert_eq!(redact("no url here"), "no url here");
    }
}
