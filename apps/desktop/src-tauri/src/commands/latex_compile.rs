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
/// Only the tail of the log is useful and it can run to megabytes.
const LOG_TAIL_LINES: usize = 200;
/// How far into a file a `% !TEX root = …` comment is honoured.
const MAGIC_COMMENT_LINES: usize = 20;

/// Where a GUI-launched app finds Tectonic when `PATH` is the bare launchd one.
const ENGINE_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Diagnostic {
    /// Absolute path of the file the message is about, when the log names one.
    pub file: Option<String>,
    /// 1-based line, when the log gives one.
    pub line: Option<u32>,
    pub message: String,
    pub severity: Severity,
}

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

/// Resolve a log's file reference (`chap`, `./chap.tex`) against the root's
/// folder, trying `.tex` when the log dropped the extension.
fn resolve_log_file(dir: &Path, name: &str) -> String {
    // `./main.tex` must come out as the same string the editor has for the
    // file, or the frontend cannot match the diagnostic to its tab.
    let direct: PathBuf = dir
        .join(name)
        .components()
        .filter(|part| !matches!(part, std::path::Component::CurDir))
        .collect();
    if direct.is_file() || direct.extension().is_some() {
        return direct.to_string_lossy().into_owned();
    }
    direct.with_extension("tex").to_string_lossy().into_owned()
}

/// Tectonic's own summaries (`error: chap:2: Undefined control sequence`) and
/// LaTeX warnings that carry `on input line N`. Engine boilerplate that only
/// says "it failed" is dropped when a located error exists.
pub(crate) fn parse_diagnostics(output: &str, root: &Path) -> Vec<Diagnostic> {
    let dir = root.parent().unwrap_or(Path::new("."));
    let root_str = root.to_string_lossy().into_owned();
    let mut located = Vec::new();
    let mut general = Vec::new();

    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("error: ") {
            // `file:line: message` — the file part may itself not contain `:`.
            let mut parts = rest.splitn(3, ':');
            let (file, number, message) = (parts.next(), parts.next(), parts.next());
            if let (Some(file), Some(number), Some(message)) = (file, number, message) {
                if let Ok(number) = number.trim().parse::<u32>() {
                    located.push(Diagnostic {
                        file: Some(resolve_log_file(dir, file.trim())),
                        line: Some(number),
                        message: message.trim().to_string(),
                        severity: Severity::Error,
                    });
                    continue;
                }
            }
            general.push(Diagnostic {
                file: None,
                line: None,
                message: rest.trim().to_string(),
                severity: Severity::Error,
            });
            continue;
        }
        if let Some(at) = line.find("Warning: ") {
            let is_latex_warning = line.starts_with("LaTeX ") || line.starts_with("Package ");
            let marker = " on input line ";
            if let (true, Some(pos)) = (is_latex_warning, line.rfind(marker)) {
                let number: String = line[pos + marker.len()..]
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if let Ok(number) = number.parse::<u32>() {
                    located.push(Diagnostic {
                        file: Some(root_str.clone()),
                        line: Some(number),
                        message: line[at + "Warning: ".len()..pos].trim().to_string(),
                        severity: Severity::Warning,
                    });
                }
            }
        }
    }

    let has_located_error = located.iter().any(|d| d.severity == Severity::Error);
    if has_located_error {
        located
    } else {
        general.extend(located);
        general
    }
}

fn log_tail(output: &str) -> String {
    let lines: Vec<&str> = output.lines().collect();
    let from = lines.len().saturating_sub(LOG_TAIL_LINES);
    lines[from..].join("\n")
}

/// Run Tectonic on `root` and wait, killing it past the timeout. Both streams
/// are drained on their own threads so a chatty engine never blocks on a full
/// pipe.
fn run_engine(engine: &Path, root: &Path) -> Result<(bool, String), AppError> {
    let dir = root.parent().unwrap_or(Path::new("."));
    let mut child = Command::new(engine)
        .arg(root.file_name().unwrap_or(root.as_os_str()))
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Io(format!("could not start Tectonic: {e}")))?;

    let drain = |stream: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut stream) = stream {
                let mut bytes = Vec::new();
                let _ = stream.read_to_end(&mut bytes);
                text = String::from_utf8_lossy(&bytes).into_owned();
            }
            text
        })
    };
    let stdout = drain(
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    );
    let stderr = drain(
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    );

    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if started.elapsed() > COMPILE_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };

    let mut output = stdout.join().unwrap_or_default();
    output.push('\n');
    output.push_str(&stderr.join().unwrap_or_default());
    match status {
        Some(status) => Ok((status.success(), output)),
        None => {
            output.push_str(&format!(
                "\nerror: compilation stopped after {} s",
                COMPILE_TIMEOUT.as_secs()
            ));
            Ok((false, output))
        }
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
    let (success, output) = run_engine(&engine, &root)?;
    let pdf = root.with_extension("pdf");
    let ok = success && pdf.is_file();
    let mut diagnostics = parse_diagnostics(&output, &root);
    if !ok && !diagnostics.iter().any(|d| d.severity == Severity::Error) {
        diagnostics.insert(
            0,
            Diagnostic {
                file: None,
                line: None,
                message: "Tectonic failed without naming an error — see the log.".to_string(),
                severity: Severity::Error,
            },
        );
    }

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
        log: log_tail(&output),
    })
}

/// Compile the document `path` belongs to. Never errors for a failed compile —
/// that is a `failed` status with diagnostics; `Err` means the engine could
/// not even be started.
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
