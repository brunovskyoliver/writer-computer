# Data Model: AI Note Relations + Graph View

Rust types live in `apps/desktop/src-tauri/src/ai.rs`; IPC payload shapes
are mirrored in `apps/desktop/src/lib/ai.ts`. Names below are the intended
exported names.

## WorkspaceState additions

| Field      | Type                                          | Notes                                                                                                          |
| ---------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ai_index` | `RwLock<AiIndex>`                             | Per-workspace; cleared by `reset_workspace_runtime`.                                                           |
| `ai_queue` | `Mutex<Option<mpsc::UnboundedSender<AiJob>>>` | `None` until `ai::kick` spawns the worker; `take()`n on workspace reset — dropping the sender ends the worker. |

## AiJob

```rust
enum AiJob {
    ScanAll,              // embed/link-scan every indexed markdown file
    Changed(PathBuf),     // one file saved/created/changed/deleted
}
```

`Changed` covers deletion too: the worker drops the entry when the path no
longer exists. Jobs are coalesced per-path inside an ~800 ms debounce
window; `ScanAll` replaces any accumulated `Changed` set.

## NoteEntry

One per indexed Markdown file (absolute path key).

| Field            | Type               | Notes                                                                                    |
| ---------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| `hash`           | `u64`              | FNV-1a of raw file bytes. Skip embedding when unchanged.                                 |
| `embedding`      | `Option<Vec<f32>>` | `None` when no embed endpoint is configured or the call failed.                          |
| `links`          | `Vec<String>`      | Resolved absolute paths of `[[…]]` targets (markdown only, deduped, self-links dropped). |
| `math_blocks`    | `Vec<MathBlock>`   | Extracted math blocks — the formula-relation source (line-relations-spec).               |
| `suggested_tags` | `Vec<String>`      | Last chat-model suggestion set; survives re-embed.                                       |

## MathBlock / FormulaRelation

```rust
struct MathBlock {
    normalized: String,  // canonical TeX token stream — the cross-note identity
    line: u32,           // 1-based, first content line of the block
    source: String,      // raw inner source, trimmed
}

struct FormulaRelation {
    a_path: PathBuf, a_line: u32, a_snippet: String,
    b_path: PathBuf, b_line: u32, b_snippet: String,
}
```

`extract_math_blocks` finds `$$…$$`, `\[…\]`, and formula-ish inline `$…$`
(≥8 normalized chars, contains `\ ^ _ =`), skipping frontmatter, fenced
code and inline code. `normalize_math` tokenizes (whitespace-free), drops
no-op commands (`\left`, `\right`, spacing, `\displaystyle`, `\bigl`
family), and collapses single-atom braces (`x_{i}` ≡ `x_i`).
`formula_relations` pairs blocks with identical `normalized` across
different notes — deterministic, no endpoint needed.

## AiIndex

```rust
struct AiIndex {
    notes: HashMap<PathBuf, NoteEntry>,
    /// Queue depth + in-flight count — drives `ai_status.pending`.
    pending: usize,
}
```

## AiSettings (resolved per call, never cached)

| Field               | From key                    | Notes                                                                                                                                |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`           | `ai.enabled`                | `false` → no worker, no HTTP, empty results.                                                                                         |
| `chat_endpoint`     | `ai.chat-endpoint`          | OpenAI-compatible base; chat URL = `{base}/chat/completions`.                                                                        |
| `chat_model`        | `ai.chat-model`             |                                                                                                                                      |
| `chat_key`          | `ai.chat-api-key`           | Bearer; empty = no header.                                                                                                           |
| `fallback_endpoint` | `ai.chat-fallback-endpoint` | Optional second base.                                                                                                                |
| `fallback_key`      | `ai.chat-fallback-api-key`  |                                                                                                                                      |
| `embed_endpoint`    | `ai.embed-endpoint`         | Embed URL = `{base}/embeddings` (no `/v1` appended — TEI mounts at root; an OpenAI-compat server is configured with its `/v1` base). |
| `embed_model`       | `ai.embed-model`            |                                                                                                                                      |

All `get_global_or_default` reads — the keys are `scope: "global"`.

## Sidecar file

`app_data_dir()/ai-graph/<fnv1a64(root_path_str)>:016x.json`. Atomic write
(temp + rename, same pattern as session saves).

```json
{
  "version": 2,
  "root": "/Users/x/vault",
  "embed_endpoint": "http://100.127.4.22:8080",
  "embed_model": "Qwen/Qwen3-Embedding-0.6B",
  "notes": [
    {
      "path": "Math/limits.md",      // workspace-relative
      "hash": 1234567890,
      "embedding": [0.01, ...],      // omitted when null
      "links": ["/abs/path/…md"],    // absolute, matching NoteEntry
      "math_blocks": [{"normalized": "E = m c ^ 2", "line": 7, "source": "E = mc^2"}],
      "suggested_tags": ["calculus"]
    }
  ]
}
```

Load rules: wrong `version`/`root` → ignore whole file; `embed_endpoint` or
`embed_model` mismatch → keep `hash`/`links`/`suggested_tags` but drop
`embedding` (re-embed on next scan — `embedding: None` marks it dirty).
Unknown note paths that no longer exist are skipped on load and pruned on
the next `ScanAll`.

## Graph payload (`ai_graph` return)

```ts
interface AiGraphNode {
  path: string; // absolute
  name: string; // file stem (IndexedFile.name minus ext)
  suggested_tags: string[]; // from AiIndex, [] when absent
}
interface AiGraphEdge {
  source: string; // absolute path
  target: string; // absolute path
  kind: "link" | "similar" | "formula";
  score: number | null; // cosine for "similar"; null otherwise
}
interface AiGraph {
  nodes: AiGraphNode[];
  edges: AiGraphEdge[];
}
```

- `nodes`: every markdown file in `file_index` (indexed set, not just
  embedded ones — orphan notes show as isolated nodes, matching Obsidian).
- `link` edges: union of all entries' `links`, deduped, both endpoints
  present in `nodes`.
- `similar` edges: cosine over stored embeddings, per-node top-2 above
  `SIMILARITY_FLOOR = 0.6`; symmetric pairs deduped keeping the higher
  score; a pair that is already a `link` edge is not duplicated as
  `similar`.
- `formula` edges: one per note pair sharing ≥1 normalized formula
  (`formula_relations`), skipping pairs a `link` edge already covers.

## Related payload (`ai_related` return)

```ts
interface RelatedItem {
  kind: "formula" | "similar";
  path: string;
  line: number | null; // shared-formula line in `path` (formula only)
  score: number | null; // cosine (similar only)
  snippet: string | null; // shared formula's first source line in `path`
}
```

Formula items first (up to `FORMULA_RELATED_CAP = 5`, the strongest
evidence), then top-k cosine neighbors (`RELATED_TOP_K = 3`,
`RELATED_FLOOR = 0.5`).

## Status payload (`ai_status` return)

```ts
interface AiStatus {
  enabled: boolean;
  chat_ok: boolean; // GET {chat_endpoint}/models ≤3 s, auth applied
  embed_ok: boolean; // POST {embed_endpoint}/embeddings probe ≤3 s
  indexed: number; // notes with an entry in AiIndex
  pending: number; // queued + in-flight paths
}
```

`chat_ok`/`embed_ok` are `false` when the endpoint is unconfigured — the UI
reads "off" and "unreachable" the same way; the configured string is shown
for debugging.

## Suggestion card state (`stores/ai-store.ts`)

```ts
interface AiPanelState {
  panelFor: string | null; // note path the card is open for
  suggestions: string[]; // pending (not yet accepted/dismissed)
  related: RelatedItem[]; // filled on open
  loading: boolean;
  error: string | null;
  graphVersion: number; // bumped by ai:graph-changed
}
```

## Frontmatter write shape

Accepted tags merge into the existing `tags` key (or create it):

```yaml
tags:
  - calculus
  - limits
```

Merge rules: existing `tags` may be a YAML list or a scalar
(string/comma-separated) — both normalize to a list; new tags append,
case-insensitive dedupe, other frontmatter keys preserved. The merge helper
is `mergeTagsIntoFrontmatter(fm: string | null, tags: string[]): string`
in `lib/ai.ts`.
