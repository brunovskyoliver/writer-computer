# Quickstart: AI Note Relations + Graph View

Runtime validation against real endpoints. User config (global
`config` file, `app_data_dir()/config`):

```
ai.enabled = true
ai.chat-endpoint = http://100.127.4.22:8000/v1
ai.chat-model = qwen3-8b
ai.chat-api-key = <key>
ai.chat-fallback-endpoint = http://127.0.0.1:8000/v1
ai.chat-fallback-api-key = <key>
ai.embed-endpoint = http://100.127.4.22:8080
ai.embed-model = Qwen/Qwen3-Embedding-0.6B
```

The vault for the walkthrough is `~/obsidian/SDU` (~21 notes, math-heavy).

## 1. Disabled by default

1. Fresh install / `ai.enabled` unset → no `ai-graph/` dir appears in the
   app data dir, no requests hit the endpoints (watch endpoint logs or
   `tcpdump`), "Open Graph" is absent from the palette.

## 2. Index + graph

2. Enable `ai.enabled`, fill in the endpoint rows, open the vault →
   Settings → AI shows "chat reachable · embeddings reachable"; after a few
   seconds "N notes indexed · 0 pending".
3. Palette → **Open Graph** → a tab titled "Graph" opens with node per
   note; notes containing `[[…]]` links are joined by solid edges; similar
   notes (e.g. two calculus notes) are joined by accent-dashed edges.
4. Click a node → the note opens in a tab beside the graph.
5. Edit a note to add `[[Other Note]]`, save → within ~1–2 s a new link
   edge appears without reopening the graph.
6. In Finder, duplicate a note / delete one → the node appears/disappears.

## 3. Tag suggestions

7. Open a note → palette → **AI: Suggest Tags** → the suggestion card opens
   with ≤8 chips and a "Related notes" list.
8. Click one chip → the note's frontmatter gains/updates `tags:` (visible
   in the frontmatter panel); the file goes dirty → autosaves; the chip
   disappears from the pending list.
9. "Add all" → remaining tags merge in one write, deduped.
10. Click a related note → it opens.
11. Edit the note heavily and re-run suggest → new suggestions replace the
    stored ones; previously accepted tags in frontmatter are untouched.

## 4. Fallback + failure modes

12. Stop the primary chat endpoint, run **AI: Suggest Tags** → the fallback
    (local MTPLX) answers instead; no error shown.
13. Stop both → the card shows an explicit error; no partial write.
14. Clear `ai.embed-endpoint` → `ai:graph-changed` still fires on edits;
    the graph shows link edges only (similarity edges gone after rescan);
    Settings shows "embeddings unreachable".

## 5. Performance + privacy

15. While indexing runs, typing in an editor stays fluid (worker is off the
    webview thread) and CPU in Activity Monitor is idle except the endpoint
    process itself.
16. Disable `ai.enabled` → pending queue drops; no further requests
    (endpoint logs go quiet); graph tab still renders the last known index
    but nothing updates.

## Notes for the verifier

- The embedding endpoint is TEI: probe `POST {base}/embeddings` — no `/v1`.
- First `ai_status` probe may read "unreachable" if a cold endpoint needs a
  model load; Refresh re-probes.
- MTPLX serves chat only unless started with `--embedding-model`.
