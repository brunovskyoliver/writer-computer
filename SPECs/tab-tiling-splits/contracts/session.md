# Session persistence contract

## Version 2

Keep the existing workspace-root key in `sessions.json`. The session value becomes:

```json
{
  "version": 2,
  "tabs": [
    {
      "id": "tab-1",
      "location": { "kind": "file", "path": "/vault/a.md" },
      "back": [],
      "forward": []
    },
    {
      "id": "tab-2",
      "location": { "kind": "file", "path": "/vault/b.md" },
      "back": [],
      "forward": []
    }
  ],
  "layout": {
    "root": {
      "kind": "split",
      "id": "split-1",
      "axis": "x",
      "ratio": 0.5,
      "children": [
        { "kind": "pane", "id": "pane-1", "tab_ids": ["tab-1"], "active_tab_id": "tab-1" },
        { "kind": "pane", "id": "pane-2", "tab_ids": ["tab-2"], "active_tab_id": "tab-2" }
      ]
    },
    "focused_pane_id": "pane-2"
  }
}
```

The wire shape uses snake_case; the TS codec maps runtime names once. IDs must remain collision-free after restore by adopting a UUID allocator or advancing the existing allocator. Persist split/pane/tab IDs, ratios, tab locations/history and active/focus IDs. Do not serialize live editor instances, text buffers, pending operations, drag state, or undo stacks. Per-view cursor/scroll restore across process restart is not required by FR-021; it must work during a live move.

Change `save_session` to accept one validated session payload (or null to remove an empty snapshot); update frontend wrappers and all callers together. `load_session` and the bundled workspace restore return the same versioned payload. Derive the prefetch path from the focused pane's active tab. No independent `active_index` mirror is written for v2.

## Legacy and recovery

An absent version/layout plus `{tabs, active_index}` is v1. Assign tab IDs before filtering, preserve the previously active tab's identity when it survives, wrap in one pane, then normalize. Preserve intentional duplicate-document tabs and each tab's history; restoration does not run drop deduplication. Do not clamp the old index against a filtered tab array and accidentally select a different file.

Use page-kind deserialization for locations/history. Missing files and unsupported page kinds are pruned with diagnostics; empty leaves collapse. If active tab disappears, choose the next surviving tab, then previous; if focus disappears, choose a surviving pane in tree order. If nothing remains, restore launcher and persist an empty/null snapshot through the owner.

Reject unsupported versions, cycles/duplicate IDs, unknown node tags/axes, invalid child count, nonfinite/out-of-range ratios, dangling/duplicate tab references, or invalid focus/active IDs as malformed layout. Do not silently treat malformed v2 as v1. Show a recovery notice and preserve the original record until a deliberate valid layout mutation replaces it. Missing session is normal; unreadable session is an error.

## Persistence ownership and concurrency

Replace the tab-only save trigger with committed layout/navigation changes, including ratio and focus changes. Schedule from the editor mutation owner after `set()` returns. The workspace/session boundary captures root and generation, debounces for the existing 500 ms, serializes writes within one window, and cancels stale callbacks on reset. Explicit close flushes the captured workspace snapshot before clearing state. Keep the existing close/unload hooks as a last best-effort flush; do not claim asynchronous unload alone guarantees persistence.

Rust retains `sessions_file_lock` across read/modify/write. Same-workspace snapshots remain last-writer-wins as today; runtime layouts never share state between windows. Preserve `workspace.restore-open-files` and skip standalone compact persistence.

TS and Rust consume one shared fixture directory containing valid v1/v2 and malformed cases; enforce identical accepted structure and focused-file extraction. This is the runtime assertion mechanism for mirrored wire declarations required by constitution III. Keep kind payloads routed through the existing extensible location contract.
