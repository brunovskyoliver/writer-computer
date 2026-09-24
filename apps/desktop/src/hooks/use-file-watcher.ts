import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { startLatexSnippetSubscriptions } from "@/stores/latex-snippet-store";
import * as editorApi from "./editor-api";
import * as tauri from "@/lib/tauri";
import { cancelSave, isSaveInFlight } from "@/lib/save";
import { useAiStore } from "@/stores/ai-store";
import { isWorkspaceEventCurrent, type WorkspaceIdentity } from "@/lib/workspace-events";
import { isDrawingPath } from "@/lib/drawings";
import { refreshDrawingEmbeds } from "@/lib/drawing-embed-sync";

interface FileChangePayload {
  path: string;
  kind: "modified" | "created" | "deleted" | "renamed";
  workspace: WorkspaceIdentity | null;
}

interface IndexCompletePayload {
  workspace: WorkspaceIdentity;
  fileCount: number;
}

const WATCHER_DEBUG = import.meta.env.DEV;

/**
 * Watcher bursts (a save storm, a git checkout, a build touching the tree)
 * arrive as dozens of events per second. Each one used to bump
 * `sidebarMetadataVersion` — refetching recents/pinned and re-flattening the
 * tree — and fire its own directory IPC. Everything except the open-file
 * reload is flushed once per window instead: one metadata bump, one embed
 * refresh per drawing, one directory read per affected path.
 */
const WATCHER_FLUSH_MS = 150;

function currentWorkspaceIdentity(): WorkspaceIdentity | null {
  const { root, workspaceEpoch } = useWorkspaceStore.getState();
  return root !== null && workspaceEpoch !== null ? { root, epoch: workspaceEpoch } : null;
}

export function useFileWatcher() {
  useEffect(() => {
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let metadataDirty = false;
    const pendingDrawingPaths = new Set<string>();
    const pendingDirPaths = new Set<string>();
    const dirRefreshInFlight = new Set<string>();

    const pumpDirRefreshes = () => {
      const { root, expandedDirs, invalidatePath, refreshDirectory } = useWorkspaceStore.getState();
      // Each changed path also dirties its parent listing — dedupe through a
      // Set so a burst under one directory reads it once.
      const targets = new Set<string>();
      for (const path of pendingDirPaths) {
        targets.add(path);
        const parent = path.substring(0, path.lastIndexOf("/"));
        if (parent) targets.add(parent);
      }
      pendingDirPaths.clear();
      for (const target of targets) {
        // For visible directories (expanded or root), refresh in-place so the
        // old entries stay visible until new data arrives.  Calling
        // invalidatePath first would delete the cache, causing the tree to
        // flash empty while the async refresh is in flight.
        if (!expandedDirs.has(target) && target !== root) {
          invalidatePath(target);
          continue;
        }
        if (dirRefreshInFlight.has(target)) {
          // Still dirty — the in-flight read may predate this event, so run
          // once more after it lands (its `finally` re-pumps).
          pendingDirPaths.add(target);
          continue;
        }
        dirRefreshInFlight.add(target);
        void refreshDirectory(target)
          .catch(() => {})
          .finally(() => {
            dirRefreshInFlight.delete(target);
            if (pendingDirPaths.has(target)) pumpDirRefreshes();
          });
      }
    };

    const scheduleFlush = () => {
      if (flushTimer !== null) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (metadataDirty) {
          metadataDirty = false;
          useWorkspaceStore.getState().bumpSidebarMetadataVersion();
        }
        for (const path of pendingDrawingPaths) refreshDrawingEmbeds(path);
        pendingDrawingPaths.clear();
        pumpDirRefreshes();
      }, WATCHER_FLUSH_MS);
    };

    const unlistenFile = listen<FileChangePayload>("fs:file-changed", (event) => {
      const { path, kind, workspace } = event.payload;
      if (!isWorkspaceEventCurrent(workspace, currentWorkspaceIdentity())) return;
      if (WATCHER_DEBUG) console.debug("[watcher] fs:file-changed", kind, path);
      metadataDirty = true;
      if (isDrawingPath(path)) {
        pendingDrawingPaths.add(path);
      }
      scheduleFlush();

      const openFiles = editorApi.getOpenFiles();
      const file = openFiles.get(path);

      if (!file) return;
      if (kind === "deleted") return;
      if (isSaveInFlight(path)) return;

      cancelSave(path);
      void tauri.readFile(path).then((content) => {
        const latest = editorApi.getOpenFiles().get(path);
        if (!latest || content.content === latest.diskContent) return;
        if (WATCHER_DEBUG) console.debug("[watcher] reload-from-disk", path);
        editorApi.reloadFromDisk(path, content.content);
      });
    });

    const unlistenIndexComplete = listen<IndexCompletePayload>("index:complete", (event) => {
      if (isWorkspaceEventCurrent(event.payload.workspace, currentWorkspaceIdentity())) {
        useWorkspaceStore.setState((state) => ({
          fileCount: event.payload.fileCount,
          isIndexing: false,
          sidebarMetadataVersion: state.sidebarMetadataVersion + 1,
        }));
      }
    });

    const unlistenSidebarMetadata = listen("sidebar:metadata-changed", () => {
      metadataDirty = true;
      scheduleFlush();
    });

    const unlistenSettings = listen<WorkspaceIdentity | null>("settings:changed", (event) => {
      if (!isWorkspaceEventCurrent(event.payload, currentWorkspaceIdentity())) return;
      void useSettingsStore.getState().loadSettings();
    });

    const unlistenDir = listen<FileChangePayload>("fs:directory-changed", (event) => {
      const { path, workspace } = event.payload;
      if (!isWorkspaceEventCurrent(workspace, currentWorkspaceIdentity())) return;
      if (WATCHER_DEBUG) console.debug("[watcher] fs:directory-changed", path);
      metadataDirty = true;
      pendingDirPaths.add(path);
      scheduleFlush();
    });

    // AI worker committed a batch → bump the graph version; mounted graph
    // panes refetch `ai_graph`.
    const unlistenGraphChanged = listen<WorkspaceIdentity>("ai:graph-changed", (event) => {
      if (!isWorkspaceEventCurrent(event.payload, currentWorkspaceIdentity())) return;
      useAiStore.getState().bumpGraphVersion();
    });

    // The snippet store owns its own file and settings subscriptions; this
    // hook only decides how long they live.
    const stopSnippetSubscriptions = startLatexSnippetSubscriptions();

    return () => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      stopSnippetSubscriptions();
      void unlistenFile.then((fn) => fn());
      void unlistenIndexComplete.then((fn) => fn());
      void unlistenSidebarMetadata.then((fn) => fn());
      void unlistenSettings.then((fn) => fn());
      void unlistenDir.then((fn) => fn());
      void unlistenGraphChanged.then((fn) => fn());
    };
  }, []);
}
