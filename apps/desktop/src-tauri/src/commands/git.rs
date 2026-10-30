//! Workspace git: status, sync, pull, push, commit and merge abort through the
//! system `git`, so ssh keys and credential helpers keep working. See
//! `SPECs/git-sync-spec.md`.
//!
//! Git never gets a terminal, and Writer never sees a password or token. No
//! operation here may force-push, hard-reset or pick a side of a conflict.

use crate::error::AppError;
use crate::AppState;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

const STATUS_TIMEOUT: Duration = Duration::from_secs(30);
const LOCAL_TIMEOUT: Duration = Duration::from_secs(120);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(300);
/// SIGTERM lets git remove its lock files; SIGKILL follows only after this.
const TERM_GRACE: Duration = Duration::from_secs(5);
/// A forked ssh ControlMaster can hold our pipes open long after git exits.
const PIPE_GRACE: Duration = Duration::from_secs(2);
const MAX_SCANNED_BYTES: u64 = 1024 * 1024;
const MAX_ERROR_LINES: usize = 12;
const MAX_LISTED: usize = 8;

/// Held for writing during the short local merge, and for reading by every
/// Writer text save. A save that arrives mid-merge waits, then meets the merged
/// bytes in its expected-content check, so it becomes a visible conflict rather
/// than a write into a half-merged tree.
///
/// ponytail: one process-wide gate, so a merge in one repo briefly pauses saves
/// in another. Key it by repo root if merges ever take long enough to notice.
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
    Conflict,
    IndexLocked,
    Network,
    Auth,
    PushRejected,
    Hook,
    LocalChanges,
    Timeout,
    Secrets,
    OneSided,
    NothingToCommit,
    NoIdentity,
    Busy,
    Other,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    /// Porcelain letter: `A`, `M`, `D`, `T`, `?` (untracked) or `U` (conflict).
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// `Ok`, `NoRepo`, `NotInstalled`, or `Other` with `message` set.
    pub kind: Option<GitKind>,
    pub message: Option<String>,
    pub repo_root: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub has_remote: bool,
    pub ahead: u32,
    pub behind: u32,
    /// Changes inside this workspace folder, relative to the repo root.
    pub files: Vec<GitFile>,
    /// Changes elsewhere in the repo, which Sync leaves alone.
    pub outside_changes: usize,
    /// `merge`, `rebase`, `cherry-pick`, `revert` or `bisect`.
    pub in_progress: Option<String>,
    /// Repo-relative, across the whole repo.
    pub conflicts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitOutcome {
    pub ok: bool,
    pub kind: GitKind,
    pub message: String,
    /// Git may have rewritten files, so open buffers must be re-checked.
    pub worktree_changed: bool,
    /// Absolute paths the pull brought in.
    pub pulled: Vec<String>,
    /// Names only: files that look like credentials, awaiting confirmation.
    pub suspects: Vec<String>,
    pub status: GitStatus,
}

#[derive(Debug)]
struct Stop {
    kind: GitKind,
    message: String,
    suspects: Vec<String>,
}

fn stop(kind: GitKind, message: impl Into<String>) -> Stop {
    Stop {
        kind,
        message: message.into(),
        suspects: Vec::new(),
    }
}

/// Everything an operation achieved before it finished or stopped, so a failed
/// push still reports the commit that landed.
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
    index_file: Option<PathBuf>,
}

impl Git {
    pub fn new(cwd: &Path) -> Self {
        Self {
            program: "git".into(),
            cwd: cwd.to_path_buf(),
            local_timeout: LOCAL_TIMEOUT,
            network_timeout: NETWORK_TIMEOUT,
            index_file: None,
        }
    }

    fn at(&self, cwd: &Path) -> Self {
        Self {
            program: self.program.clone(),
            cwd: cwd.to_path_buf(),
            local_timeout: self.local_timeout,
            network_timeout: self.network_timeout,
            index_file: self.index_file.clone(),
        }
    }

    fn spawn(&self, args: &[&str], timeout: Duration) -> Result<Output, Stop> {
        let mut command = Command::new(&self.program);
        // `--literal-pathspecs`: a note named `:(top)x` is just a note.
        // `core.fsmonitor`: the passive status check must not run a program named
        // in a downloaded folder's `.git/config`. Clean filters there still can,
        // as with any git client; see the spec.
        command
            .args(["--literal-pathspecs", "-c", "core.fsmonitor=false"])
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
        if let Some(index) = &self.index_file {
            command.env("GIT_INDEX_FILE", index);
        }
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
    /// Workspace folder relative to the repo root; empty when they coincide.
    scope: String,
}

impl Repo {
    fn pathspec(&self) -> &str {
        if self.scope.is_empty() {
            "."
        } else {
            &self.scope
        }
    }

    fn in_scope(&self, path: &str) -> bool {
        self.scope.is_empty()
            || path
                .strip_prefix(self.scope.as_str())
                .is_some_and(|rest| rest.starts_with('/'))
    }
}

fn open_repo(git: &Git) -> Result<Repo, Stop> {
    let output = git.spawn(
        &[
            "rev-parse",
            "--show-toplevel",
            "--absolute-git-dir",
            "--show-prefix",
        ],
        STATUS_TIMEOUT,
    )?;
    if !output.success {
        if output.stderr.contains("not a git repository") {
            return Err(stop(
                GitKind::NoRepo,
                "This folder isn't a git repository yet.",
            ));
        }
        // Includes a bare repo or being inside .git, which have no work tree.
        return Err(classify(&output, "rev-parse", STATUS_TIMEOUT));
    }
    let mut lines = output.stdout.lines();
    let (Some(top), Some(git_dir)) = (lines.next(), lines.next()) else {
        return Err(stop(GitKind::Other, "Git didn't report a repository root."));
    };
    // Git's own prefix, so it has the same Unicode form as the paths status reports.
    let scope = lines.next().unwrap_or("").trim_end_matches('/').to_string();
    Ok(Repo {
        top: PathBuf::from(top),
        git_dir: PathBuf::from(git_dir),
        scope,
    })
}

fn in_progress(git_dir: &Path) -> Option<String> {
    [
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("BISECT_LOG", "bisect"),
    ]
    .iter()
    .find(|(file, _)| git_dir.join(file).exists())
    .map(|(_, name)| (*name).to_string())
}

fn read_status(git: &Git, repo: &Repo) -> Result<GitStatus, Stop> {
    let at_top = git.at(&repo.top);
    let output = at_top.spawn(
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "--branch",
            "--no-renames",
            "--untracked-files=all",
            "-z",
        ],
        STATUS_TIMEOUT,
    )?;
    if !output.success {
        return Err(classify(&output, "status", STATUS_TIMEOUT));
    }
    let mut status = GitStatus {
        kind: Some(GitKind::Ok),
        repo_root: Some(repo.top.to_string_lossy().into_owned()),
        in_progress: in_progress(&repo.git_dir),
        ..Default::default()
    };
    for record in output.stdout.split('\0') {
        if let Some(head) = record.strip_prefix("# branch.head ") {
            status.branch = (head != "(detached)").then(|| head.to_string());
        } else if let Some(upstream) = record.strip_prefix("# branch.upstream ") {
            status.upstream = Some(upstream.to_string());
        } else if let Some(counts) = record.strip_prefix("# branch.ab ") {
            let mut parts = counts.split(' ').map(|n| n.trim_start_matches(['+', '-']));
            status.ahead = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
            status.behind = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        } else if let Some(path) = record.strip_prefix("? ") {
            push_file(&mut status, repo, path, "?", false);
        } else if let Some(rest) = record.strip_prefix("1 ") {
            let fields: Vec<&str> = rest.splitn(8, ' ').collect();
            if let (Some(xy), Some(path)) = (fields.first(), fields.get(7)) {
                let (x, y) = xy.split_at(1);
                let letter = if y == "." { x } else { y };
                push_file(&mut status, repo, path, letter, x != ".");
            }
        } else if let Some(rest) = record.strip_prefix("u ") {
            if let Some(path) = rest.splitn(10, ' ').nth(9) {
                status.conflicts.push(path.to_string());
                push_file(&mut status, repo, path, "U", false);
            }
        }
    }
    status.has_remote = !at_top.must(&["remote"])?.trim().is_empty();
    Ok(status)
}

fn push_file(status: &mut GitStatus, repo: &Repo, path: &str, letter: &str, staged: bool) {
    if repo.in_scope(path) {
        status.files.push(GitFile {
            path: path.to_string(),
            status: letter.to_string(),
            staged,
        });
    } else {
        status.outside_changes += 1;
    }
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

/// States in which Writer must not start anything. `allow_merge` lets the
/// explicit commit finish a merge.
fn preflight(repo: &Repo, status: &GitStatus, allow_merge: bool) -> Result<(), Stop> {
    if repo.git_dir.join("index.lock").exists() {
        return Err(lock_stop());
    }
    match status.in_progress.as_deref() {
        Some("merge") if !status.conflicts.is_empty() && !allow_merge => {
            return Err(stop(
                GitKind::Conflict,
                format!(
                    "A merge is stopped on conflicts in {}. Fix them and commit, or abort the merge.",
                    list(&status.conflicts)
                ),
            ));
        }
        Some("merge") if !allow_merge => {
            return Err(stop(
                GitKind::InProgress,
                "A merge is in progress. Commit to finish it, or abort it.",
            ));
        }
        Some("merge") | None => {}
        Some(other) => {
            return Err(stop(
                GitKind::InProgress,
                format!(
                    "A {other} is in progress in this repo. Finish or abort it in a terminal; \
                     Writer won't touch it."
                ),
            ));
        }
    }
    if status.branch.is_none() {
        return Err(stop(
            GitKind::Detached,
            "HEAD is detached, so this repo isn't on a branch and new commits could get lost. \
             Check out a branch in a terminal, then try again.",
        ));
    }
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

fn check_suspects(
    repo: &Repo,
    files: &[GitFile],
    chosen: Option<&[String]>,
    allowed: &[String],
) -> Result<(), Stop> {
    let suspects: Vec<String> = files
        .iter()
        .filter(|file| file.status != "D")
        .filter(|file| chosen.is_none_or(|paths| paths.contains(&file.path)))
        .filter(|file| !allowed.contains(&file.path))
        .filter(|file| looks_like_credentials(&repo.top, &file.path))
        .map(|file| file.path.clone())
        .collect();
    if suspects.is_empty() {
        return Ok(());
    }
    Err(Stop {
        kind: GitKind::Secrets,
        message: format!(
            "Nothing was committed. These files look like they hold credentials: {}. Add them to \
             .gitignore, or confirm that they should be committed.",
            list(&suspects)
        ),
        suspects,
    })
}

fn staged_paths(git: &Git, pathspec: &[&str]) -> Result<Vec<String>, Stop> {
    let mut args = vec![
        "diff",
        "--cached",
        "--name-only",
        "--no-renames",
        "-z",
        "--",
    ];
    args.extend_from_slice(pathspec);
    let stdout = git.must(&args)?;
    Ok(stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(String::from)
        .collect())
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

struct Upstream {
    remote: String,
    merge_ref: String,
}

fn config_value(git: &Git, key: &str) -> Result<Option<String>, Stop> {
    let output = git.local(&["config", "--get", key])?;
    let value = output.stdout.trim();
    Ok((output.success && !value.is_empty()).then(|| value.to_string()))
}

fn upstream_of(git: &Git, status: &GitStatus) -> Result<Upstream, Stop> {
    if !status.has_remote {
        return Err(stop(
            GitKind::NoRemote,
            "This repo has no remote yet, so there's nowhere to pull from or push to. Add one \
             with `git remote add origin <url>`.",
        ));
    }
    let branch = status.branch.as_deref().unwrap_or_default();
    let remote = config_value(git, &format!("branch.{branch}.remote"))?;
    let merge_ref = config_value(git, &format!("branch.{branch}.merge"))?;
    match (remote, merge_ref) {
        (Some(remote), Some(merge_ref)) if remote != "." => Ok(Upstream { remote, merge_ref }),
        _ => Err(stop(
            GitKind::NoUpstream,
            format!(
                "Branch {branch} isn't linked to a remote branch yet. Use Publish branch to \
                 create it on the remote."
            ),
        )),
    }
}

fn verify(git: &Git, rev: &str) -> Result<Option<String>, Stop> {
    let output = git.local(&["rev-parse", "--quiet", "--verify", rev])?;
    Ok(output.success.then(|| output.stdout.trim().to_string()))
}

/// Fetch, then merge. Fetching first keeps the slow network part outside the
/// save gate and outside the work tree.
fn pull_step(
    git: &Git,
    repo: &Repo,
    upstream: &Upstream,
    progress: &mut Progress,
) -> Result<(), Stop> {
    let fetch = git.spawn(&["fetch", &upstream.remote], git.network_timeout)?;
    if !fetch.success {
        return Err(classify(&fetch, "fetch", git.network_timeout));
    }
    let Some(target) = verify(git, "@{u}^{commit}")? else {
        // The remote branch doesn't exist yet; the push step creates it.
        return Ok(());
    };
    let before = verify(git, "HEAD^{commit}")?;
    if let Some(before) = &before {
        let range = format!("{before}..{target}");
        if git.must(&["rev-list", "--count", &range])?.trim() == "0" {
            progress.said.push("Already up to date.".into());
            return Ok(());
        }
    }
    let incoming = match &before {
        Some(before) => {
            let range = format!("{before}...{target}");
            git.must(&["diff", "--name-only", "--no-renames", "-z", &range])?
        }
        None => git.must(&["ls-tree", "-r", "--name-only", "-z", &target])?,
    };

    let output = {
        let _gate = WORKTREE_GATE.write();
        // Stated explicitly so a user's merge.ff=only or merge.autoStash can't
        // change what Sync does.
        git.local(&[
            "merge",
            "--no-edit",
            "--ff",
            "--no-autostash",
            "-m",
            "Merge remote changes",
            &target,
        ])?
    };
    let incoming: Vec<String> = incoming
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(|path| repo.top.join(path).to_string_lossy().into_owned())
        .collect();
    if output.success {
        progress
            .said
            .push(format!("Pulled {}.", count(incoming.len(), "file")));
        progress.worktree_changed = true;
        progress.pulled = incoming;
        return Ok(());
    }

    if output.stdout.contains("would be overwritten")
        || output.stderr.contains("would be overwritten")
    {
        let names: Vec<String> = output
            .stderr
            .lines()
            .filter_map(|line| line.strip_prefix('\t'))
            .map(|name| name.trim().to_string())
            .collect();
        return Err(stop(
            GitKind::LocalChanges,
            format!(
                "Pull stopped before changing anything: uncommitted edits to {} would be \
                 overwritten. Commit them or use Sync, then pull again.",
                list(&names)
            ),
        ));
    }
    if output
        .stderr
        .contains("refusing to merge unrelated histories")
    {
        return Err(stop(
            GitKind::Other,
            "This branch and the remote branch share no history, so Writer won't combine them. \
             Nothing changed. Sort this out in a terminal.",
        ));
    }
    let failed = read_status(git, repo)?;
    if !failed.conflicts.is_empty() {
        progress.worktree_changed = true;
        progress.pulled = incoming;
        return Err(stop(
            GitKind::Conflict,
            format!(
                "The pull conflicts with your changes in {}. Nothing was pushed or discarded. \
                 Fix the marked sections and commit, or abort the merge.",
                list(&failed.conflicts)
            ),
        ));
    }
    if failed.in_progress.as_deref() == Some("merge") {
        progress.worktree_changed = true;
        let hooked = git.has_hook(&["pre-merge-commit", "prepare-commit-msg", "commit-msg"]);
        let (kind, reason) = if output.timed_out {
            (GitKind::Timeout, "git merge took too long and was stopped")
        } else if hooked {
            (GitKind::Hook, "A hook stopped the merge")
        } else {
            (GitKind::Other, "Git stopped before committing the merge")
        };
        return Err(stop(
            kind,
            format!(
                "{reason}. It is still in progress: commit to finish it, or abort it.\n{}",
                said_by_git(&output)
            ),
        ));
    }
    progress.worktree_changed = output.timed_out;
    Err(classify(&output, "merge", git.local_timeout))
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
             Sync or pull to merge them, then push again.",
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

fn stage_and_commit_all(
    git: &Git,
    repo: &Repo,
    status: &GitStatus,
    message: &str,
    allowed: &[String],
    progress: &mut Progress,
) -> Result<(), Stop> {
    check_suspects(repo, &status.files, None, allowed)?;
    let at_top = git.at(&repo.top);
    let scope = [repo.pathspec()];
    at_top.must(&["add", "-A", "--", repo.pathspec()])?;
    let staged = staged_paths(&at_top, &scope)?;
    if staged.is_empty() {
        return Ok(());
    }
    require_message(message)?;
    commit(&at_top, message, &scope)?;
    progress
        .said
        .push(format!("Committed {}.", count(staged.len(), "file")));
    Ok(())
}

fn require_message(message: &str) -> Result<(), Stop> {
    if message.trim().is_empty() {
        return Err(stop(GitKind::Other, "The commit message is empty."));
    }
    Ok(())
}

fn sync_op(
    git: &Git,
    repo: &Repo,
    message: &str,
    allowed: &[String],
    progress: &mut Progress,
) -> Result<(), Stop> {
    let status = read_status(git, repo)?;
    preflight(repo, &status, false)?;
    stage_and_commit_all(git, repo, &status, message, allowed, progress)?;
    let upstream = upstream_of(git, &status)?;
    pull_step(git, repo, &upstream, progress)?;
    push_step(git, &upstream, progress)
}

fn pull_op(git: &Git, repo: &Repo, progress: &mut Progress) -> Result<(), Stop> {
    let status = read_status(git, repo)?;
    preflight(repo, &status, false)?;
    let upstream = upstream_of(git, &status)?;
    pull_step(git, repo, &upstream, progress)
}

fn push_op(git: &Git, repo: &Repo, progress: &mut Progress) -> Result<(), Stop> {
    let status = read_status(git, repo)?;
    preflight(repo, &status, false)?;
    let upstream = upstream_of(git, &status)?;
    push_step(git, &upstream, progress)
}

fn publish_op(git: &Git, repo: &Repo, progress: &mut Progress) -> Result<(), Stop> {
    let status = read_status(git, repo)?;
    preflight(repo, &status, false)?;
    let branch = status.branch.clone().unwrap_or_default();
    let remotes = git.must(&["remote"])?;
    let remotes: Vec<&str> = remotes.lines().collect();
    let remote = match remotes.as_slice() {
        [] => {
            return Err(upstream_of(git, &status)
                .err()
                .unwrap_or_else(|| stop(GitKind::NoRemote, "No remote.")))
        }
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

fn commit_op(
    git: &Git,
    repo: &Repo,
    paths: &[String],
    message: &str,
    allowed: &[String],
    sides: &[String],
    progress: &mut Progress,
) -> Result<(), Stop> {
    let status = read_status(git, repo)?;
    preflight(repo, &status, true)?;
    let merging = status.in_progress.as_deref() == Some("merge");
    if paths.is_empty() && !merging {
        return Err(stop(
            GitKind::NothingToCommit,
            "Choose at least one file to commit.",
        ));
    }
    require_message(message)?;
    check_suspects(repo, &status.files, Some(paths), allowed)?;

    // Staging a conflicted file marks it resolved, so every check on one comes
    // before `git add`. A merge commits the whole index and git forbids a partial one.
    let at_top = git.at(&repo.top);
    let left_out: Vec<String> = status
        .conflicts
        .iter()
        .filter(|path| !paths.contains(path))
        .cloned()
        .collect();
    if !left_out.is_empty() {
        return Err(stop(
            GitKind::Conflict,
            format!(
                "Still unresolved: {}. Fix and select them to finish the merge.",
                list(&left_out)
            ),
        ));
    }
    let marked: Vec<String> = status
        .conflicts
        .iter()
        .filter(|path| {
            std::fs::read(repo.top.join(path)).is_ok_and(|bytes| {
                String::from_utf8_lossy(&bytes)
                    .lines()
                    .any(|line| line.starts_with("<<<<<<< ") || line.starts_with(">>>>>>> "))
            })
        })
        .cloned()
        .collect();
    if !marked.is_empty() {
        return Err(stop(
            GitKind::Conflict,
            format!(
                "{} still contains conflict markers. Fix them first.",
                list(&marked)
            ),
        ));
    }
    let mut undecided = Vec::new();
    for path in status.conflicts.iter().filter(|path| !sides.contains(path)) {
        if keeps_one_side(&at_top, repo, path)? {
            undecided.push(path.clone());
        }
    }
    if !undecided.is_empty() {
        return Err(Stop {
            kind: GitKind::OneSided,
            message: format!(
                "Nothing was committed. Git couldn't combine {}, and committing now keeps only \
                 the version on disk. Confirm that, replace the file, or abort the merge.",
                list(&undecided)
            ),
            suspects: undecided,
        });
    }

    let pathspec: Vec<&str> = paths.iter().map(String::as_str).collect();
    if !paths.is_empty() {
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
    }
    if merging {
        commit(&at_top, message, &[])?;
        progress.said.push("Merge committed.".into());
        return Ok(());
    }
    let staged = staged_paths(&at_top, &pathspec)?;
    if staged.is_empty() {
        return Err(stop(
            GitKind::NothingToCommit,
            "The chosen files have no changes to commit.",
        ));
    }
    commit(&at_top, message, &pathspec)?;
    progress
        .said
        .push(format!("Committed {}.", count(staged.len(), "file")));
    Ok(())
}

/// A conflict with nothing to edit, such as a binary or a modify/delete: the
/// file on disk is exactly one side, or gone, so staging it silently drops the other.
fn keeps_one_side(at_top: &Git, repo: &Repo, path: &str) -> Result<bool, Stop> {
    if repo.top.join(path).symlink_metadata().is_err() {
        return Ok(true);
    }
    let on_disk = at_top.must(&["hash-object", "--", path])?;
    let stages = at_top.must(&["ls-files", "-u", "--", path])?;
    Ok(stages
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1))
        .any(|side| side == on_disk.trim()))
}

/// Keep every file as it stands under a local ref. `merge --abort` also drops
/// whatever is staged, including fixes and changes that aren't from the merge.
fn save_before_abort(at_top: &Git, repo: &Repo) -> Result<String, Stop> {
    let index = repo.git_dir.join("writer-abort-index");
    std::fs::copy(repo.git_dir.join("index"), &index)
        .map_err(|error| stop(GitKind::Other, format!("Couldn't copy the index: {error}")))?;
    let mut copy = at_top.at(&repo.top);
    copy.index_file = Some(index.clone());
    let saved = (|| {
        copy.must(&["add", "-A", "--", "."])?;
        let tree = copy.must(&["write-tree"])?;
        let commit = copy.must(&[
            "-c",
            "user.name=Writer",
            "-c",
            "user.email=writer@localhost",
            "commit-tree",
            tree.trim(),
            "-p",
            "HEAD",
            "-m",
            "Files before aborting a merge",
        ])?;
        let commit = commit.trim().to_string();
        let name = format!("refs/writer/before-abort/{commit}");
        copy.must(&["update-ref", &name, &commit])?;
        Ok(commit)
    })();
    let _ = std::fs::remove_file(&index);
    saved
}

fn abort_op(git: &Git, repo: &Repo, progress: &mut Progress) -> Result<(), Stop> {
    if !repo.git_dir.join("MERGE_HEAD").exists() {
        return Err(stop(GitKind::InProgress, "There's no merge to abort."));
    }
    if repo.git_dir.join("index.lock").exists() {
        return Err(lock_stop());
    }
    let at_top = git.at(&repo.top);
    // No copy, no abort: the merge stays recoverable where it is.
    let saved = save_before_abort(&at_top, repo)?;
    let result = {
        let _gate = WORKTREE_GATE.write();
        at_top.must(&["merge", "--abort"])
    };
    progress.worktree_changed = true;
    result?;
    progress.said.push(format!(
        "Merge aborted. Your last commit is back as it was. A copy of the files from just before \
         is in commit {}: to get one back, run `git restore --source={} -- <file>`.",
        &saved[..8],
        &saved[..8]
    ));
    Ok(())
}

/// One operation at a time per repo. Status doesn't take this: it is read-only
/// and uses `--no-optional-locks`.
fn repo_lock(top: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(Default::default).lock();
    locks.entry(top.to_path_buf()).or_default().clone()
}

pub fn status_of(git: &Git) -> GitStatus {
    let result = open_repo(git).and_then(|repo| read_status(git, &repo));
    result.unwrap_or_else(|failure| GitStatus {
        kind: Some(failure.kind),
        message: Some(failure.message),
        ..Default::default()
    })
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
    let status = status_of(git);
    let (ok, kind, failure, suspects) = match result {
        Ok(()) => (true, GitKind::Ok, None, Vec::new()),
        Err(failure) => (false, failure.kind, Some(failure.message), failure.suspects),
    };
    let mut message = progress.said;
    message.extend(failure);
    if message.is_empty() {
        message.push("Nothing to do.".into());
    }
    GitOutcome {
        ok,
        kind,
        message: redact(&message.join(" ")),
        worktree_changed: progress.worktree_changed,
        pulled: progress.pulled,
        suspects,
        status,
    }
}

pub fn sync_impl(git: &Git, message: &str, allowed: &[String]) -> GitOutcome {
    operate(git, |repo, progress| {
        sync_op(git, repo, message, allowed, progress)
    })
}

pub fn pull_impl(git: &Git) -> GitOutcome {
    operate(git, |repo, progress| pull_op(git, repo, progress))
}

pub fn push_impl(git: &Git) -> GitOutcome {
    operate(git, |repo, progress| push_op(git, repo, progress))
}

pub fn publish_impl(git: &Git) -> GitOutcome {
    operate(git, |repo, progress| publish_op(git, repo, progress))
}

pub fn commit_impl(
    git: &Git,
    paths: &[String],
    message: &str,
    allowed: &[String],
    sides: &[String],
) -> GitOutcome {
    operate(git, |repo, progress| {
        commit_op(git, repo, paths, message, allowed, sides, progress)
    })
}

pub fn abort_impl(git: &Git) -> GitOutcome {
    operate(git, |repo, progress| abort_op(git, repo, progress))
}

/// Only on an explicit request, and only where no repository exists yet.
pub fn init_impl(git: &Git) -> GitOutcome {
    let mut progress = Progress::default();
    let before = status_of(git);
    let result = if before.kind == Some(GitKind::NoRepo) {
        git.must(&["init"])
            .map(|_| progress.said.push("Git repository created.".into()))
    } else if before.kind == Some(GitKind::Ok) {
        Err(stop(
            GitKind::Other,
            "This folder is already in a git repository.",
        ))
    } else {
        Err(stop(
            before.kind.unwrap_or(GitKind::Other),
            before.message.unwrap_or_default(),
        ))
    };
    let (ok, kind, message) = match result {
        Ok(()) => (true, GitKind::Ok, progress.said.join(" ")),
        Err(failure) => (false, failure.kind, failure.message),
    };
    GitOutcome {
        ok,
        kind,
        message: redact(&message),
        worktree_changed: false,
        pulled: Vec::new(),
        suspects: Vec::new(),
        status: status_of(git),
    }
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
pub async fn git_status(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<GitStatus, AppError> {
    on_workspace(webview, app, status_of).await
}

#[tauri::command]
pub async fn git_sync(
    message: String,
    allowed: Vec<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<GitOutcome, AppError> {
    on_workspace(webview, app, move |git| sync_impl(git, &message, &allowed)).await
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

#[tauri::command]
pub async fn git_publish(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<GitOutcome, AppError> {
    on_workspace(webview, app, publish_impl).await
}

#[tauri::command]
pub async fn git_commit(
    paths: Vec<String>,
    message: String,
    allowed: Vec<String>,
    sides: Vec<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<GitOutcome, AppError> {
    on_workspace(webview, app, move |git| {
        commit_impl(git, &paths, &message, &allowed, &sides)
    })
    .await
}

#[tauri::command]
pub async fn git_abort_merge(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<GitOutcome, AppError> {
    on_workspace(webview, app, abort_impl).await
}

#[tauri::command]
pub async fn git_init(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<GitOutcome, AppError> {
    on_workspace(webview, app, init_impl).await
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

    #[test]
    fn sync_commits_pulls_and_pushes() {
        let fx = fixture();
        remote_edit(&fx, "theirs.md", "from b\n");
        fs::write(fx.a.join("mine.md"), "mine\n").unwrap();

        let outcome = sync_impl(&Git::new(&fx.a), "my message", &[]);

        assert!(outcome.ok, "{}", outcome.message);
        assert!(outcome.worktree_changed);
        assert_eq!(
            fs::read_to_string(fx.a.join("theirs.md")).unwrap(),
            "from b\n"
        );
        assert!(outcome
            .pulled
            .iter()
            .any(|path| path.ends_with("theirs.md")));
        assert_eq!(head(&fx.a), remote_head(&fx));
        assert!(raw(&fx.a, &["log", "--format=%s"]).contains("my message"));
        assert!(
            outcome.message.contains("Committed 1 file."),
            "{}",
            outcome.message
        );
        assert!(
            outcome.message.contains("Pulled 1 file."),
            "{}",
            outcome.message
        );
        assert!(outcome.message.contains("Pushed"), "{}", outcome.message);
        assert!(outcome.status.files.is_empty());
        assert_eq!((outcome.status.ahead, outcome.status.behind), (0, 0));
    }

    #[test]
    fn sync_with_nothing_to_do_says_so_and_makes_no_commit() {
        let fx = fixture();
        let before = head(&fx.a);
        let outcome = sync_impl(&Git::new(&fx.a), "unused", &[]);
        assert!(outcome.ok);
        assert_eq!(head(&fx.a), before);
        assert_eq!(outcome.message, "Already up to date. Nothing to push.");
    }

    #[test]
    fn sync_respects_gitignore() {
        let fx = fixture();
        fs::write(fx.a.join(".gitignore"), "private.md\n").unwrap();
        fs::write(fx.a.join("private.md"), "keep out\n").unwrap();
        let outcome = sync_impl(&Git::new(&fx.a), "m", &[]);
        assert!(outcome.ok, "{}", outcome.message);
        let tracked = raw(&fx.a, &["ls-files"]);
        assert!(!tracked.contains("private.md"));
        assert!(fx.a.join("private.md").exists());
    }

    #[test]
    fn conflict_stops_keeps_both_sides_and_abort_restores_the_commit() {
        let fx = fixture();
        remote_edit(&fx, "note.md", "one\nTHEIRS\nthree\n");
        fs::write(fx.a.join("note.md"), "one\nMINE\nthree\n").unwrap();
        let before_remote = remote_head(&fx);

        let outcome = sync_impl(&Git::new(&fx.a), "mine", &[]);

        assert_eq!(outcome.kind, GitKind::Conflict, "{}", outcome.message);
        assert!(outcome.worktree_changed);
        assert_eq!(outcome.status.conflicts, vec!["note.md"]);
        assert_eq!(outcome.status.in_progress.as_deref(), Some("merge"));
        assert!(outcome.message.contains("note.md"));
        assert_eq!(remote_head(&fx), before_remote, "must not push on conflict");
        let on_disk = fs::read_to_string(fx.a.join("note.md")).unwrap();
        assert!(
            on_disk.contains("MINE") && on_disk.contains("THEIRS") && on_disk.contains("<<<<<<<")
        );
        let mine = head(&fx.a);

        // A further Sync refuses rather than staging the markers as resolved.
        let again = sync_impl(&Git::new(&fx.a), "again", &[]);
        assert_eq!(again.kind, GitKind::Conflict);
        assert_eq!(
            raw(&fx.a, &["diff", "--name-only", "--diff-filter=U"]),
            "note.md"
        );

        let aborted = abort_impl(&Git::new(&fx.a));
        assert!(aborted.ok, "{}", aborted.message);
        assert!(aborted.worktree_changed);
        assert_eq!(head(&fx.a), mine);
        assert!(aborted.status.in_progress.is_none());
        assert_eq!(
            fs::read_to_string(fx.a.join("note.md")).unwrap(),
            "one\nMINE\nthree\n"
        );
    }

    #[test]
    fn abort_keeps_a_recoverable_copy_of_staged_work() {
        let fx = fixture();
        remote_edit(&fx, "note.md", "one\nTHEIRS\nthree\n");
        fs::write(fx.a.join("note.md"), "one\nMINE\nthree\n").unwrap();
        sync_impl(&Git::new(&fx.a), "mine", &[]);
        fs::write(fx.a.join("other.md"), "unrelated work\n").unwrap();
        fs::write(fx.a.join("note.md"), "half fixed\n").unwrap();
        let chosen = vec!["other.md".to_string()];

        // Leaving out the conflict refuses before anything is staged.
        let early = commit_impl(&Git::new(&fx.a), &chosen, "m", &[], &[]);
        assert_eq!(early.kind, GitKind::Conflict, "{}", early.message);
        assert_eq!(
            raw(
                &fx.a,
                &["diff", "--cached", "--name-only", "--", "other.md"]
            ),
            ""
        );

        raw(&fx.a, &["add", "other.md"]);
        let aborted = abort_impl(&Git::new(&fx.a));
        assert!(aborted.ok, "{}", aborted.message);
        assert!(!fx.a.join("other.md").exists(), "abort removes it");
        let copy = raw(
            &fx.a,
            &[
                "for-each-ref",
                "--format=%(objectname)",
                "refs/writer/before-abort",
            ],
        );
        assert_eq!(
            raw(&fx.a, &["show", &format!("{copy}:other.md")]),
            "unrelated work"
        );
        assert_eq!(
            raw(&fx.a, &["show", &format!("{copy}:note.md")]),
            "half fixed"
        );
        assert!(aborted.message.contains(&copy[..8]));
        assert!(!fx.a.join(".git/writer-abort-index").exists());
    }

    #[test]
    fn a_conflict_without_markers_needs_an_explicit_choice() {
        let fx = fixture();
        remote_edit(&fx, "note.md", "one\nTHEIRS\nthree\n");
        fs::remove_file(fx.a.join("note.md")).unwrap();
        let outcome = sync_impl(&Git::new(&fx.a), "delete it", &[]);
        assert_eq!(outcome.kind, GitKind::Conflict, "{}", outcome.message);
        let paths = vec!["note.md".to_string()];

        let refused = commit_impl(&Git::new(&fx.a), &paths, "m", &[], &[]);
        assert_eq!(refused.kind, GitKind::OneSided, "{}", refused.message);
        assert_eq!(refused.suspects, paths);
        assert_eq!(refused.status.conflicts, paths, "must stay unresolved");

        let chosen = commit_impl(&Git::new(&fx.a), &paths, "m", &[], &paths);
        assert!(chosen.ok, "{}", chosen.message);
        assert!(chosen.status.in_progress.is_none());
    }

    #[test]
    fn a_staged_deletion_can_be_committed() {
        let fx = fixture();
        raw(&fx.a, &["rm", "-q", "note.md"]);
        let paths = vec!["note.md".to_string()];
        let outcome = commit_impl(&Git::new(&fx.a), &paths, "remove", &[], &[]);
        assert!(outcome.ok, "{}", outcome.message);
        assert_eq!(raw(&fx.a, &["ls-files", "note.md"]), "");
    }

    #[test]
    fn redaction_handles_a_quote_in_the_password() {
        assert_eq!(redact("https://u:p'q@host/x"), "https://host/x");
        assert_eq!(redact("'https://host/x'"), "'https://host/x'");
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
    fn a_resolved_conflict_commits_then_syncs() {
        let fx = fixture();
        remote_edit(&fx, "note.md", "one\nTHEIRS\nthree\n");
        fs::write(fx.a.join("note.md"), "one\nMINE\nthree\n").unwrap();
        sync_impl(&Git::new(&fx.a), "mine", &[]);
        let paths = vec!["note.md".to_string()];

        let early = commit_impl(&Git::new(&fx.a), &paths, "merge", &[], &[]);
        assert_eq!(early.kind, GitKind::Conflict);
        assert!(early.message.contains("markers"));
        assert_eq!(
            early.status.conflicts,
            vec!["note.md"],
            "markers must not be marked resolved"
        );

        let unchosen = commit_impl(&Git::new(&fx.a), &[], "merge", &[], &[]);
        assert_eq!(unchosen.kind, GitKind::Conflict);

        fs::write(fx.a.join("note.md"), "one\nBOTH\nthree\n").unwrap();
        let finished = commit_impl(&Git::new(&fx.a), &paths, "merge", &[], &[]);
        assert!(finished.ok, "{}", finished.message);
        let pushed = sync_impl(&Git::new(&fx.a), "unused", &[]);
        assert!(pushed.ok, "{}", pushed.message);
        assert_eq!(head(&fx.a), remote_head(&fx));
    }

    #[test]
    fn pull_only_leaves_local_edits_uncommitted() {
        let fx = fixture();
        remote_edit(&fx, "theirs.md", "from b\n");
        fs::write(fx.a.join("mine.md"), "mine\n").unwrap();
        let before_remote = remote_head(&fx);

        let outcome = pull_impl(&Git::new(&fx.a));

        assert!(outcome.ok, "{}", outcome.message);
        assert!(fx.a.join("theirs.md").exists());
        assert_eq!(outcome.status.files.len(), 1);
        assert_eq!(remote_head(&fx), before_remote);
    }

    #[test]
    fn pull_refuses_to_overwrite_uncommitted_edits() {
        let fx = fixture();
        remote_edit(&fx, "note.md", "one\nTHEIRS\nthree\n");
        fs::write(fx.a.join("note.md"), "one\nMINE\nthree\n").unwrap();

        let outcome = pull_impl(&Git::new(&fx.a));

        assert_eq!(outcome.kind, GitKind::LocalChanges, "{}", outcome.message);
        assert!(outcome.message.contains("note.md"));
        assert!(!outcome.worktree_changed);
        assert_eq!(
            fs::read_to_string(fx.a.join("note.md")).unwrap(),
            "one\nMINE\nthree\n"
        );
        assert!(outcome.status.in_progress.is_none());
    }

    #[test]
    fn merge_settings_cannot_change_what_pull_does() {
        let fx = fixture();
        raw(&fx.a, &["config", "merge.ff", "only"]);
        raw(&fx.a, &["config", "merge.autoStash", "true"]);
        remote_edit(&fx, "theirs.md", "from b\n");
        fs::write(fx.a.join("mine.md"), "mine\n").unwrap();
        let outcome = sync_impl(&Git::new(&fx.a), "m", &[]);
        assert!(outcome.ok, "{}", outcome.message);
        assert_eq!(head(&fx.a), remote_head(&fx));
    }

    #[test]
    fn rejected_push_never_forces() {
        let fx = fixture();
        fs::write(fx.a.join("mine.md"), "mine\n").unwrap();
        raw(&fx.a, &["add", "-A"]);
        raw(&fx.a, &["commit", "-m", "mine"]);
        remote_edit(&fx, "theirs.md", "from b\n");
        let before_remote = remote_head(&fx);

        let outcome = push_impl(&Git::new(&fx.a));

        assert_eq!(outcome.kind, GitKind::PushRejected, "{}", outcome.message);
        assert_eq!(remote_head(&fx), before_remote);
        assert!(!raw(&fx.remote, &["log", "--format=%s", "main"]).contains("mine"));
    }

    #[test]
    fn remote_rejected_push_keeps_the_commit() {
        let fx = fixture();
        use std::os::unix::fs::PermissionsExt;
        let refuse = fx.remote.join("hooks/pre-receive");
        fs::create_dir_all(refuse.parent().unwrap()).unwrap();
        fs::write(&refuse, "#!/bin/sh\necho protected >&2\nexit 1\n").unwrap();
        fs::set_permissions(&refuse, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(fx.a.join("mine.md"), "mine\n").unwrap();

        let outcome = sync_impl(&Git::new(&fx.a), "mine", &[]);

        assert_eq!(outcome.kind, GitKind::PushRejected, "{}", outcome.message);
        assert!(
            outcome.message.starts_with("Committed 1 file."),
            "{}",
            outcome.message
        );
        assert_eq!(outcome.status.ahead, 1);
    }

    #[test]
    fn no_upstream_commits_then_publish_links_the_branch() {
        let fx = fixture();
        raw(&fx.a, &["checkout", "-b", "topic"]);
        fs::write(fx.a.join("mine.md"), "mine\n").unwrap();

        let outcome = sync_impl(&Git::new(&fx.a), "mine", &[]);
        assert_eq!(outcome.kind, GitKind::NoUpstream, "{}", outcome.message);
        assert!(outcome.message.starts_with("Committed 1 file."));
        assert!(outcome.status.has_remote);
        assert!(outcome.status.upstream.is_none());

        let published = publish_impl(&Git::new(&fx.a));
        assert!(published.ok, "{}", published.message);
        assert_eq!(raw(&fx.remote, &["rev-parse", "topic"]), head(&fx.a));
        assert_eq!(published.status.upstream.as_deref(), Some("origin/topic"));
        assert!(sync_impl(&Git::new(&fx.a), "m", &[]).ok);
    }

    #[test]
    fn publish_does_not_overwrite_a_different_remote_branch() {
        let fx = fixture();
        raw(&fx.a, &["checkout", "-b", "topic"]);
        raw(&fx.a, &["commit", "--allow-empty", "-m", "a topic"]);
        raw(&fx.b, &["checkout", "-b", "topic"]);
        raw(&fx.b, &["commit", "--allow-empty", "-m", "b topic"]);
        raw(&fx.b, &["push", "origin", "topic"]);
        let before = raw(&fx.remote, &["rev-parse", "topic"]);

        let outcome = publish_impl(&Git::new(&fx.a));

        assert_eq!(outcome.kind, GitKind::PushRejected, "{}", outcome.message);
        assert_eq!(raw(&fx.remote, &["rev-parse", "topic"]), before);
    }

    #[test]
    fn no_remote_commits_locally_and_says_why_nothing_pushed() {
        let dir = TempDir::new().unwrap();
        raw(dir.path(), &["init", "-b", "main"]);
        configure(dir.path());
        fs::write(dir.path().join("a.md"), "a\n").unwrap();

        let outcome = sync_impl(&Git::new(dir.path()), "first", &[]);

        assert_eq!(outcome.kind, GitKind::NoRemote, "{}", outcome.message);
        assert!(outcome.message.starts_with("Committed 1 file."));
        assert!(!outcome.status.has_remote);
        assert_eq!(pull_impl(&Git::new(dir.path())).kind, GitKind::NoRemote);
        assert_eq!(push_impl(&Git::new(dir.path())).kind, GitKind::NoRemote);
    }

    #[test]
    fn no_repo_offers_nothing_until_init_is_requested() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.md"), "a\n").unwrap();
        let git = Git::new(dir.path());

        assert_eq!(status_of(&git).kind, Some(GitKind::NoRepo));
        assert_eq!(sync_impl(&git, "m", &[]).kind, GitKind::NoRepo);
        assert!(
            !dir.path().join(".git").exists(),
            "nothing but init may create a repo"
        );

        let created = init_impl(&git);
        assert!(created.ok, "{}", created.message);
        assert!(dir.path().join(".git").exists());
        assert_eq!(created.status.kind, Some(GitKind::Ok));
        assert!(!init_impl(&git).ok, "a second init is refused");
    }

    #[test]
    fn detached_head_refuses_and_commits_nothing() {
        let fx = fixture();
        let oid = head(&fx.a);
        raw(&fx.a, &["checkout", "--detach"]);
        fs::write(fx.a.join("mine.md"), "mine\n").unwrap();
        let git = Git::new(&fx.a);

        assert_eq!(sync_impl(&git, "m", &[]).kind, GitKind::Detached);
        assert_eq!(pull_impl(&git).kind, GitKind::Detached);
        assert_eq!(push_impl(&git).kind, GitKind::Detached);
        let commit = commit_impl(&git, &["mine.md".into()], "m", &[], &[]);
        assert_eq!(commit.kind, GitKind::Detached);
        assert!(commit.status.branch.is_none());
        assert_eq!(head(&fx.a), oid);
    }

    #[test]
    fn a_rebase_in_progress_is_left_alone() {
        let fx = fixture();
        remote_edit(&fx, "note.md", "one\nTHEIRS\nthree\n");
        fs::write(fx.a.join("note.md"), "one\nMINE\nthree\n").unwrap();
        raw(&fx.a, &["add", "-A"]);
        raw(&fx.a, &["commit", "-m", "mine"]);
        raw(&fx.a, &["fetch"]);
        let rebase = Command::new("git")
            .args(["rebase", "@{u}"])
            .current_dir(&fx.a)
            .output()
            .unwrap();
        assert!(!rebase.status.success());
        let git = Git::new(&fx.a);

        let outcome = sync_impl(&git, "m", &[]);
        assert_eq!(outcome.kind, GitKind::InProgress, "{}", outcome.message);
        assert!(outcome.message.contains("rebase"));
        assert_eq!(pull_impl(&git).kind, GitKind::InProgress);
        assert_eq!(push_impl(&git).kind, GitKind::InProgress);
        assert_eq!(
            commit_impl(&git, &["note.md".into()], "m", &[], &[]).kind,
            GitKind::InProgress
        );
        assert_eq!(
            abort_impl(&git).kind,
            GitKind::InProgress,
            "abort only covers merges"
        );
        assert_eq!(status_of(&git).in_progress.as_deref(), Some("rebase"));
        assert!(fx.a.join(".git/rebase-merge").exists() || fx.a.join(".git/rebase-apply").exists());
    }

    #[test]
    fn a_held_index_lock_stops_and_is_not_removed() {
        let fx = fixture();
        fs::write(fx.a.join(".git/index.lock"), "").unwrap();
        fs::write(fx.a.join("mine.md"), "mine\n").unwrap();
        let git = Git::new(&fx.a);

        let outcome = sync_impl(&git, "m", &[]);

        assert_eq!(outcome.kind, GitKind::IndexLocked, "{}", outcome.message);
        assert!(fx.a.join(".git/index.lock").exists());
        assert_eq!(
            status_of(&git).kind,
            Some(GitKind::Ok),
            "status still reads"
        );
    }

    #[test]
    fn an_unreachable_remote_keeps_the_commit_and_says_so() {
        let fx = fixture();
        raw(
            &fx.a,
            &[
                "remote",
                "set-url",
                "origin",
                "https://user:s3cr3t-token@127.0.0.1:9/nope.git",
            ],
        );
        fs::write(fx.a.join("mine.md"), "mine\n").unwrap();

        let outcome = sync_impl(&Git::new(&fx.a), "mine", &[]);

        assert_eq!(outcome.kind, GitKind::Network, "{}", outcome.message);
        assert!(
            outcome.message.starts_with("Committed 1 file."),
            "{}",
            outcome.message
        );
        assert!(
            !outcome.message.contains("s3cr3t-token"),
            "{}",
            outcome.message
        );
        assert!(!format!("{:?}", outcome.status).contains("s3cr3t-token"));
        assert!(outcome.status.files.is_empty());
    }

    #[test]
    fn a_failing_pre_commit_hook_is_named_and_leaves_changes_staged() {
        let fx = fixture();
        hook(&fx.a, "pre-commit", "echo hook says no >&2\nexit 1");
        fs::write(fx.a.join("mine.md"), "mine\n").unwrap();
        let before = head(&fx.a);

        let outcome = sync_impl(&Git::new(&fx.a), "mine", &[]);

        assert_eq!(outcome.kind, GitKind::Hook, "{}", outcome.message);
        assert!(outcome.message.contains("hook says no"));
        assert_eq!(head(&fx.a), before);
        assert_eq!(fs::read_to_string(fx.a.join("mine.md")).unwrap(), "mine\n");
    }

    #[test]
    fn a_failing_pre_push_hook_is_named_and_keeps_the_commit() {
        let fx = fixture();
        hook(&fx.a, "pre-push", "echo not today >&2\nexit 1");
        fs::write(fx.a.join("mine.md"), "mine\n").unwrap();
        let outcome = sync_impl(&Git::new(&fx.a), "mine", &[]);
        assert_eq!(outcome.kind, GitKind::Hook, "{}", outcome.message);
        assert!(outcome.message.contains("not today"));
        assert_eq!(outcome.status.ahead, 1);
    }

    #[test]
    fn timeout_stops_the_hook_and_leaves_no_lock() {
        let fx = fixture();
        let marker = fx.a.join("hook-survived");
        hook(
            &fx.a,
            "pre-commit",
            &format!("sleep 4\ntouch {}", marker.display()),
        );
        fs::write(fx.a.join("mine.md"), "mine\n").unwrap();
        let mut git = Git::new(&fx.a);
        git.local_timeout = Duration::from_millis(300);
        let before = head(&fx.a);

        let outcome = commit_impl(&git, &["mine.md".into()], "mine", &[], &[]);

        assert_eq!(outcome.kind, GitKind::Timeout, "{}", outcome.message);
        assert_eq!(head(&fx.a), before);
        assert!(!fx.a.join(".git/index.lock").exists());
        std::thread::sleep(Duration::from_secs(5));
        assert!(!marker.exists(), "the hook's process group must be stopped");
        assert!(sync_impl(&Git::new(&fx.a), "retry", &[]).kind != GitKind::IndexLocked);
    }

    #[test]
    fn missing_git_is_reported() {
        let dir = TempDir::new().unwrap();
        let mut git = Git::new(dir.path());
        git.program = "/nonexistent/git".into();
        assert_eq!(status_of(&git).kind, Some(GitKind::NotInstalled));
        let outcome = sync_impl(&git, "m", &[]);
        assert_eq!(outcome.kind, GitKind::NotInstalled);
        assert!(outcome.message.contains("isn't installed"));
    }

    #[test]
    fn one_operation_at_a_time_per_repo() {
        let fx = fixture();
        let git = Git::new(&fx.a);
        let lock = repo_lock(&fs::canonicalize(&fx.a).unwrap());
        let _held = lock.lock();
        assert_eq!(sync_impl(&git, "m", &[]).kind, GitKind::Busy);
        assert_eq!(status_of(&git).kind, Some(GitKind::Ok));
    }

    #[test]
    fn credentials_are_held_back_by_name_until_confirmed() {
        let fx = fixture();
        fs::write(fx.a.join(".env"), "API_KEY=super-secret-value\n").unwrap();
        fs::write(fx.a.join("deploy.pem"), "x").unwrap();
        fs::write(fx.a.join("note2.md"), "fine\n").unwrap();
        let before = head(&fx.a);

        let outcome = sync_impl(&Git::new(&fx.a), "m", &[]);

        assert_eq!(outcome.kind, GitKind::Secrets, "{}", outcome.message);
        assert_eq!(outcome.suspects, vec![".env", "deploy.pem"]);
        assert!(!outcome.message.contains("super-secret-value"));
        assert_eq!(head(&fx.a), before);
        assert_eq!(
            raw(&fx.a, &["diff", "--cached", "--name-only"]),
            "",
            "nothing staged"
        );

        // Confirmation covers exactly the named files, so a new one warns again.
        fs::write(fx.a.join("id_rsa"), "x").unwrap();
        let again = sync_impl(&Git::new(&fx.a), "m", &outcome.suspects);
        assert_eq!(again.suspects, vec!["id_rsa"]);

        let allowed = vec![".env".into(), "deploy.pem".into(), "id_rsa".into()];
        assert!(sync_impl(&Git::new(&fx.a), "m", &allowed).ok);
        assert!(raw(&fx.a, &["ls-files"]).contains(".env"));
    }

    #[test]
    fn credential_detection_covers_content_but_spares_prose_names() {
        let fx = fixture();
        fs::write(fx.a.join("Password hashing.md"), "bcrypt notes\n").unwrap();
        fs::write(fx.a.join(".env.example"), "KEY=\n").unwrap();
        fs::write(fx.a.join("server token.json"), "{}").unwrap();
        fs::write(fx.a.join("scratch.md"), "-----BEGIN RSA PRIVATE KEY-----\n").unwrap();

        let outcome = sync_impl(&Git::new(&fx.a), "m", &[]);

        assert_eq!(outcome.suspects, vec!["scratch.md", "server token.json"]);
    }

    #[test]
    fn commit_takes_only_the_chosen_files_with_awkward_names() {
        let fx = fixture();
        fs::write(fx.a.join("chosen file.md"), "1\n").unwrap();
        fs::write(fx.a.join(":(top)odd.md"), "2\n").unwrap();
        fs::write(fx.a.join("left.md"), "3\n").unwrap();
        fs::write(fx.a.join("note.md"), "already staged\n").unwrap();
        raw(&fx.a, &["add", "note.md"]);
        let chosen = vec!["chosen file.md".to_string(), ":(top)odd.md".to_string()];

        let outcome = commit_impl(&Git::new(&fx.a), &chosen, "two files", &[], &[]);

        assert!(outcome.ok, "{}", outcome.message);
        let committed = raw(&fx.a, &["show", "--name-only", "--format=", "-z", "HEAD"]);
        assert!(committed.contains("chosen file.md") && committed.contains(":(top)odd.md"));
        assert!(!committed.contains("left.md") && !committed.contains("note.md"));
        let paths: Vec<_> = outcome
            .status
            .files
            .iter()
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(paths, vec!["note.md", "left.md"]);
    }

    #[test]
    fn deletions_and_empty_messages() {
        let fx = fixture();
        fs::remove_file(fx.a.join("note.md")).unwrap();
        let chosen = vec!["note.md".to_string()];
        assert!(!commit_impl(&Git::new(&fx.a), &chosen, "  ", &[], &[]).ok);
        let status = status_of(&Git::new(&fx.a));
        assert_eq!(status.files[0].status, "D");
        let outcome = commit_impl(&Git::new(&fx.a), &chosen, "remove", &[], &[]);
        assert!(outcome.ok, "{}", outcome.message);
        assert!(raw(&fx.a, &["ls-files"]).is_empty());
    }

    #[test]
    fn a_workspace_folder_syncs_only_its_own_files() {
        let fx = fixture();
        let notes = fx.a.join("notes");
        fs::create_dir(&notes).unwrap();
        fs::write(notes.join("in.md"), "in\n").unwrap();
        fs::write(fx.a.join("outside.md"), "out\n").unwrap();
        fs::create_dir(fx.a.join("notes-other")).unwrap();
        fs::write(fx.a.join("notes-other/sibling.md"), "out\n").unwrap();
        let git = Git::new(&notes);

        let status = status_of(&git);
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "notes/in.md");
        assert_eq!(status.outside_changes, 2);

        let outcome = sync_impl(&git, "notes only", &[]);
        assert!(outcome.ok, "{}", outcome.message);
        let tracked = raw(&fx.a, &["ls-files"]);
        assert!(tracked.contains("notes/in.md"));
        assert!(!tracked.contains("outside.md") && !tracked.contains("sibling.md"));
    }

    #[test]
    fn status_reports_ahead_behind_and_unborn_branches() {
        let fx = fixture();
        remote_edit(&fx, "theirs.md", "x\n");
        raw(&fx.a, &["fetch"]);
        raw(&fx.a, &["commit", "--allow-empty", "-m", "local"]);
        let status = status_of(&Git::new(&fx.a));
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind), (1, 1));

        let dir = TempDir::new().unwrap();
        raw(dir.path(), &["init", "-b", "fresh"]);
        let status = status_of(&Git::new(dir.path()));
        assert_eq!(status.branch.as_deref(), Some("fresh"));
        assert_eq!(status.kind, Some(GitKind::Ok));
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
