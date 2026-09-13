# Research: Tab tiling and split panes

## Pane and tab ownership

**Decision:** Extend `editor-store.ts` with a binary layout tree and focused pane ID. Panes reference ordered tab IDs; the tab collection stays canonical. Derive a tab's owner from the tree instead of storing a second pane ID on the tab. Keep global active selectors as derived compatibility accessors.

**Rationale:** `use-tabs.ts` and store navigation currently assume one `activeTabId`. Atomic moves must update both panes, active tabs, and focus together. Binary splits satisfy the spec's two-or-more-child definition with less normalization logic.

**Alternatives considered:** Independent pane/tab stores require cross-store transactions. A complete docking framework brings persistence and drag assumptions that conflict with Writer's pointer events and existing sidebar behavior.

## Stable editor bodies

**Decision:** Render keep-alive tab bodies once under a stable host list keyed by tab ID. The resize tree renders pane chrome and body measurement slots. Position each visible tab host over its pane's measured body rectangle; inactive keep-alive tabs use `display: none`. Do not change portal targets or React parents when a tab moves. Body registration and ResizeObserver measurement belong in a co-located hook. Preserve logical focus order with tab order derived from pane traversal and explicit focus actions.

**Rationale:** `editor-area/index.tsx` currently preserves instances by tab keys. Recursive rendering would remount a moved tab even with the same key. Drawing cleanup can flush writes, so reconstructing a moved editor from document text is insufficient.

**Alternatives considered:** Snapshot/remount loses editor-only history and can save drawings. Imperatively reparenting React-owned nodes is fragile. Shared EditorState couples view selection.

## Shared Markdown buffer and independent history

**Decision:** Keep `openFiles` and `lib/save.ts` as the path-owned document/save source. Use a tab-ID view registry with path membership. Pass document ChangeSets to sibling views synchronously, tagged as synchronization and excluded from their undo histories. Update the shared buffer and save scheduler once for the originating transaction. Selection-only transactions remain local; sibling selections map through changes without copying the source selection. Preserve scroll using the owning scroll container's anchor/snapshot support.

**Rationale:** Content, dirty state, and reload versions are already shared, but sibling typing does not currently reach another EditorView. `OpenFile.cursorPos`/`scrollPos` and `editor-api.ts`'s `Map<path, EditorView>` are incompatible with duplicates. Installed CodeMirror commands source maps existing undo events through changes excluded from history.

**Alternatives considered:** Whole-document replacement on each keypress destroys selection mapping and adds unnecessary work. A CRDT is unnecessary for synchronous views in one JS window. A shared EditorState would share selection and extension state.

**Policy:** Undo remains local to edits made in that tab, mapped through sibling edits. This is a design choice because the spec only mandates navigation history. Disk reload resets/maps histories through the existing reload boundary once per document. Frontmatter changes remain document-owned. All document mutation entry points must synchronize views, including programmatic inserts, reload, and drawing-related note insertion.

## Drawing documents

**Decision:** Consolidate the existing drawing scene, asset files, revisions, export queue, and dirty/error state into one per-path drawing session. Preserve the save triggers provided by the current drawing workflow; do not introduce autosave timers as part of tiling. Each tab attaches an Excalidraw API instance and keeps its own viewport/selection state. Broadcast scene changes through `updateScene` with `CaptureUpdateAction.NEVER`, plus `addFiles` for assets, with an origin/revision guard; never echo imported sibling updates as edits. A scene owns one export/write queue and all instances receive the same save/reload result. Moving tabs leaves registrations intact.

**Rationale:** During planning, concurrent drawing work introduced `lib/drawing-sessions.ts` and explicit save/shutdown boundaries. It still creates a session per mounted editor and registers a set of saves per path, so it does not yet share a scene or a writer between duplicate views. Extend that module instead of building a second owner. Unregister still saves, so tab remounts remain unsafe. Installed Excalidraw declarations document `CaptureUpdateAction.NEVER` for remote updates; keep native per-view history and validate alternating edits/undo.

**Alternatives considered:** Excluding drawings would break the spec's generic file/tab gestures and existing drawing routes. Two independent exports per path cannot provide a shared dirty/save state.

## Resize library and geometry

**Decision:** Use the workspace's existing `react-resizable-panels` ^4.7.4 catalog entry. Add it to the desktop dependency list during implementation. Use v4 `Group`, `Panel`, `Separator`, ID-keyed layout percentages, and pixel minimums. The adapter maps `axis: x` to library `orientation: horizontal`, producing the spec's vertical divider; `axis: y` maps to `vertical`. Persist the final layout from the completed resize callback, while the library handles continuous pointer updates.

**Rationale:** No resize library is currently imported by desktop. The published v4 API supports minimum sizes and completed-layout callbacks; this avoids writing a new separator interaction implementation. Keep local-storage persistence helpers unused. See the [published 4.7.4 declarations](https://unpkg.com/react-resizable-panels@4.7.4/dist/react-resizable-panels.d.ts).

**Alternatives considered:** Hand-written resize handles duplicate library functionality. Older `PanelGroup` examples describe a different API.

**Defaults:** Pane minimum 240 CSS px wide by 160 CSS px tall, including pane chrome; separator 4 CSS px. These are implementation constants, subject to human visual review. Compute subtree minima recursively. Use an outer scroll container when existing layout minima exceed the viewport; reject a new split unless both final subtrees fit the target's available allocation. Start new child allocations equally after subtracting the separator.

## Pointer drag and preview

**Decision:** One window-local coordinator owns pointer capture, activation threshold, source snapshot, resolved target, overlay, and cleanup. The sidebar adapter supplies selected file paths; its existing move operation remains the only disk-move path. The tab adapter supplies a stable tab ID. Resolve candidate layout and bounds with pure functions; commit on pointerup only after validation. Escape, pointercancel, lost capture, blur, workspace change, and outside-window release cancel.

**Rationale:** The current sidebar drag uses pointer events but routes pointercancel through release and can autoscroll based only on Y. Extraction must correct these paths. Tab strip window-drag behavior must exclude tabs at pointerdown, before the drag activation threshold.

**Alternatives considered:** Independent sidebar/editor listeners can both commit one release. HTML5 drag is unavailable under the existing Tauri OS drag-drop configuration. Previewing half of the old pane can be wrong after source collapse.

## Session compatibility and failures

**Decision:** Add a version-2 session layout containing stable node/tab IDs, pane order/active tabs, focus, split ratios, and the existing serialized tab locations/history. Read old flat sessions as one pane. Update both standalone `load_session` and bundled `restore_workspace` paths, including `active_session_path` prefetch. Validate the wire boundary with shared valid/invalid JSON fixtures exercised by TS and Rust.

**Rationale:** `lib/session.ts`, `workspace-store.ts`, `lib/tauri.ts`, and Rust `commands/workspace.rs` all currently assume flat tabs. The serializer must prune transient launcher entries and normalize the resulting tree once. Existing restore removes failed file paths; new normalization also removes empty leaves and collapses splits. Route the existing window-level file watcher through document-kind adapters so drawings receive the same single reload/conflict decision as Markdown; do not install watchers per view.

**Alternatives considered:** Frontend-only storage bypasses current persistence and startup behavior. Maintaining an independent legacy flat mirror creates another source of truth. Separate window IDs in persisted keys expand scope beyond existing workspace sessions.

**Correction to spec context:** Rust `save_session` already holds `sessions_file_lock`; preserve it. The broad filesystem race described in the spec has already been fixed. Report malformed layout/version and I/O errors instead of copying the current silent catch behavior into the new path. Missing-file pruning is an expected, reported recovery; preserve a malformed saved record until the user makes a new valid layout change.
