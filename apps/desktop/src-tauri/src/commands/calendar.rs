//! Read-only calendar feed ingestion for lesson notes.
//!
//! A feed URL usually embeds a private token. It stays in the app data
//! directory, never reaches the frontend, and never appears in an error.

use crate::error::AppError;
use crate::AppState;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::Manager;

const MAX_FEED_BYTES: usize = 5 * 1024 * 1024;
const FRONTMATTER_PROBE_BYTES: u64 = 8 * 1024;
static FEEDS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize, PartialEq)]
pub struct CalendarEvent {
    uid: String,
    occurrence_key: String,
    summary: String,
    description: String,
    location: Option<String>,
    start: String,
    end: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct CalendarFeed {
    events: Vec<CalendarEvent>,
    /// Recurring, cancelled, all-day or floating-time events this parser can't place.
    skipped: usize,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct CalendarNote {
    path: String,
    occurrence: String,
    course: Option<String>,
}

fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            // itslearning writes CRLF as an escaped pair: `\r\n`.
            Some('r' | 'R') | None => {}
            Some(other) => out.push(other),
        }
    }
    out
}

/// `20261005T081500Z` as the ISO form lesson notes already store in
/// `calendar-occurrence`, so existing notes keep matching.
fn utc_to_iso(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 16
        && bytes[8] == b'T'
        && bytes[15] == b'Z'
        && bytes[..8].iter().all(u8::is_ascii_digit)
        && bytes[9..15].iter().all(u8::is_ascii_digit);
    valid.then(|| {
        format!(
            "{}-{}-{}T{}:{}:{}.000Z",
            &value[..4],
            &value[4..6],
            &value[6..8],
            &value[9..11],
            &value[11..13],
            &value[13..15]
        )
    })
}

pub fn parse_ics(text: &str) -> Result<CalendarFeed, String> {
    let unfolded = text
        .replace("\r\n", "\n")
        .replace("\n ", "")
        .replace("\n\t", "");
    if !unfolded.trim_start().starts_with("BEGIN:VCALENDAR") {
        return Err("The calendar link did not return a calendar.".into());
    }
    let mut feed = CalendarFeed {
        events: Vec::new(),
        skipped: 0,
    };
    let mut current: Option<HashMap<String, (String, String)>> = None;
    for line in unfolded.lines() {
        match line {
            "BEGIN:VEVENT" => current = Some(HashMap::new()),
            "END:VEVENT" => {
                if let Some(props) = current.take() {
                    match event_from_props(&props) {
                        Some(event) => feed.events.push(event),
                        None => feed.skipped += 1,
                    }
                }
            }
            _ => {
                let (Some(props), Some((head, value))) = (current.as_mut(), line.split_once(':'))
                else {
                    continue;
                };
                let (name, params) = head.split_once(';').unwrap_or((head, ""));
                props.insert(
                    name.to_ascii_uppercase(),
                    (params.to_string(), value.to_string()),
                );
            }
        }
    }
    Ok(feed)
}

fn event_from_props(props: &HashMap<String, (String, String)>) -> Option<CalendarEvent> {
    if props.contains_key("RRULE") {
        return None;
    }
    let value = |name: &str| props.get(name).map(|(_, value)| value.as_str());
    if value("STATUS").is_some_and(|status| status.eq_ignore_ascii_case("CANCELLED")) {
        return None;
    }
    let uid = unescape(value("UID")?);
    let start = utc_to_iso(value("DTSTART")?)?;
    let end = utc_to_iso(value("DTEND")?)?;
    Some(CalendarEvent {
        occurrence_key: format!("{uid}::{start}"),
        uid,
        summary: unescape(value("SUMMARY").unwrap_or_default()),
        description: unescape(value("DESCRIPTION").unwrap_or_default()),
        location: value("LOCATION")
            .filter(|location| !location.is_empty())
            .map(unescape),
        start,
        end,
    })
}

/// The frontmatter fields a lesson note is identified by.
pub fn parse_calendar_note(path: &str, head: &str) -> Option<CalendarNote> {
    let mut lines = head.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let unquote = |raw: &str| {
        let raw = raw.trim();
        match raw.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
            Some(inner) => inner.replace("\\\"", "\"").replace("\\\\", "\\"),
            None => raw.to_string(),
        }
    };
    let (mut occurrence, mut course) = (None, None);
    for line in lines {
        if line.trim_end() == "---" {
            break;
        }
        if let Some(raw) = line.strip_prefix("calendar-occurrence:") {
            occurrence = Some(unquote(raw));
        } else if let Some(raw) = line.strip_prefix("course:") {
            course = Some(unquote(raw));
        }
    }
    Some(CalendarNote {
        path: path.to_string(),
        occurrence: occurrence?,
        course,
    })
}

fn normalize_feed_url(raw: &str) -> Result<String, AppError> {
    let raw = raw.trim();
    let invalid =
        || AppError::Io("The calendar link must start with webcal:// or https://.".into());
    let (scheme, rest) = raw.split_once("://").ok_or_else(invalid)?;
    if rest.is_empty() {
        return Err(invalid());
    }
    match scheme.to_ascii_lowercase().as_str() {
        "webcal" | "https" => Ok(format!("https://{rest}")),
        // The native harness serves a synthetic feed on loopback.
        #[cfg(feature = "e2e")]
        "http" if rest.starts_with("127.0.0.1:") => Ok(raw.to_string()),
        _ => Err(invalid()),
    }
}

fn feeds_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("calendar_feeds.json"))
}

fn read_feeds(path: &std::path::Path) -> Result<HashMap<String, String>, AppError> {
    match std::fs::read_to_string(path) {
        Ok(data) => serde_json::from_str(&data)
            .map_err(|_| AppError::Io("The stored calendar settings could not be read.".into())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(error.into()),
    }
}

fn write_feeds(path: &std::path::Path, feeds: &HashMap<String, String>) -> Result<(), AppError> {
    let data = serde_json::to_vec_pretty(feeds).map_err(|e| AppError::Io(e.to_string()))?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    // `mode` applies only on creation.
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    file.write_all(&data)?;
    Ok(())
}

fn workspace_root(webview: &tauri::Webview, app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let (root, _) = state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;
    Ok(root)
}

#[tauri::command]
pub fn calendar_feed_configured(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<bool, AppError> {
    let root = workspace_root(&webview, &app)?;
    let _guard = FEEDS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok(read_feeds(&feeds_path(&app)?)?.contains_key(&*root.to_string_lossy()))
}

/// Store the workspace's feed link, or remove it with `None`.
#[tauri::command]
pub fn set_calendar_feed(
    url: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let root = workspace_root(&webview, &app)?;
    let url = url.as_deref().map(normalize_feed_url).transpose()?;
    let _guard = FEEDS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = feeds_path(&app)?;
    let mut feeds = read_feeds(&path)?;
    let key = root.to_string_lossy().to_string();
    match url {
        Some(url) => feeds.insert(key, url),
        None => feeds.remove(&key),
    };
    write_feeds(&path, &feeds)
}

async fn download_feed(url: &str) -> Result<String, AppError> {
    // Every reqwest error is stripped of its URL, which holds the token.
    let failed = |error: reqwest::Error| {
        AppError::Io(format!(
            "Could not reach the calendar: {}",
            error.without_url()
        ))
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .https_only(!cfg!(feature = "e2e"))
        .build()
        .map_err(failed)?;
    let mut response = client.get(url).send().await.map_err(failed)?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(AppError::Io(
            "The calendar rejected the link. It may have expired.".into(),
        ));
    }
    if !status.is_success() {
        return Err(AppError::Io(format!(
            "The calendar returned HTTP {}.",
            status.as_u16()
        )));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(failed)? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_FEED_BYTES {
            return Err(AppError::Io("The calendar is too large to read.".into()));
        }
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

#[tauri::command]
pub async fn fetch_calendar(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Option<CalendarFeed>, AppError> {
    let root = workspace_root(&webview, &app)?;
    let url = {
        let _guard = FEEDS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        read_feeds(&feeds_path(&app)?)?
            .get(&*root.to_string_lossy())
            .cloned()
    };
    let Some(url) = url else { return Ok(None) };
    let body = download_feed(&url).await?;
    parse_ics(&body).map(Some).map_err(AppError::Io)
}

/// Every note in the workspace that records a calendar occurrence. Note
/// frontmatter is the only duplicate check, so renames and moves keep working.
#[tauri::command]
pub async fn find_calendar_notes(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<CalendarNote>, AppError> {
    let root = workspace_root(&webview, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (files, _) =
            super::search::index_workspace_impl(&root, Arc::new(AtomicBool::new(false)));
        files
            .into_iter()
            .filter(|file| {
                file.path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
            })
            .filter_map(|file| {
                let mut head = Vec::new();
                std::fs::File::open(&file.path)
                    .ok()?
                    .take(FRONTMATTER_PROBE_BYTES)
                    .read_to_end(&mut head)
                    .ok()?;
                parse_calendar_note(
                    &file.path.to_string_lossy(),
                    &String::from_utf8_lossy(&head),
                )
            })
            .collect()
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shape copied from a real itslearning feed, with synthetic values.
    const FEED: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Calendar\r\nBEGIN:VEVENT\r\nDESCRIPTION:Room 1 Teacher\\r\\n\\nEigenvalues\\, and more\r\nDTEND:20261005T100000Z\r\nDTSTAMP:20261001T000000Z\r\nDTSTART:20261005T081500Z\r\nSEQUENCE:0\r\nSUMMARY:Semester project: Software\\, (E26): Lessons - Room\r\n 1\r\nUID:abc=@itslearning.com\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261006\r\nDTEND;VALUE=DATE:20261007\r\nUID:all-day\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART:20261005T081500Z\r\nDTEND:20261005T100000Z\r\nRRULE:FREQ=WEEKLY\r\nUID:recurring\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn parses_events_and_counts_what_it_cannot_place() {
        let feed = parse_ics(FEED).unwrap();
        assert_eq!(feed.skipped, 2);
        assert_eq!(
            feed.events,
            vec![CalendarEvent {
                uid: "abc=@itslearning.com".into(),
                occurrence_key: "abc=@itslearning.com::2026-10-05T08:15:00.000Z".into(),
                summary: "Semester project: Software, (E26): Lessons - Room1".into(),
                description: "Room 1 Teacher\n\nEigenvalues, and more".into(),
                location: None,
                start: "2026-10-05T08:15:00.000Z".into(),
                end: "2026-10-05T10:00:00.000Z".into(),
            }]
        );
    }

    #[test]
    fn html_is_not_a_calendar_even_with_the_right_content_type() {
        assert!(parse_ics("<html></html>").is_err());
    }

    #[test]
    fn reads_notes_the_course_workspaces_plugin_wrote() {
        let head = "---\ncourse: \"Math, (E26): Lessons \\\"A\\\"\"\ncalendar-occurrence: \"u::2026-10-07T12:30:00.000Z\"\n---\nbody calendar-occurrence: no";
        assert_eq!(
            parse_calendar_note("/v/a.md", head),
            Some(CalendarNote {
                path: "/v/a.md".into(),
                occurrence: "u::2026-10-07T12:30:00.000Z".into(),
                course: Some("Math, (E26): Lessons \"A\"".into()),
            })
        );
        assert_eq!(
            parse_calendar_note("/v/b.md", "# calendar-occurrence: x"),
            None
        );
        assert_eq!(parse_calendar_note("/v/c.md", "---\ntitle: x\n---\n"), None);
    }

    #[test]
    fn feed_urls_must_be_secure_and_errors_hide_them() {
        assert_eq!(
            normalize_feed_url(" WEBCAL://host/secret ").unwrap(),
            "https://host/secret"
        );
        let error = normalize_feed_url("http://host/secret")
            .unwrap_err()
            .to_string();
        assert!(!error.contains("secret"));
    }

    #[test]
    fn stored_feeds_are_private_to_the_user() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("feeds.json");
        write_feeds(
            &path,
            &HashMap::from([("/v".to_string(), "https://x".to_string())]),
        )
        .unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(read_feeds(&path).unwrap()["/v"], "https://x");
    }
}
