//! Bounded compiler stream retention and diagnostic extraction.
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const STREAM_BYTES: usize = 64 * 1024;
const LINE_BYTES: usize = 8 * 1024;
const LOG_BYTES: usize = 128 * 1024;
const LOG_LINES: usize = 200;
const DIAGNOSTICS: usize = 200;
const TRUNCATED: &str = "Compiler output truncated (log, line or diagnostic limit).";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Diagnostic {
    /// Absolute path when the compiler names a file.
    pub file: Option<String>,
    /// One-based source line when available.
    pub line: Option<u32>,
    pub message: String,
    pub severity: Severity,
}

fn resolve_log_file(dir: &Path, name: &str) -> String {
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

fn parse_line(line: &str, root: &Path) -> Option<Diagnostic> {
    let line = line.trim_end_matches('\r');
    if let Some(rest) = line.strip_prefix("error: ") {
        let mut parts = rest.splitn(3, ':');
        if let (Some(file), Some(number), Some(message)) =
            (parts.next(), parts.next(), parts.next())
        {
            if let Ok(number) = number.trim().parse::<u32>() {
                return Some(Diagnostic {
                    file: Some(resolve_log_file(
                        root.parent().unwrap_or(Path::new(".")),
                        file.trim(),
                    )),
                    line: Some(number),
                    message: message.trim().into(),
                    severity: Severity::Error,
                });
            }
        }
        return Some(Diagnostic {
            file: None,
            line: None,
            message: rest.trim().into(),
            severity: Severity::Error,
        });
    }
    if !(line.starts_with("LaTeX ") || line.starts_with("Package ")) {
        return None;
    }
    let at = line.find("Warning: ")?;
    let marker = " on input line ";
    let pos = line.rfind(marker)?;
    if pos < at + "Warning: ".len() {
        return None;
    }
    let number: String = line[pos + marker.len()..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    Some(Diagnostic {
        file: Some(root.to_string_lossy().into_owned()),
        line: Some(number.parse().ok()?),
        message: line[at + "Warning: ".len()..pos].trim().into(),
        severity: Severity::Warning,
    })
}

#[derive(Default)]
struct DiagnosticSink {
    items: Vec<Diagnostic>,
    located_error: bool,
    truncated: bool,
}
impl DiagnosticSink {
    fn push(&mut self, diagnostic: Diagnostic) {
        if diagnostic.severity == Severity::Error
            && diagnostic.file.is_some()
            && !self.located_error
        {
            self.located_error = true;
            self.items.retain(|d| d.file.is_some());
        }
        if self.located_error && diagnostic.file.is_none() {
            return;
        }
        // Reserve one slot for a synthetic timeout/failure or truncation note.
        if self.items.len() == DIAGNOSTICS - 1 {
            self.truncated = true;
            if diagnostic.severity == Severity::Error {
                if let Some(warning) = self
                    .items
                    .iter()
                    .rposition(|d| d.severity == Severity::Warning)
                {
                    self.items.remove(warning);
                } else {
                    return;
                }
            } else {
                return;
            }
        }
        self.items.push(diagnostic);
    }
}

struct Collector {
    root: PathBuf,
    tail: VecDeque<u8>,
    line: Vec<u8>,
    diagnostics: DiagnosticSink,
    truncated: bool,
}
impl Collector {
    fn new(root: &Path) -> Self {
        Self {
            root: root.into(),
            tail: VecDeque::with_capacity(STREAM_BYTES),
            line: Vec::with_capacity(LINE_BYTES),
            diagnostics: DiagnosticSink::default(),
            truncated: false,
        }
    }
    fn feed(&mut self, bytes: &[u8]) {
        let dropped = (self.tail.len() + bytes.len()).saturating_sub(STREAM_BYTES);
        if dropped > 0 {
            self.tail.drain(..dropped);
            self.truncated = true;
        }
        self.tail.extend(bytes);
        for &byte in bytes {
            if byte == b'\n' {
                self.flush_line();
            } else if self.line.len() < LINE_BYTES {
                self.line.push(byte);
            } else {
                self.truncated = true;
            }
        }
    }
    fn flush_line(&mut self) {
        if let Some(diagnostic) = parse_line(&String::from_utf8_lossy(&self.line), &self.root) {
            self.diagnostics.push(diagnostic);
        }
        self.line.clear();
    }
    fn finish(mut self) -> StreamOutput {
        self.flush_line();
        StreamOutput {
            tail: self.tail,
            diagnostics: self.diagnostics,
            truncated: self.truncated,
        }
    }
}

pub(super) struct StreamOutput {
    tail: VecDeque<u8>,
    diagnostics: DiagnosticSink,
    truncated: bool,
}

pub(super) fn read_output(mut reader: impl Read, root: &Path) -> io::Result<StreamOutput> {
    let mut collector = Collector::new(root);
    let mut chunk = [0u8; LINE_BYTES];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => return Ok(collector.finish()),
            Ok(size) => collector.feed(&chunk[..size]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

pub(super) struct CompilerOutput {
    stdout: VecDeque<u8>,
    stderr: VecDeque<u8>,
    diagnostics: DiagnosticSink,
    truncated: bool,
}
pub(super) fn combine_streams(stdout: StreamOutput, stderr: StreamOutput) -> CompilerOutput {
    let mut diagnostics = DiagnosticSink::default();
    let mut truncated = stdout.truncated
        || stderr.truncated
        || stdout.diagnostics.truncated
        || stderr.diagnostics.truncated;
    for diagnostic in stdout
        .diagnostics
        .items
        .into_iter()
        .chain(stderr.diagnostics.items)
    {
        diagnostics.push(diagnostic);
    }
    truncated |= diagnostics.truncated;
    CompilerOutput {
        stdout: stdout.tail,
        stderr: stderr.tail,
        diagnostics,
        truncated,
    }
}
impl CompilerOutput {
    pub(super) fn finish(
        mut self,
        failed: bool,
        timeout: Option<u64>,
    ) -> (String, Vec<Diagnostic>) {
        let mut text = String::from_utf8_lossy(self.stdout.make_contiguous()).into_owned();
        text.push('\n');
        text.push_str(&String::from_utf8_lossy(self.stderr.make_contiguous()));
        if !self.diagnostics.located_error {
            self.diagnostics.items.sort_by_key(|d| d.file.is_some());
        }
        let synthetic = timeout
            .map(|seconds| format!("Compilation stopped after {seconds} s"))
            .or_else(|| {
                (failed
                    && !self
                        .diagnostics
                        .items
                        .iter()
                        .any(|d| d.severity == Severity::Error))
                .then(|| "Tectonic failed without naming an error. See the log.".into())
            });
        if let Some(message) = &synthetic {
            text.push_str(&format!("\nerror: {message}"));
        }
        let prefix_bytes = TRUNCATED.len() + 1;
        // Decode first: malformed bytes can triple in size under lossy UTF-8.
        let mut start = text.len().saturating_sub(LOG_BYTES - prefix_bytes);
        while !text.is_char_boundary(start) {
            start += 1;
        }
        if start > 0 {
            self.truncated = true;
        }
        let tail = &text[start..];
        let mut lines: Vec<&str> = tail.lines().rev().take(LOG_LINES).collect();
        if tail.lines().count() > LOG_LINES - 1 {
            self.truncated = true;
        }
        if self.truncated {
            lines.truncate(LOG_LINES - 1);
        }
        lines.reverse();
        let log = if self.truncated {
            format!("{TRUNCATED}\n{}", lines.join("\n"))
        } else {
            lines.join("\n")
        };
        if let Some(mut message) = synthetic {
            if self.truncated {
                message.push_str(&format!(" {TRUNCATED}"));
            }
            self.diagnostics.items.insert(
                0,
                Diagnostic {
                    file: None,
                    line: None,
                    message,
                    severity: Severity::Error,
                },
            );
        } else if self.truncated {
            self.diagnostics.items.push(Diagnostic {
                file: None,
                line: None,
                message: TRUNCATED.into(),
                severity: Severity::Warning,
            });
        }
        (log, self.diagnostics.items)
    }
}

#[cfg(test)]
pub(super) fn parse_diagnostics(output: &str, root: &Path) -> Vec<Diagnostic> {
    let mut sink = DiagnosticSink::default();
    for line in output.lines() {
        if let Some(diagnostic) = parse_line(line, root) {
            sink.push(diagnostic);
        }
    }
    if !sink.located_error {
        sink.items.sort_by_key(|d| d.file.is_some());
    }
    sink.items
}

#[cfg(test)]
mod tests {
    use super::*;
    const ROOT: &str = "/w/main.tex";
    fn stream(text: &[u8]) -> StreamOutput {
        read_output(text, Path::new(ROOT)).unwrap()
    }
    fn empty() -> StreamOutput {
        stream(b"")
    }

    #[test]
    fn retained_buffers_stay_bounded_while_draining_megabytes() {
        let mut collector = Collector::new(Path::new(ROOT));
        collector.feed(b"error: main:7: early error\n");
        let chunk = [b'x'; LINE_BYTES];
        for _ in 0..4096 {
            collector.feed(&chunk);
            assert!(collector.tail.len() <= STREAM_BYTES);
            assert!(collector.tail.capacity() <= STREAM_BYTES);
            assert!(collector.line.len() <= LINE_BYTES);
            assert!(collector.line.capacity() <= LINE_BYTES);
        }
        collector.feed(b"\nerror: main:9: late error\n");
        let (log, diagnostics) = combine_streams(collector.finish(), empty()).finish(true, None);
        assert!(log.len() <= LOG_BYTES);
        assert!(log.starts_with(TRUNCATED));
        assert!(!log.contains("early error"));
        assert_eq!(
            diagnostics
                .iter()
                .filter_map(|d| d.line)
                .collect::<Vec<_>>(),
            vec![7, 9]
        );
    }

    #[test]
    fn readers_continue_to_eof_after_the_caps_are_reached() {
        struct Large {
            remaining: usize,
            read: usize,
        }
        impl Read for Large {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                let n = out.len().min(self.remaining);
                out[..n].fill(b'x');
                self.remaining -= n;
                self.read += n;
                Ok(n)
            }
        }
        let mut reader = Large {
            remaining: 32 * 1024 * 1024,
            read: 0,
        };
        let output = read_output(&mut reader, Path::new(ROOT)).unwrap();
        assert_eq!(reader.read, 32 * 1024 * 1024);
        assert_eq!(reader.remaining, 0);
        assert_eq!(output.tail.len(), STREAM_BYTES);
    }

    #[test]
    fn chunk_splits_crlf_and_final_lines_preserve_diagnostics() {
        struct Short<'a>(&'a [u8]);
        impl Read for Short<'_> {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                if self.0.is_empty() {
                    return Ok(0);
                }
                out[0] = self.0[0];
                self.0 = &self.0[1..];
                Ok(1)
            }
        }
        let output = read_output(
            Short("error: main:3: café\r\nerror: main:4: fin".as_bytes()),
            Path::new(ROOT),
        )
        .unwrap();
        let (_, diagnostics) = combine_streams(output, empty()).finish(true, None);
        assert_eq!(diagnostics[0].message, "café");
        assert_eq!(diagnostics[1].message, "fin");
        assert_eq!(diagnostics[1].line, Some(4));
    }

    #[test]
    fn errors_survive_warning_saturation_and_cross_stream_boilerplate() {
        let mut stdout = Collector::new(Path::new(ROOT));
        stdout.feed(b"error: engine failed\n");
        for _ in 0..400 {
            stdout.feed(b"LaTeX Warning: warning on input line 2.\n");
        }
        let stderr = stream(b"error: main:8: located error\nerror: boilerplate\n");
        let (_, diagnostics) = combine_streams(stdout.finish(), stderr).finish(true, None);
        assert!(diagnostics.len() <= DIAGNOSTICS);
        assert!(diagnostics.iter().any(|d| d.message == "located error"));
        assert!(!diagnostics
            .iter()
            .any(|d| d.message == "engine failed" || d.message == "boilerplate"));
        assert!(diagnostics.iter().any(|d| d.message == TRUNCATED));
    }

    #[test]
    fn decoded_byte_overflow_reports_truncation_in_the_fallback_diagnostic() {
        let mut decoded_overflow = Collector::new(Path::new(ROOT));
        for _ in 0..8 {
            decoded_overflow.feed(&[0xff; 8000]);
            decoded_overflow.feed(b"\n");
        }
        assert!(!decoded_overflow.truncated);
        let (log, diagnostics) =
            combine_streams(decoded_overflow.finish(), empty()).finish(true, None);
        assert!(log.len() <= LOG_BYTES);
        assert!(diagnostics[0].message.contains(TRUNCATED));
    }

    #[test]
    fn earliest_errors_survive_and_synthetic_errors_fit_the_final_budget() {
        let mut errors = Collector::new(Path::new(ROOT));
        for line in 1..=500 {
            errors.feed(format!("error: main:{line}: error\n").as_bytes());
        }
        let (_, diagnostics) = combine_streams(errors.finish(), empty()).finish(true, Some(180));
        assert_eq!(diagnostics.len(), DIAGNOSTICS);
        assert!(diagnostics[0].message.contains("stopped after 180 s"));
        assert!(diagnostics[0].message.contains(TRUNCATED));
        assert_eq!(diagnostics[1].line, Some(1));
        assert_eq!(diagnostics.last().unwrap().line, Some(199));

        let mut warnings = Collector::new(Path::new(ROOT));
        for _ in 0..400 {
            warnings.feed(b"LaTeX Warning: warning on input line 2.\n");
        }
        let (_, diagnostics) = combine_streams(warnings.finish(), empty()).finish(true, None);
        assert_eq!(diagnostics.len(), DIAGNOSTICS);
        assert_eq!(diagnostics[0].severity, Severity::Error);
    }

    #[test]
    fn both_streams_share_one_final_diagnostic_budget() {
        let stdout: String = (1..=150)
            .map(|n| format!("error: main:{n}: stdout\n"))
            .collect();
        let stderr: String = (1001..=1150)
            .map(|n| format!("error: main:{n}: stderr\n"))
            .collect();
        let (_, diagnostics) =
            combine_streams(stream(stdout.as_bytes()), stream(stderr.as_bytes()))
                .finish(true, None);
        assert_eq!(diagnostics.len(), DIAGNOSTICS);
        assert_eq!(diagnostics[0].line, Some(1));
        assert_eq!(diagnostics[198].line, Some(1049));
        assert_eq!(diagnostics[199].message, TRUNCATED);
    }

    #[test]
    fn malformed_utf8_and_line_truncation_include_markers_within_final_limits() {
        let mut invalid = Collector::new(Path::new(ROOT));
        for _ in 0..100 {
            invalid.feed(&[0xff; LINE_BYTES]);
        }
        invalid.feed(b"\nerror: main:6: parsing resumed\n");
        let (log, diagnostics) = combine_streams(invalid.finish(), empty()).finish(true, None);
        assert!(log.len() <= LOG_BYTES);
        assert!(log.lines().count() <= LOG_LINES);
        assert!(log.contains('\u{fffd}'));
        assert!(diagnostics.iter().any(|d| d.line == Some(6)));
        let text = "line\n".repeat(1000);
        let (log, diagnostics) =
            combine_streams(stream(text.as_bytes()), empty()).finish(false, None);
        assert!(log.lines().count() <= LOG_LINES);
        assert!(log.lines().count() > 1);
        assert!(diagnostics.iter().any(|d| d.message == TRUNCATED));
        assert!(log.starts_with(TRUNCATED));
    }

    #[test]
    fn interrupted_reads_retry_and_real_read_errors_propagate() {
        struct Interrupt(bool);
        impl Read for Interrupt {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                if !self.0 {
                    self.0 = true;
                    Err(io::ErrorKind::Interrupted.into())
                } else {
                    Err(io::Error::other("read failed"))
                }
            }
        }
        let error = read_output(Interrupt(false), Path::new(ROOT))
            .err()
            .unwrap();
        assert_eq!(error.to_string(), "read failed");
    }
}
