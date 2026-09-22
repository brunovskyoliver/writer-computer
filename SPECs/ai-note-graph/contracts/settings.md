# Contract: Settings Entries

Eight new entries in `apps/desktop/shared/settings.schema.json`, all
`category: "AI"`, all `scope: "global"` (read via `get_global_or_default`,
set via `set_setting` scope `global`, persisted in the user's global
`config` file — API keys never ship in the repo).

| Key                         | Type    | Default | Label                  | Description                                                                                                                                                                                                                               |
| --------------------------- | ------- | ------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.enabled`                | boolean | `false` | AI Notes Index         | Send note contents to the configured endpoints to build the relation graph and suggest tags. Note text leaves the app toward whatever endpoints you set — including over the network if the endpoint is remote. Off until you turn it on. |
| `ai.chat-endpoint`          | string  | `""`    | Chat Endpoint          | OpenAI-compatible base URL for the chat model that suggests tags (e.g. http://127.0.0.1:8000/v1). Placeholder shows the example.                                                                                                          |
| `ai.chat-model`             | string  | `""`    | Chat Model             | Model id served by the chat endpoint (e.g. qwen3-8b).                                                                                                                                                                                     |
| `ai.chat-api-key`           | string  | `""`    | Chat API Key           | Bearer token for the chat endpoint; blank = unauthenticated local server.                                                                                                                                                                 |
| `ai.chat-fallback-endpoint` | string  | `""`    | Fallback Chat Endpoint | Second OpenAI-compatible base used when the primary is unreachable or errors (e.g. a local server).                                                                                                                                       |
| `ai.chat-fallback-api-key`  | string  | `""`    | Fallback API Key       | Bearer token for the fallback endpoint.                                                                                                                                                                                                   |
| `ai.embed-endpoint`         | string  | `""`    | Embeddings Endpoint    | Base URL whose `{base}/embeddings` route serves OpenAI-shaped responses (TEI, vLLM, MTPLX, Ollama). Powers similarity edges.                                                                                                              |
| `ai.embed-model`            | string  | `""`    | Embeddings Model       | Model id served by the embeddings endpoint (e.g. Qwen/Qwen3-Embedding-0.6B).                                                                                                                                                              |

## Settings panel

The `AI` category renders automatically from the schema. A
`SECTION_EXTRAS` entry (`components/settings-panel/ai-section.tsx`) renders
under it: the `ai_status` result as a status line ("chat reachable ·
embeddings reachable · N notes indexed · M pending"), with a Refresh
button. No custom controls beyond that — every value is schema-driven.

## Application points

- `with_global_settings_mut` calls `crate::ai::apply_settings` after the
  MCP apply — enable → `ScanAll` kick; disable → worker dropped.
- Hand-edits to the global `config` file reach the same code path through
  `start_global_config_watcher` → `reload_global_settings` →
  `with_global_settings_mut`.
- Workspace-scope writes to `ai.*` keys are impossible by construction:
  `scope: "global"` lands them in `global_only`.
