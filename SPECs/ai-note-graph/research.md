# Research: AI note relations, suggested tags, and a graph view

Feasibility + impact research for a requested feature: an AI-backed index
that maps relations between notes and suggests tags, rendered as an
Obsidian-style graph, running in the background against a user-hosted local
model endpoint. Hard requirement from the requester: **the feature must never
rewrite notes** — AI output is suggestion/overlay only.

Verdict: feasible with existing dependencies and established codebase
patterns. No new Rust dependencies are required (`reqwest` and `tokio` are
already in `Cargo.toml`). The main design choice is which of two different
model jobs the endpoint actually serves.

## R1. Endpoint surface: one OpenAI-compatible client covers every local server

**Finding**: the three mainstream local servers all expose the OpenAI API
shape, so a single `reqwest` client against a configurable `base_url` +
optional bearer token covers all of them — and real OpenAI too, should the
user ever point it there.

- Ollama: native `POST /api/embed` (batch `input` array, `keep_alive`,
  `dimensions`, L2-normalized vectors) _and_ OpenAI-compatible
  `http://localhost:11434/v1/chat/completions` + `/v1/embeddings`.
  Sources: https://docs.ollama.com/api/embed ,
  https://docs.ollama.com/openai ,
  https://github.com/ollama/ollama/blob/main/docs/openapi.yaml
- llama.cpp `llama-server`: `/v1/chat/completions`, `/v1/embeddings`
  (embeddings require `--embedding` plus a pooling mode other than `none`),
  schema-constrained JSON output.
  Source: https://github.com/ggml-org/llama.cpp/blob/HEAD/tools/server/README.md
- LM Studio: `/v1/chat/completions`, `/v1/embeddings` on `localhost:1234`.
  Source: https://lmstudio.ai/docs/developer/openai-compat

**Implication**: settings need `ai.endpoint` (default
`http://localhost:11434/v1`), `ai.embed-model`, `ai.chat-model`, optional API
key. Do not implement an Ollama-native path as well — that is a second
client for zero capability. (Ollama's `/api/embed` has `keep_alive`, which
is nice for unloading the model; the OpenAI surface lacks it, but Ollama's
default 5-minute unload already bounds residency.)

**Requester's endpoints, verified live 2026-09-22**:

| Role            | URL                           | Server    | Model                                                              | Status                                                    |
| --------------- | ----------------------------- | --------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| Chat (primary)  | `http://100.127.4.22:8000/v1` | vLLM      | `qwen3-8b` → `Qwen/Qwen3-8B-FP8`, 32k ctx                          | 200 on `/v1/models` with bearer key                       |
| Chat (fallback) | `http://127.0.0.1:8000/v1`    | MTPLX     | `mtplx`                                                            | 401 — needs its own API key                               |
| Embeddings      | `http://100.127.4.22:8080`    | TEI 1.9.4 | `Qwen/Qwen3-Embedding-0.6B`, 1024-dim, last-token pooling, 16k ctx | live — `POST /embeddings` and `POST /embed` both verified |

- `100.127.4.22` is a Tailscale (CGNAT) address: the "remote" host is the
  user's own machine on their tailnet. Traffic is plain HTTP — the
  WireGuard layer encrypts it, but note contents do leave the app host.
- Chat auth: bearer key (user-supplied — **never commit it; it belongs in
  the global config file under app data dir**).
- TEI serves the OpenAI response shape at `POST /embeddings` — **without**
  the `/v1` prefix — plus native `POST /embed`. So the client must not
  blindly append `/v1`: treat configured bases as full prefixes and let the
  embedding path be `{base}/embeddings` while chat is
  `{base}/chat/completions`. TEI details: `max_client_batch_size` 64,
  `max_concurrent_requests` 512, `auto_truncate` — batch-friendly.
- vLLM supports schema-constrained output (`response_format` with
  `json_schema` / `guided_json`), so tag extraction gets structured output
  on the primary too.
- Fallback semantics: chat tries primary first, falls back to local MTPLX
  on connect error/timeout/5xx. Embeddings have no fallback until the local
  MTPLX is launched with `mtplx serve --embedding-model …` — optional, and
  retrieval models there load lazily + LRU-unload
  (`--retrieval-max-resident`, default 2). `/v1/rerank` on MTPLX is a free
  extra for sharpening top-k edges later.
  Sources: https://mtplx.com/docs/ , https://github.com/youssofal/mtplx

## R2. Two different model jobs — do not conflate them

The request bundles two capabilities that map to two different endpoint
types:

1. **"Map out relations"** → _embeddings_. One vector per note, cosine
   similarity gives "related notes" edges. This is exactly how Obsidian's
   Smart Connections plugin works — it embeds the vault with a local model
   and shows semantically related notes in a list + mini graph.
   Source: https://github.com/brianpetro/obsidian-smart-connections ,
   https://community.obsidian.md/plugins/smart-connections
2. **"Create tags"** → _chat completion_. Ask a chat model to return
   `{"tags": [...]}` per note. Structured output is supported everywhere
   needed: Ollama accepts a JSON schema in `format` (native `/api/*`; on
   `/v1` use `response_format: {type:"json_schema"}` / `json_object`), and
   llama.cpp constrains output by schema.
   Sources: https://docs.ollama.com/api/generate ,
   https://github.com/ollama/ollama/blob/main/docs/openapi.yaml ,
   https://github.com/ggml-org/llama.cpp/blob/HEAD/tools/server/README.md

**Implication**: embeddings are the cheap, always-on backbone; chat-model
tagging is the expensive, optional layer (see R8). A user's single endpoint
may only serve one kind — the settings should treat them independently and
degrade gracefully (no embedding model → links/tags-only graph; no chat
model → no tag suggestions).

## R3. Deterministic edges are already free

Writer already parses and resolves `[[wikilinks]]`
(`apps/desktop/src/lib/wiki-links.ts`) — stem lookup, path targets,
fragments, aliases. Obsidian's graph is built _only_ from these internal
links (nodes sized by inbound count, local graph with depth slider,
filters for tags/orphans/existing-only).
Source: https://obsidian.md/help/plugins/graph

**Implication**: a correct-by-construction graph needs a Rust-side wikilink
scan during indexing (parallel to `content_search_impl`'s walk) so edges are
authoritative and available even before embeddings exist. Layer order:

- Tier 0 — explicit `[[links]]` (deterministic, zero AI, zero cost)
- Tier 1 — shared real `#tags` (once `SPECs/tags-spec.md` ships; it is in
  the backlog, not implemented)
- Tier 2 — embedding-similarity edges, styled distinctly (Obsidian has no
  equivalent; render as a separate edge class so users can tell "I linked
  this" from "the model thinks these are related")

## R4. Background execution: every pattern needed already exists

The codebase's own precedents cover all threading requirements — no new
machinery:

- **Off the main thread**: a synchronous `#[tauri::command]` runs on the
  dispatch/main thread; `async` commands and
  `tauri::async_runtime::spawn_blocking` move work off it
  (sources: https://github.com/tauri-apps/tauri/issues/4996 ,
  https://docs.rs/tauri/latest/src/tauri/async_runtime.rs.html). The
  codebase already follows this: `content_search` runs its walk in
  `spawn_blocking` and streams results over `tauri::ipc::Channel`
  (`commands/search.rs`).
- **Incremental work**: the watcher already debounces 300 ms and suppresses
  self-writes (`watcher.rs`); a graph indexer subscribes to the same
  invalidation points (`index_written_file`, watcher events) and re-embeds
  only changed files, keyed by content hash or mtime.
- **Cancellation/staleness**: `workspace_epoch` + `cancel_index` /
  `cancel_search` flag slots (`state.rs`) are exactly the discipline a
  long-lived AI indexer needs — flip the flag on workspace switch, check it
  per file, drop stale results via `with_workspace_snapshot`.
- **IPC to the frontend**: emit `graph:updated`-style events (the
  `fs:file-changed` precedent needs a `workspace` field; a per-call
  `Channel` suits a "reindex now" command).

The webview does **nothing** while indexing: all HTTP and similarity math
runs Rust-side. Frontend cost appears only when the graph view is open.

## R5. Graph rendering: canvas force layout is enough; WebGL is the scale option

Obsidian's graph is a force-directed layout on the link graph. Options:

- `react-force-graph-2d` (react-force-graph): canvas 2D renderer,
  d3-force-3d physics, zoom/pan/hover/drag built in. Comfortable to ~a few
  thousand nodes; documented degradation past ~10k nodes / ~80k edges
  (panning lags even with the sim halted).
  Sources: https://github.com/vasturiano/react-force-graph ,
  https://github.com/vasturiano/react-force-graph/issues/483 ,
  https://github.com/vasturiano/react-force-graph/issues/181
- sigma.js + graphology: WebGL renderer, the scale ceiling (~tens of
  thousands of nodes) but a heavier integration and a different component
  model.
- d3-force alone: simulation only; bring your own renderer.

For a personal vault (hundreds to low thousands of notes)
`react-force-graph-2d` is the right size. The force simulation runs on the
webview main thread during layout; bounding it with `warmupTicks` +
`cooldownTicks`/`autoPauseRedraw` makes it finite work, not a perpetual
loop. If profiling ever shows jank, the tick loop can move to a Web Worker
(worker posts positions back per frame) — standard d3-force pattern, but
unlikely to be needed at vault scale.

## R6. Storage: sidecar index, never the notes

Embeddings are ~256–1024 floats per note → a few MB of JSON for a large
vault, plus a map of suggested tags and the resolved link edges. Options:

- App data dir (`app_data_dir()/graph/<workspace-hash>.json`) — keeps the
  vault and any enclosing git repo pristine. Preferred default.
- `{workspace}/.writer/graph.json` — travels with the vault; `.writer/` is
  already the workspace config dir and watcher-allowlisted, but it writes
  app state into the user's notes folder.

The requester approved frontmatter writes **on explicit accept**: suggested
tags live in the index and render as suggestions; clicking one writes it
into the note's frontmatter `tags:` through the normal save path
(`record_write`, index update, watcher self-write suppression — the MCP
`write_file` precedent for routing writes). The AI still never rewrites a
note on its own; every mutation is a user-initiated accept.

Storage note specific to the requester's vault (`~/obsidian/SDU`): it is a
git repo, so the sidecar index belongs in the app data dir, not `.writer/`
— a `.writer/graph.json` would land in version control unless gitignored.

## R7. Performance budget

| Component                    | Where it runs           | Steady-state cost                                        |
| ---------------------------- | ----------------------- | -------------------------------------------------------- |
| File-content reads on change | Rust walker (existing)  | One file read per save                                   |
| Embedding HTTP call          | tokio task, off webview | ~50–300 ms wall-clock per changed note, sequential queue |
| Similarity (N² cosine)       | Rust                    | ~1.5 GFLOP for N=2000 @ 768-dim — milliseconds           |
| Graph render                 | webview, canvas         | Only while graph view is open                            |
| Tag suggestion (chat model)  | tokio task              | Seconds per note — must be opt-in/batched (R8)           |

Initial indexing is the only bulk cost; after that, incremental re-embeds on
save are invisible. Concurrency cap of 1–2 in-flight requests avoids
fighting the user's other uses of the same endpoint.

**Measured for the requester's vault** (`~/obsidian/SDU`): ~21 real notes
plus attachments — 188 MB total but almost all of it is images and
`.obsidian` plugin docs, not prose. At this scale every concern in this
table evaporates: the whole vault embeds in one batch call, N² similarity is
microseconds, and the graph could render in SVG, let alone canvas. The
interesting problems here are suggestion quality and the link/tag graph
shape, not scale.

## R8. Environmental / energy impact — honest numbers

"Impact" here means two things; both are small but not zero.

**App/system impact** — covered by R4/R7: inference happens in the external
server process; Writer's own cost is file reads plus JSON round-trips on a
background thread, and canvas rendering only while the graph is open.

**Energy footprint** — inference runs on the user's own hardware:

- Reference point: a typical GPT-4o chat query is ~0.3 Wh (Epoch AI;
  long-context queries can reach ~2.5 Wh at 10k-token inputs).
  Source: https://epoch.ai/gradient-updates/how-much-energy-does-chatgpt-use
- A local embedding call is far cheaper than a chat query: one forward pass
  through a ~100–300 MB model, no autoregressive loop. Marginal cost rule:
  Wh ≈ (load W − idle W) × hours. An embedding batch for a 1,000-note vault
  is on the order of minutes of ~10–30 W above idle — single-digit Wh total,
  once, then near zero steady-state (only changed notes re-embed).
- The expensive tier is chat-model tagging: ~seconds of generation per note.
  An 8B-class model on Apple Silicon draws roughly tens of watts above idle;
  tagging a 1,000-note vault is a one-off cost comparable to a few minutes
  of video playback, then per-save marginal cost.

**Mitigations that keep it negligible**: embeddings-only default; tag
suggestions on-demand or idle-scheduled with a daily cap; batch `input`
arrays where supported; let the model unload between bursts (Ollama
`keep_alive`/default unload). Local inference also avoids datacenter
overhead (PUE, cooling, networking) per query — but the honest framing is
that the total is small either way at this workload size; the real
environmental lever is the model the user chooses to keep loaded.

## R9. Quality caveats to design around

- **Math notes embed badly.** General text embedders underperform on
  LaTeX-dense content (`\frac{...}` is noise to them). Mitigation: embed a
  text projection — title, headings, prose, tag lines — not raw source. For
  formula-only notes, similarity will be weak; that's inherent, not a bug.
- **Small chat models produce noisy tags.** Structured output fixes the
  _format_, not the judgment; a 1–3 B model yields inconsistent
  vocabularies. Suggestion UX (accept/dismiss) rather than auto-apply is
  the right posture — which also matches the no-rewrite requirement.
- **Similarity thresholding.** Too low = hairball; too high = sparse. The
  pragmatic rule is top-k neighbors per node (k≈3–5) AND a floor
  threshold, tuned interactively — same approach Smart Connections takes
  with its score display.

## R10. Privacy/consent precedent applies

This feature sends note _content_ to a user-configured endpoint — the first
feature to move document text off the app. The requester's primary is
already remote (Tailscale host, plain HTTP — WireGuard encrypts the wire,
but it is not localhost). The existing precedent is the `Privacy` settings
category (`telemetry.enabled`, `mcp.enabled`, both default-off). Same
posture: `ai.*` settings default off, and the settings copy should say
plainly that note contents are sent to the configured endpoint — wherever
that URL points.

Settings shape (all global scope): `ai.enabled`, `ai.chat-endpoint`,
`ai.chat-model`, `ai.chat-api-key`, `ai.chat-fallback-endpoint` (+ its key),
`ai.embed-endpoint`, `ai.embed-model`. API keys live in the global `config`
file in the app data dir — never in the repo, the vault, or `.writer/`.

## R11. Alternative that works today: the MCP server

Writer already ships an MCP server (`docs/mcp-server.md`,
`SPECs/writer-mcp-server`): an external agent (Claude Code, Codex, a script)
can `list_files`/`read_file`/`search_files` a workspace and could compute
embeddings or tag suggestions externally, writing results to a file Writer
reads. Worth noting because it costs zero new code — but it doesn't deliver
the integrated, always-on background graph the request asks for, and write
tools route through the UI save path. The in-app indexer is the right
long-term shape; MCP remains a useful escape hatch.

## Recommended shape (for a future spec, not yet approved)

1. `ai.enabled` + endpoint/model settings under Privacy; default off.
2. Rust `graph` module: link-edge extraction in the existing index walk;
   sidecar embedding store in app data dir; background queue fed by watcher
   - `index_written_file`; `spawn_blocking`/tokio, epoch- and
     cancel-flag-guarded.
3. `similar` edges: top-k cosine over embeddings, stored in the same index.
4. Chat-model tag suggestions: separate queue, opt-in, JSON-schema output,
   stored as suggestions only.
5. Graph view: new tab type (drawings/PDFs already set that precedent),
   `react-force-graph-2d`, warmup-bounded layout, distinct styling for
   link vs. semantic edges, click-to-open note via `navigateToFile`.
6. Note-context panel or palette command: "Related notes" + suggested tags
   for the current file.

## Open questions — resolved 2026-09-22

1. ~~Which server~~ → Chat: **vLLM** at `http://100.127.4.22:8000/v1`
   (`qwen3-8b`), fallback **MTPLX** local `http://127.0.0.1:8000/v1`.
   Embeddings: **TEI** at `http://100.127.4.22:8080`
   (`Qwen/Qwen3-Embedding-0.6B`). All verified live (R1).
2. ~~Embeddings?~~ → Serving now on TEI; also available later on local MTPLX
   via `--embedding-model` as a fallback tier.
3. ~~Frontmatter writes?~~ → Approved **on explicit accept** (see R6).
4. ~~Vault size~~ → `~/obsidian/SDU`, ~21 notes. Tiny; canvas or even SVG
   rendering, single-batch embedding.

Remaining (non-blocking): the local MTPLX instance currently answers 401 —
the fallback path needs its API key in `ai.chat-fallback-*` settings when
the user wants fallback to actually work.
