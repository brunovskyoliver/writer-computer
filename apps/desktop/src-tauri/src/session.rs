//! The session wire format and its codec: the Rust half of
//! `SPECs/tab-tiling-splits/contracts/session.md`.
//!
//! The frontend's `lib/session.ts` declares the same shape and the same
//! rules. Neither side trusts the other: both classify a stored record as
//! missing, ready, or malformed, both migrate legacy flat sessions, both
//! prune missing files the same way, and both extract the focused file. The
//! fixtures under `SPECs/tab-tiling-splits/fixtures/sessions/` are what
//! holds the two to one behaviour; the tests at the bottom run every one.
//!
//! Nothing here does I/O. `commands/workspace.rs` owns the file.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Session-persisted location. The `kind` tag plus a free-form payload lets
/// unknown kinds (from a newer client) round-trip without data loss.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SerializedLocation {
    pub kind: String,
    #[serde(flatten)]
    pub payload: Map<String, Value>,
}

impl SerializedLocation {
    fn path(&self) -> Option<&str> {
        self.payload.get("path").and_then(Value::as_str)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionTab {
    pub id: String,
    pub location: SerializedLocation,
    #[serde(default)]
    pub back: Vec<SerializedLocation>,
    #[serde(default)]
    pub forward: Vec<SerializedLocation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    X,
    Y,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LayoutNode {
    Pane {
        id: String,
        tab_ids: Vec<String>,
        #[serde(default)]
        active_tab_id: Option<String>,
    },
    Split {
        id: String,
        axis: Axis,
        ratio: f64,
        /// Deserialized as a list so a wrong count is a diagnostic, not a
        /// serde error that reads like a typo.
        children: Vec<LayoutNode>,
    },
}

impl LayoutNode {
    fn id(&self) -> &str {
        match self {
            LayoutNode::Pane { id, .. } | LayoutNode::Split { id, .. } => id,
        }
    }

    /// Panes depth-first, first child before second: tree order.
    fn panes(&self) -> Vec<&LayoutNode> {
        match self {
            LayoutNode::Pane { .. } => vec![self],
            LayoutNode::Split { children, .. } => children.iter().flat_map(|c| c.panes()).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionLayout {
    pub root: LayoutNode,
    pub focused_pane_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionV2 {
    pub version: u32,
    #[serde(default)]
    pub tabs: Vec<SessionTab>,
    pub layout: SessionLayout,
}

/// What a stored record turned out to be. Serialized with a `status` tag so
/// the frontend can switch on it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum SessionRecord {
    Missing,
    Ready { session: SessionV2 },
    Malformed { problems: Vec<String> },
}

const VERSION: u32 = 2;

/// Classify a raw record. An absent version and layout plus a tab list is
/// v1; anything else that is not a valid v2 is malformed, and malformed is
/// never quietly read as v1.
pub fn parse_session(raw: Option<&Value>) -> SessionRecord {
    let raw = match raw {
        None | Some(Value::Null) => return SessionRecord::Missing,
        Some(value) => value,
    };
    let object = match raw.as_object() {
        Some(object) => object,
        None => return malformed(vec!["session record is not an object".into()]),
    };

    let session = if object.get("version").is_none() && object.get("layout").is_none() {
        match migrate_v1(object) {
            Ok(session) => session,
            Err(problems) => return malformed(problems),
        }
    } else {
        match object.get("version").and_then(Value::as_u64) {
            Some(v) if v == u64::from(VERSION) => {}
            other => {
                return malformed(vec![format!(
                    "unsupported session version {}",
                    other
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "none".into())
                )]);
            }
        }
        match serde_json::from_value::<SessionV2>(raw.clone()) {
            Ok(session) => session,
            Err(error) => return malformed(vec![error.to_string()]),
        }
    };

    let problems = validate(&session);
    if problems.is_empty() {
        SessionRecord::Ready { session }
    } else {
        malformed(problems)
    }
}

fn malformed(problems: Vec<String>) -> SessionRecord {
    SessionRecord::Malformed { problems }
}

/// A legacy flat session: assign ids before anything is filtered so the
/// active tab keeps its identity through pruning, then wrap in one pane.
fn migrate_v1(raw: &Map<String, Value>) -> Result<SessionV2, Vec<String>> {
    let entries = raw
        .get("tabs")
        .and_then(Value::as_array)
        .ok_or_else(|| vec!["legacy session has no tab list".to_string()])?;
    let mut problems = Vec::new();
    let mut tabs = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let mut object = match entry.as_object() {
            Some(object) => object.clone(),
            None => {
                problems.push(format!("tab {index} is not an object"));
                continue;
            }
        };
        object.insert("id".into(), Value::String(format!("tab-{}", index + 1)));
        match serde_json::from_value::<SessionTab>(Value::Object(object)) {
            Ok(tab) => tabs.push(tab),
            Err(error) => problems.push(format!("tab {index}: {error}")),
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let active = raw
        .get("active_index")
        .and_then(Value::as_u64)
        .and_then(|index| tabs.get(index as usize))
        .or_else(|| tabs.first())
        .map(|tab| tab.id.clone());
    Ok(SessionV2 {
        version: VERSION,
        layout: SessionLayout {
            root: LayoutNode::Pane {
                id: "pane-1".into(),
                tab_ids: tabs.iter().map(|tab| tab.id.clone()).collect(),
                active_tab_id: active,
            },
            focused_pane_id: "pane-1".into(),
        },
        tabs,
    })
}

/// Every invariant the record must hold, as human-readable problems. Empty
/// means valid. Mirrors `validateSession` in `lib/session.ts`.
pub fn validate(session: &SessionV2) -> Vec<String> {
    let mut problems = Vec::new();
    let mut tab_ids = HashSet::new();
    for tab in &session.tabs {
        if !tab_ids.insert(tab.id.as_str()) {
            problems.push(format!("duplicate tab id {}", tab.id));
        }
    }

    let mut node_ids = HashSet::new();
    let mut owned = HashSet::new();
    walk(
        &session.layout.root,
        true,
        &tab_ids,
        &mut node_ids,
        &mut owned,
        &mut problems,
    );

    for tab in &session.tabs {
        if !owned.contains(tab.id.as_str()) {
            problems.push(format!("tab {} is not in any pane", tab.id));
        }
    }
    let focused = session
        .layout
        .root
        .panes()
        .into_iter()
        .any(|pane| pane.id() == session.layout.focused_pane_id);
    if !focused {
        problems.push(format!(
            "focused pane {} does not exist",
            session.layout.focused_pane_id
        ));
    }
    problems
}

fn walk<'a>(
    node: &'a LayoutNode,
    is_root: bool,
    tab_ids: &HashSet<&str>,
    node_ids: &mut HashSet<&'a str>,
    owned: &mut HashSet<&'a str>,
    problems: &mut Vec<String>,
) {
    if !node_ids.insert(node.id()) {
        problems.push(format!("duplicate node id {}", node.id()));
    }
    match node {
        LayoutNode::Split {
            id,
            ratio,
            children,
            ..
        } => {
            if children.len() != 2 {
                problems.push(format!("split {id} must have exactly two children"));
            }
            if !ratio.is_finite() || *ratio <= 0.0 || *ratio >= 1.0 {
                problems.push(format!(
                    "split {id} ratio {ratio} must be finite and within (0, 1)"
                ));
            }
            for child in children {
                walk(child, false, tab_ids, node_ids, owned, problems);
            }
        }
        LayoutNode::Pane {
            id,
            tab_ids: members,
            active_tab_id,
        } => {
            for tab_id in members {
                if !tab_ids.contains(tab_id.as_str()) {
                    problems.push(format!("pane {id} references unknown tab {tab_id}"));
                }
                if !owned.insert(tab_id.as_str()) {
                    problems.push(format!("tab {tab_id} appears in more than one pane"));
                }
            }
            if members.is_empty() {
                if !is_root {
                    problems.push(format!("empty pane {id} must collapse"));
                }
                if active_tab_id.is_some() {
                    problems.push(format!("empty pane {id} has an active member"));
                }
            } else {
                match active_tab_id {
                    Some(active) if members.contains(active) => {}
                    _ => problems.push(format!("pane {id} has no active member")),
                }
            }
        }
    }
}

/// Drop tabs whose location is missing and history entries that reference a
/// missing path, collapse what that empties, and repair active and focus
/// members. `None` when nothing remains. Mirrors `pruneSession`.
pub fn prune_session(session: &SessionV2, is_missing: impl Fn(&str) -> bool) -> Option<SessionV2> {
    let entry_missing = |location: &SerializedLocation| location.path().is_some_and(&is_missing);
    let tabs: Vec<SessionTab> = session
        .tabs
        .iter()
        .filter(|tab| !entry_missing(&tab.location))
        .map(|tab| SessionTab {
            id: tab.id.clone(),
            location: tab.location.clone(),
            back: tab
                .back
                .iter()
                .filter(|entry| !entry_missing(entry))
                .cloned()
                .collect(),
            forward: tab
                .forward
                .iter()
                .filter(|entry| !entry_missing(entry))
                .cloned()
                .collect(),
        })
        .collect();
    let keep: HashSet<&str> = tabs.iter().map(|tab| tab.id.as_str()).collect();
    let root = prune_node(&session.layout.root, &keep)?;
    let focused_pane_id = {
        let panes = root.panes();
        let survives = panes
            .iter()
            .any(|pane| pane.id() == session.layout.focused_pane_id);
        if survives {
            session.layout.focused_pane_id.clone()
        } else {
            panes[0].id().to_string()
        }
    };
    Some(SessionV2 {
        version: VERSION,
        tabs,
        layout: SessionLayout {
            root,
            focused_pane_id,
        },
    })
}

fn prune_node(node: &LayoutNode, keep: &HashSet<&str>) -> Option<LayoutNode> {
    match node {
        LayoutNode::Split {
            id,
            axis,
            ratio,
            children,
        } => {
            let first = children.first().and_then(|c| prune_node(c, keep));
            let second = children.get(1).and_then(|c| prune_node(c, keep));
            match (first, second) {
                (Some(first), Some(second)) => Some(LayoutNode::Split {
                    id: id.clone(),
                    axis: *axis,
                    ratio: *ratio,
                    children: vec![first, second],
                }),
                (Some(only), None) | (None, Some(only)) => Some(only),
                (None, None) => None,
            }
        }
        LayoutNode::Pane {
            id,
            tab_ids,
            active_tab_id,
        } => {
            let survivors: Vec<String> = tab_ids
                .iter()
                .filter(|tab_id| keep.contains(tab_id.as_str()))
                .cloned()
                .collect();
            if survivors.is_empty() {
                return None;
            }
            let active = match active_tab_id {
                Some(active) if keep.contains(active.as_str()) => active.clone(),
                other => {
                    // The tab that slides into the removed slot, else the one
                    // before it — the slot counted among survivors.
                    let index = other
                        .as_ref()
                        .and_then(|active| tab_ids.iter().position(|t| t == active))
                        .unwrap_or(0);
                    let slot = tab_ids[..index]
                        .iter()
                        .filter(|t| keep.contains(t.as_str()))
                        .count();
                    survivors
                        .get(slot)
                        .unwrap_or_else(|| survivors.last().expect("non-empty"))
                        .clone()
                }
            };
            Some(LayoutNode::Pane {
                id: id.clone(),
                tab_ids: survivors,
                active_tab_id: Some(active),
            })
        }
    }
}

/// The path the bundled restore prefetches: the focused pane's active tab,
/// when that is a plain file.
pub fn focused_session_file(session: &SessionV2) -> Option<String> {
    let panes = session.layout.root.panes();
    let focused = panes
        .into_iter()
        .find(|pane| pane.id() == session.layout.focused_pane_id)?;
    let active = match focused {
        LayoutNode::Pane { active_tab_id, .. } => active_tab_id.as_ref()?,
        LayoutNode::Split { .. } => return None,
    };
    let tab = session.tabs.iter().find(|tab| &tab.id == active)?;
    if tab.location.kind != "file" {
        return None;
    }
    tab.location.path().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[derive(Deserialize)]
    struct Fixture {
        input: Value,
        #[serde(default)]
        missing_files: Vec<String>,
        expected: Expected,
    }

    #[derive(Deserialize)]
    struct Expected {
        status: String,
        #[serde(default)]
        session: Value,
        #[serde(default)]
        focused_file: Option<String>,
    }

    fn fixtures() -> Vec<(String, Fixture)> {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../SPECs/tab-tiling-splits/fixtures/sessions");
        let mut entries: Vec<_> = std::fs::read_dir(&dir)
            .expect("fixture directory")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .collect();
        entries.sort();
        entries
            .into_iter()
            .map(|path| {
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                let text = std::fs::read_to_string(&path).unwrap();
                let fixture: Fixture =
                    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
                (name, fixture)
            })
            .collect()
    }

    #[test]
    fn shared_fixtures_agree_with_the_frontend_codec() {
        let cases = fixtures();
        assert!(cases.len() > 20, "fixture directory looks empty");
        for (name, fixture) in cases {
            let record = parse_session(Some(&fixture.input));
            let status = match &record {
                SessionRecord::Missing => "missing",
                SessionRecord::Ready { .. } => "ready",
                SessionRecord::Malformed { .. } => "malformed",
            };
            assert_eq!(status, fixture.expected.status, "{name}: status {record:?}");
            let session = match record {
                SessionRecord::Ready { session } => session,
                SessionRecord::Malformed { problems } => {
                    assert!(!problems.is_empty(), "{name}: no diagnostics");
                    continue;
                }
                SessionRecord::Missing => continue,
            };
            let missing: HashSet<&str> = fixture.missing_files.iter().map(String::as_str).collect();
            let pruned = prune_session(&session, |path| missing.contains(path));
            let actual = serde_json::to_value(&pruned).unwrap();
            assert_eq!(actual, fixture.expected.session, "{name}: pruned session");
            let focused = pruned.as_ref().and_then(focused_session_file);
            assert_eq!(
                focused, fixture.expected.focused_file,
                "{name}: focused file"
            );
        }
    }

    #[test]
    fn a_ready_record_serializes_with_its_status_tag() {
        let record = parse_session(Some(&serde_json::json!({
            "tabs": [{ "location": { "kind": "file", "path": "/v/a.md" }, "back": [], "forward": [] }],
            "active_index": 0
        })));
        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(value["status"], "ready");
        assert_eq!(value["session"]["version"], 2);
        assert_eq!(value["session"]["layout"]["focused_pane_id"], "pane-1");
    }

    #[test]
    fn a_saved_payload_round_trips_through_validation() {
        let session = SessionV2 {
            version: 2,
            tabs: vec![SessionTab {
                id: "t".into(),
                location: SerializedLocation {
                    kind: "file".into(),
                    payload: [("path".to_string(), Value::String("/v/a.md".into()))]
                        .into_iter()
                        .collect(),
                },
                back: vec![],
                forward: vec![],
            }],
            layout: SessionLayout {
                root: LayoutNode::Pane {
                    id: "p".into(),
                    tab_ids: vec!["t".into()],
                    active_tab_id: Some("t".into()),
                },
                focused_pane_id: "p".into(),
            },
        };
        assert!(validate(&session).is_empty());
        let value = serde_json::to_value(&session).unwrap();
        assert!(matches!(
            parse_session(Some(&value)),
            SessionRecord::Ready { session: back } if back == session
        ));
    }
}
