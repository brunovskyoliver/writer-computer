//! Compile a LaTeX document to PDF with Tectonic.
//!
//! The preview beside a `.tex` tab is the real PDF, written next to the root
//! `.tex` so it is ready to hand in. Tectonic is found on the machine, never
//! bundled; a missing engine is a named status the frontend turns into an
//! install hint. Rules: `SPECs/latex-documents/spec.md` (FR-2, US5).

use crate::error::AppError;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// First compiles fetch packages; a stuck engine must still end.
const COMPILE_TIMEOUT: Duration = Duration::from_secs(180);
/// How far into a file a `% !TEX root = …` comment is honoured.
const MAGIC_COMMENT_LINES: usize = 20;

/// Where a GUI-launched app finds Tectonic when `PATH` is the bare launchd one.
const ENGINE_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

#[cfg(test)]
use super::latex_output::parse_diagnostics;
use super::latex_output::{combine_streams, read_output, CompilerOutput};
pub use super::latex_output::{Diagnostic, Severity};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CompileStatus {
    Ok,
    Failed,
    EngineMissing,
    NoRoot,
}

#[derive(Debug, Clone, Serialize)]
pub struct CompileResult {
    pub status: CompileStatus,
    pub root: Option<String>,
    pub pdf_path: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
    pub duration_ms: u64,
    pub log: String,
}

impl CompileResult {
    fn without_run(status: CompileStatus, root: Option<&Path>, message: String) -> Self {
        CompileResult {
            status,
            root: root.map(|p| p.to_string_lossy().into_owned()),
            pdf_path: None,
            diagnostics: vec![Diagnostic {
                file: None,
                line: None,
                message,
                severity: Severity::Error,
            }],
            duration_ms: 0,
            log: String::new(),
        }
    }
}

pub(crate) fn is_latex_source(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    (lower.ends_with(".tex") && name.len() > ".tex".len())
        || (lower.ends_with(".bib") && name.len() > ".bib".len())
}

fn head(path: &Path, bytes: usize) -> String {
    let Ok(file) = std::fs::File::open(path) else {
        return String::new();
    };
    let mut buffer = Vec::with_capacity(bytes);
    let _ = file.take(bytes as u64).read_to_end(&mut buffer);
    String::from_utf8_lossy(&buffer).into_owned()
}

fn has_documentclass(path: &Path) -> bool {
    // The preamble is at the top; 64 KB covers any real one.
    head(path, 64 * 1024)
        .lines()
        .any(|line| line.trim_start().starts_with("\\documentclass"))
}

/// `% !TEX root = main.tex` (any case, `TeX` too) in the first lines.
fn magic_root(path: &Path) -> Option<PathBuf> {
    let text = head(path, 8 * 1024);
    for line in text.lines().take(MAGIC_COMMENT_LINES) {
        let trimmed = line.trim_start();
        let Some(rest) = trimmed.strip_prefix('%') else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest
            .get(..4)
            .filter(|p| p.eq_ignore_ascii_case("!tex"))
            .map(|_| &rest[4..])
        else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest
            .get(..4)
            .filter(|p| p.eq_ignore_ascii_case("root"))
            .map(|_| &rest[4..])
        else {
            continue;
        };
        let target = rest.trim_start().strip_prefix('=')?.trim();
        if target.is_empty() {
            return None;
        }
        let dir = path.parent()?;
        let mut root = dir.join(target);
        if root.extension().is_none() {
            root.set_extension("tex");
        }
        return Some(root);
    }
    None
}

/// The document a file compiles as part of (US5): a magic comment wins; a
/// `.tex` with `\documentclass` is its own root; otherwise the single sibling
/// `.tex` that has one. `None` when the choice is missing or ambiguous.
pub(crate) fn resolve_root(path: &Path) -> Option<PathBuf> {
    if let Some(root) = magic_root(path) {
        return root.is_file().then_some(root);
    }
    let is_tex = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("tex"));
    if is_tex && has_documentclass(path) {
        return Some(path.to_path_buf());
    }
    let dir = path.parent()?;
    let mut candidates = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|candidate| {
            candidate.as_path() != path
                && candidate
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("tex"))
                && has_documentclass(candidate)
        });
    let first = candidates.next()?;
    candidates.next().is_none().then_some(first)
}

/// Tectonic on `PATH`, then the Homebrew prefixes and `~/.cargo/bin`.
pub(crate) fn find_engine(path_var: Option<&str>, home: Option<&Path>) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = path_var
        .map(|value| std::env::split_paths(value).collect())
        .unwrap_or_default();
    dirs.extend(ENGINE_DIRS.iter().map(PathBuf::from));
    if let Some(home) = home {
        dirs.push(home.join(".cargo/bin"));
    }
    dirs.into_iter()
        .map(|dir| dir.join("tectonic"))
        .find(|candidate| candidate.is_file())
}

/// Run Tectonic on `root` and wait, killing it past the timeout. Both streams
/// are drained on their own threads so a chatty engine never blocks on a full
/// pipe.
struct EngineRun {
    success: bool,
    output: CompilerOutput,
    timeout_seconds: Option<u64>,
}

fn stop_child(child: &mut std::process::Child) -> Result<(), String> {
    let killed = child.kill();
    let waited = child.wait();
    let mut errors = Vec::new();
    if let Err(error) = killed {
        if error.kind() != std::io::ErrorKind::InvalidInput {
            errors.push(format!("kill: {error}"));
        }
    }
    if let Err(error) = waited {
        errors.push(format!("reap: {error}"));
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn run_engine(engine: &Path, root: &Path, timeout: Duration) -> Result<EngineRun, AppError> {
    let dir = root.parent().unwrap_or(Path::new("."));
    let mut child = Command::new(engine)
        .arg(root.file_name().unwrap_or(root.as_os_str()))
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Io(format!("could not start Tectonic: {e}")))?;

    let drain = |name: &str, stream: Option<Box<dyn Read + Send>>| {
        let root = root.to_owned();
        std::thread::Builder::new()
            .name(format!("tectonic-{name}"))
            .spawn(move || {
                let stream =
                    stream.ok_or_else(|| std::io::Error::other("compiler pipe missing"))?;
                read_output(stream, &root)
            })
    };
    let stdout = match drain(
        "stdout",
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    ) {
        Ok(reader) => reader,
        Err(error) => {
            let cleanup = stop_child(&mut child);
            return Err(AppError::Io(format!(
                "could not start stdout reader: {error}; cleanup: {cleanup:?}"
            )));
        }
    };
    let stderr = match drain(
        "stderr",
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    ) {
        Ok(reader) => reader,
        Err(error) => {
            let cleanup = stop_child(&mut child);
            let reader = stdout.join();
            return Err(AppError::Io(format!("could not start stderr reader: {error}; cleanup: {cleanup:?}; stdout completed: {}", matches!(reader, Ok(Ok(_))))));
        }
    };

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(Some(status)),
            Ok(None) => {}
            Err(error) => {
                let cleanup = stop_child(&mut child);
                break Err(format!(
                    "could not wait for Tectonic: {error}; cleanup: {cleanup:?}"
                ));
            }
        }
        if started.elapsed() > timeout {
            break stop_child(&mut child).map(|()| None);
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    finish_readers(stdout, stderr, status, timeout)
}

fn finish_readers(
    stdout: std::thread::JoinHandle<std::io::Result<super::latex_output::StreamOutput>>,
    stderr: std::thread::JoinHandle<std::io::Result<super::latex_output::StreamOutput>>,
    status: Result<Option<std::process::ExitStatus>, String>,
    timeout: Duration,
) -> Result<EngineRun, AppError> {
    // Always join both readers before any wait/read/panic error is returned.
    let stdout = stdout.join();
    let stderr = stderr.join();
    let decode = |result: std::thread::Result<
        std::io::Result<super::latex_output::StreamOutput>,
    >,
                  name: &str| {
        result
            .map_err(|_| format!("Tectonic {name} reader panicked"))
            .and_then(|result| result.map_err(|e| format!("could not read Tectonic {name}: {e}")))
    };
    match (decode(stdout, "stdout"), decode(stderr, "stderr"), status) {
        (Ok(stdout), Ok(stderr), Ok(status)) => Ok(EngineRun {
            success: status.is_some_and(|s| s.success()),
            output: combine_streams(stdout, stderr),
            timeout_seconds: status.is_none().then_some(timeout.as_secs()),
        }),
        (stdout, stderr, status) => Err(AppError::Io(
            [stdout.err(), stderr.err(), status.err()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("; "),
        )),
    }
}

pub(crate) fn compile_latex_impl(
    path: &Path,
    path_var: Option<&str>,
    home: Option<&Path>,
) -> Result<CompileResult, AppError> {
    let Some(root) = resolve_root(path) else {
        return Ok(CompileResult::without_run(
            CompileStatus::NoRoot,
            None,
            "No main document found. Add `% !TEX root = main.tex` at the top of this file."
                .to_string(),
        ));
    };
    let Some(engine) = find_engine(path_var, home) else {
        return Ok(CompileResult::without_run(
            CompileStatus::EngineMissing,
            Some(&root),
            "Tectonic is not installed. Install it with `brew install tectonic`.".to_string(),
        ));
    };

    let started = Instant::now();
    let run = run_engine(&engine, &root, COMPILE_TIMEOUT)?;
    let pdf = root.with_extension("pdf");
    let ok = run.success && pdf.is_file();
    let (log, diagnostics) = run.output.finish(!ok, run.timeout_seconds);

    Ok(CompileResult {
        status: if ok {
            CompileStatus::Ok
        } else {
            CompileStatus::Failed
        },
        root: Some(root.to_string_lossy().into_owned()),
        pdf_path: ok.then(|| pdf.to_string_lossy().into_owned()),
        diagnostics,
        duration_ms: started.elapsed().as_millis() as u64,
        log,
    })
}

/// Compile the document `path` belongs to. Never errors for a failed compile —
/// that is a `failed` status with diagnostics. `Err` reports engine startup,
/// output-reader or process-management failures.
#[tauri::command]
pub async fn compile_latex(path: String) -> Result<CompileResult, AppError> {
    let path_var = std::env::var("PATH").ok();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    tauri::async_runtime::spawn_blocking(move || {
        compile_latex_impl(Path::new(&path), path_var.as_deref(), home.as_deref())
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))?
}

/// The root a file compiles as part of, for the frontend's preview toggle.
#[tauri::command]
pub async fn latex_root(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_root(Path::new(&path)).map(|root| root.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, text).unwrap();
        path
    }

    #[test]
    fn latex_sources_are_tex_and_bib() {
        assert!(is_latex_source(Path::new("/a/report.tex")));
        assert!(is_latex_source(Path::new("/a/refs.BIB")));
        assert!(!is_latex_source(Path::new("/a/.tex")));
        assert!(!is_latex_source(Path::new("/a/note.md")));
    }

    #[test]
    fn a_document_is_its_own_root() {
        let dir = tempfile::tempdir().unwrap();
        let main = write(dir.path(), "main.tex", "\\documentclass{article}\n");
        assert_eq!(resolve_root(&main), Some(main));
    }

    #[test]
    fn a_chapter_uses_the_single_sibling_document() {
        let dir = tempfile::tempdir().unwrap();
        let main = write(dir.path(), "main.tex", "\\documentclass{article}\n");
        let chapter = write(dir.path(), "chap.tex", "Some text.\n");
        let bib = write(dir.path(), "refs.bib", "@book{x,}\n");
        assert_eq!(resolve_root(&chapter), Some(main.clone()));
        assert_eq!(resolve_root(&bib), Some(main));
    }

    #[test]
    fn two_documents_make_the_sibling_rule_ambiguous() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.tex", "\\documentclass{article}\n");
        write(dir.path(), "b.tex", "\\documentclass{article}\n");
        let chapter = write(dir.path(), "chap.tex", "text\n");
        assert_eq!(resolve_root(&chapter), None);
    }

    #[test]
    fn the_magic_comment_wins() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("chapters")).unwrap();
        let main = write(dir.path(), "thesis.tex", "\\documentclass{report}\n");
        write(dir.path(), "other.tex", "\\documentclass{article}\n");
        let chapter = write(
            &dir.path().join("chapters"),
            "intro.tex",
            "% !TeX root = ../thesis\nIntro.\n",
        );
        let resolved = resolve_root(&chapter).unwrap();
        assert_eq!(
            resolved.canonicalize().unwrap(),
            main.canonicalize().unwrap()
        );
    }

    #[test]
    fn the_engine_is_found_beyond_path() {
        let dir = tempfile::tempdir().unwrap();
        let cargo_bin = dir.path().join(".cargo/bin");
        std::fs::create_dir_all(&cargo_bin).unwrap();
        std::fs::write(cargo_bin.join("tectonic"), "").unwrap();
        let found = find_engine(Some("/nonexistent"), Some(dir.path())).unwrap();
        // A system-wide Homebrew install is probed first and may win here.
        let homebrew = ENGINE_DIRS
            .iter()
            .any(|d| Path::new(d).join("tectonic").is_file());
        if !homebrew {
            assert_eq!(found, cargo_bin.join("tectonic"));
        }
    }

    #[test]
    fn located_errors_replace_engine_boilerplate() {
        let dir = tempfile::tempdir().unwrap();
        let root = write(dir.path(), "main.tex", "");
        write(dir.path(), "chap.tex", "");
        let output = "error: chap:2: Undefined control sequence\n\
             error: something bad happened inside XeTeX; its output follows:\n\
             LaTeX Warning: Reference `nope' on page 1 undefined on input line 3.\n\
             error: the XeTeX engine had an unrecoverable error\n";
        let diagnostics = parse_diagnostics(output, &root);
        assert_eq!(diagnostics.len(), 2);
        assert_eq!(diagnostics[0].line, Some(2));
        assert_eq!(
            diagnostics[0].file.as_deref(),
            Some(dir.path().join("chap.tex").to_string_lossy().as_ref())
        );
        assert_eq!(diagnostics[0].message, "Undefined control sequence");
        assert_eq!(diagnostics[1].severity, Severity::Warning);
        assert_eq!(diagnostics[1].line, Some(3));
        assert_eq!(
            diagnostics[1].message,
            "Reference `nope' on page 1 undefined"
        );
    }

    #[test]
    fn a_dot_slash_file_resolves_to_the_plain_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = write(dir.path(), "main.tex", "");
        let diagnostics =
            parse_diagnostics("error: ./main.tex:7: Undefined control sequence\n", &root);
        assert_eq!(
            diagnostics[0].file.as_deref(),
            Some(root.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn an_unlocated_error_is_kept() {
        let root = PathBuf::from("/w/main.tex");
        let diagnostics = parse_diagnostics("error: couldn't find `foo.sty`\n", &root);
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].line, None);
    }

    #[test]
    fn no_root_and_missing_engine_are_statuses() {
        let dir = tempfile::tempdir().unwrap();
        let chapter = write(dir.path(), "chap.tex", "text\n");
        let result = compile_latex_impl(&chapter, Some(""), None).unwrap();
        assert_eq!(result.status, CompileStatus::NoRoot);

        let main = write(dir.path(), "main.tex", "\\documentclass{article}\n");
        let result = compile_latex_impl(&main, Some("/nonexistent"), Some(dir.path())).unwrap();
        // The Homebrew prefixes are probed too, so this only holds on a machine
        // without a system-wide Tectonic.
        if find_engine(Some("/nonexistent"), Some(dir.path())).is_none() {
            assert_eq!(result.status, CompileStatus::EngineMissing);
        }
    }

    #[test]
    fn a_reader_panic_still_joins_the_other_reader_before_returning() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let completed = Arc::new(AtomicBool::new(false));
        let signal = completed.clone();
        let stdout = std::thread::spawn(|| panic!("reader panic"));
        let stderr = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            signal.store(true, Ordering::SeqCst);
            read_output(&b""[..], Path::new("/w/main.tex"))
        });
        let result = finish_readers(stdout, stderr, Ok(None), Duration::from_secs(1));
        assert!(completed.load(Ordering::SeqCst));
        assert!(
            matches!(result, Err(AppError::Io(message)) if message.contains("stdout reader panicked"))
        );
    }

    #[cfg(unix)]
    fn fake_engine(dir: &Path, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let engine = write(dir, "engine", &format!("#!/bin/sh\n{script}"));
        std::fs::set_permissions(&engine, std::fs::Permissions::from_mode(0o755)).unwrap();
        engine
    }

    #[cfg(unix)]
    #[test]
    fn noisy_process_drains_both_pipes_and_retains_early_errors() {
        let dir = tempfile::tempdir().unwrap();
        let root = write(dir.path(), "main.tex", "");
        let engine = fake_engine(
            dir.path(),
            r#"printf 'error: main:7: early error\n' >&2
n=0
while [ "$n" -lt 4096 ]; do
    printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
    printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' >&2
    n=$((n+1))
done
exit 1
"#,
        );
        let run = run_engine(&engine, &root, Duration::from_secs(10)).unwrap();
        assert!(!run.success);
        assert!(
            run.timeout_seconds.is_none(),
            "noisy engine must reach its own exit"
        );
        let (log, diagnostics) = run.output.finish(true, run.timeout_seconds);
        assert!(log.len() <= 128 * 1024);
        assert!(log.lines().count() <= 200);
        assert!(diagnostics
            .iter()
            .any(|d| d.line == Some(7) && d.message == "early error"));
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_reaps_and_joins_the_process_readers() {
        let dir = tempfile::tempdir().unwrap();
        let root = write(dir.path(), "main.tex", "");
        let engine = fake_engine(dir.path(), "exec /bin/sleep 3\n");
        let started = Instant::now();
        let run = run_engine(&engine, &root, Duration::from_millis(20)).unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!run.success);
        let (log, diagnostics) = run.output.finish(true, run.timeout_seconds);
        assert!(log.contains("stopped after"));
        assert!(diagnostics[0].message.contains("stopped after"));
    }

    /// End-to-end against the installed engine; skipped where there is none.
    #[test]
    fn compiles_a_document_when_tectonic_is_installed() {
        let path_var = std::env::var("PATH").ok();
        let home = std::env::var_os("HOME").map(PathBuf::from);
        if find_engine(path_var.as_deref(), home.as_deref()).is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let main = write(
            dir.path(),
            "main.tex",
            "\\documentclass{article}\n\\begin{document}\nHi $x^2$\n\\end{document}\n",
        );
        let result = compile_latex_impl(&main, path_var.as_deref(), home.as_deref()).unwrap();
        assert_eq!(result.status, CompileStatus::Ok, "{}", result.log);
        assert!(dir.path().join("main.pdf").is_file());

        std::fs::write(
            &main,
            "\\documentclass{article}\n\\begin{document}\n\\nosuchmacro\n\\end{document}\n",
        )
        .unwrap();
        let failed = compile_latex_impl(&main, path_var.as_deref(), home.as_deref()).unwrap();
        assert_eq!(failed.status, CompileStatus::Failed);
        assert_eq!(failed.diagnostics[0].line, Some(3));
    }
}
