import { withDrawingSaveBoundary, hasDrawingSession } from "@/lib/drawing-sessions";
import { create } from "zustand";
import type { DirEntry } from "@/types/fs";
import type { RestoreWorkspaceResponse } from "@/lib/tauri";
import * as tauri from "@/lib/tauri";
import { getPreference, setPreference } from "@/lib/preferences";
import {
  classifyRecord,
  createSessionPersister,
  decodeSession,
  encodeSession,
  loadSession,
  saveSession,
  type SessionRecord,
} from "@/lib/session";
import { createTabId, useEditorStore } from "@/stores/editor-store";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import type { FileContent } from "@/types/fs";

export type WorkspaceChromeMode = "workspace" | "compact-file";

interface WorkspaceState {
  root: string | null;
  workspaceEpoch: number | null;
  workspaceGeneration: number;
  chromeMode: WorkspaceChromeMode;
  fileCount: number;
  isIndexing: boolean;
  isStartupResolved: boolean;
  directoryCache: Map<string, DirEntry[]>;
  expandedDirs: Set<string>;
  pinnedFiles: string[];
  sidebarMetadataVersion: number;
  recentWorkspaces: string[];

  openWorkspace: (path: string) => Promise<void>;
  /** Hydrate from a prefetched `RestoreWorkspaceResponse` (startup cold-path
   *  and user-initiated switches via the `restore_workspace` IPC). */
  restoreFromBundle: (bundle: RestoreWorkspaceResponse) => Promise<void>;
  closeWorkspace: () => Promise<void>;
  setChromeMode: (mode: WorkspaceChromeMode) => void;
  setStartupResolved: () => void;
  refreshDirectory: (path: string) => Promise<void>;
  toggleDirectory: (path: string) => Promise<void>;
  invalidatePath: (path: string) => void;
  rewriteExpandedDir: (oldPath: string, newPath: string) => void;
  hydratePinnedFiles: (root: string) => Promise<void>;
  togglePinnedFile: (path: string) => void;
  removePinnedFile: (path: string) => void;
  removePinnedFilesWithPrefix: (prefix: string) => void;
  rewritePinnedPath: (oldPath: string, newPath: string) => void;
  bumpSidebarMetadataVersion: () => void;
  removeRecentWorkspace: (path: string) => Promise<void>;
}

function pinnedFilesPreferenceKey(root: string) {
  return `workspace:${root}:sidebar-pinned-files`;
}

function normalizePinnedFiles(root: string, paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  const rootPrefix = `${root}/`;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string") continue;
    if (!path.startsWith(rootPrefix)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

async function loadPinnedFiles(root: string) {
  const paths = await getPreference<unknown>(pinnedFilesPreferenceKey(root), []);
  return normalizePinnedFiles(root, paths);
}

function persistPinnedFiles(root: string, paths: string[]) {
  void setPreference(pinnedFilesPreferenceKey(root), paths);
}

function withoutPath(paths: string[], path: string) {
  return paths.filter((candidate) => candidate !== path);
}

function dedupe(paths: string[]) {
  return [...new Set(paths)];
}

function withNextWorkspaceGeneration(
  state: WorkspaceState,
  next: Partial<WorkspaceState>,
): Partial<WorkspaceState> {
  return { ...next, workspaceGeneration: state.workspaceGeneration + 1 };
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  root: null,
  workspaceEpoch: null,
  workspaceGeneration: 0,
  chromeMode: "workspace",
  fileCount: 0,
  isIndexing: false,
  isStartupResolved: false,
  directoryCache: new Map(),
  expandedDirs: new Set(),
  pinnedFiles: [],
  sidebarMetadataVersion: 0,
  recentWorkspaces: [],

  openWorkspace: async (path: string) => {
    // Multi-window: when this window already has a workspace, open the new
    // one in a fresh in-process window instead of replacing the current
    // workspace. Each window has its own `WorkspaceState` on the Rust side
    // so file watchers, search indexes, and session state stay isolated.
    const prevRoot = get().root;
    if (prevRoot && prevRoot !== path) {
      await tauri.openWorkspaceInNewWindow(path);
      return;
    }
    if (prevRoot === path) {
      return;
    }

    if (hasDrawingSession()) await withDrawingSaveBoundary(() => {});

    // Clear editor state before switching. Nothing queued for the previous
    // (empty) window may land under the new root.
    sessionPersister.cancel();
    useEditorStore.getState().resetEditorState();

    const info = await tauri.openWorkspace(path);
    // Read the directory and load the session under the canonical root that
    // Rust returned, not the raw input. Otherwise watcher events (which fire
    // canonical paths) miss the cache key and the sidebar goes stale on
    // aliased workspaces (e.g. `/var/...` → `/private/var/...`).
    const [entries, recents] = await Promise.all([
      tauri.readDirectory(info.root),
      tauri.getRecentWorkspaces(),
    ]);
    set((state) =>
      withNextWorkspaceGeneration(state, {
        root: info.root,
        workspaceEpoch: info.epoch,
        chromeMode: "workspace",
        fileCount: info.file_count,
        isIndexing: true,
        directoryCache: new Map([[info.root, entries]]),
        expandedDirs: new Set(),
        pinnedFiles: [],
        sidebarMetadataVersion: 0,
        recentWorkspaces: recents,
      }),
    );
    void get().hydratePinnedFiles(info.root);

    const record = await loadSession(info.root);
    // The read raced a later switch: this workspace is no longer the one
    // being shown, so its session must not land in the current layout.
    if (get().root !== info.root) return;
    await applySessionRecord(info.root, record, null, { background: false });
  },

  closeWorkspace: async () => {
    const root = get().root;
    if (!root) return;
    // Flush the snapshot as it stands now; it must be on disk before the
    // state it describes is cleared.
    scheduleSessionSave(root);
    const flushed = sessionPersister.flush();
    await withDrawingSaveBoundary(() => tauri.closeWorkspace(root));
    await flushed;
    if (get().root !== root) return;
    sessionPersister.cancel();
    useEditorStore.getState().resetEditorState();
    set((state) =>
      withNextWorkspaceGeneration(state, {
        root: null,
        workspaceEpoch: null,
        chromeMode: "workspace",
        fileCount: 0,
        directoryCache: new Map(),
        expandedDirs: new Set(),
        pinnedFiles: [],
        sidebarMetadataVersion: 0,
        isIndexing: false,
      }),
    );
  },

  restoreFromBundle: async (bundle) => {
    // Clear editor state in case anything was hydrated by a parallel hook.
    sessionPersister.cancel();
    useEditorStore.getState().resetEditorState();

    set((state) =>
      withNextWorkspaceGeneration(state, {
        root: bundle.workspace.root,
        workspaceEpoch: bundle.workspace.epoch,
        chromeMode: "workspace",
        fileCount: bundle.workspace.file_count,
        isIndexing: true,
        directoryCache: new Map([[bundle.workspace.root, bundle.entries]]),
        expandedDirs: new Set(),
        pinnedFiles: [],
        sidebarMetadataVersion: 0,
        recentWorkspaces: bundle.recent_workspaces,
      }),
    );
    void get().hydratePinnedFiles(bundle.workspace.root);

    const record = classifyRecord(bundle.session);
    if (record.status !== "missing") {
      await applySessionRecord(bundle.workspace.root, record, bundle.active_file, {
        background: true,
      });
      return;
    }

    if (bundle.open_file) {
      // Workspace+file open (open_workspace_in_new_window with a file):
      // the requested file becomes a normal tab in workspace chrome.
      void useEditorStore.getState().openFile(bundle.open_file);
      return;
    }

    useEditorStore.getState().ensureLauncherTab();
  },

  setChromeMode: (mode) => set({ chromeMode: mode }),

  setStartupResolved: () => set({ isStartupResolved: true }),

  refreshDirectory: async (path: string) => {
    const { root, workspaceGeneration } = get();
    const entries = await tauri.readDirectory(path);
    set((state) => {
      if (state.root !== root || state.workspaceGeneration !== workspaceGeneration) return state;
      const cache = new Map(state.directoryCache);
      cache.set(path, entries);
      return { directoryCache: cache };
    });
  },

  toggleDirectory: async (path: string) => {
    const { root, workspaceGeneration, expandedDirs, directoryCache } = get();
    const newExpanded = new Set(expandedDirs);

    if (newExpanded.has(path)) {
      newExpanded.delete(path);
      set({ expandedDirs: newExpanded });
    } else {
      newExpanded.add(path);
      if (!directoryCache.has(path)) {
        const entries = await tauri.readDirectory(path);
        set((state) => {
          if (state.root !== root || state.workspaceGeneration !== workspaceGeneration)
            return state;
          const cache = new Map(state.directoryCache);
          cache.set(path, entries);
          return { directoryCache: cache, expandedDirs: newExpanded };
        });
      } else {
        set({ expandedDirs: newExpanded });
      }
    }
  },

  invalidatePath: (path: string) => {
    set((state) => {
      const cache = new Map(state.directoryCache);
      cache.delete(path);
      return { directoryCache: cache };
    });
  },

  rewriteExpandedDir: (oldPath: string, newPath: string) => {
    set((state) => {
      const dirPrefix = `${oldPath}/`;
      const next = new Set<string>();
      let changed = false;

      for (const dir of state.expandedDirs) {
        if (dir === oldPath) {
          next.add(newPath);
          changed = true;
        } else if (dir.startsWith(dirPrefix)) {
          next.add(newPath + dir.slice(oldPath.length));
          changed = true;
        } else {
          next.add(dir);
        }
      }

      if (!changed) return state;

      // Also rekey directory cache entries under the old prefix
      const cache = new Map<string, DirEntry[]>();
      for (const [key, entries] of state.directoryCache) {
        if (key === oldPath) {
          cache.set(newPath, entries);
        } else if (key.startsWith(dirPrefix)) {
          cache.set(newPath + key.slice(oldPath.length), entries);
        } else {
          cache.set(key, entries);
        }
      }

      return { expandedDirs: next, directoryCache: cache };
    });
  },

  hydratePinnedFiles: async (root: string) => {
    const pinnedFiles = await loadPinnedFiles(root);
    if (get().root !== root) return;
    set({ pinnedFiles });
  },

  togglePinnedFile: (path: string) => {
    const root = get().root;
    if (!root || !path.startsWith(`${root}/`)) return;

    let next: string[] = [];
    set((state) => {
      next = state.pinnedFiles.includes(path)
        ? withoutPath(state.pinnedFiles, path)
        : [path, ...state.pinnedFiles];
      return { pinnedFiles: next };
    });
    persistPinnedFiles(root, next);
  },

  removePinnedFile: (path: string) => {
    const root = get().root;
    if (!root) return;

    let next: string[] | null = null;
    set((state) => {
      if (!state.pinnedFiles.includes(path)) return state;
      const updated = withoutPath(state.pinnedFiles, path);
      next = updated;
      return { pinnedFiles: updated };
    });
    if (next) persistPinnedFiles(root, next);
  },

  removePinnedFilesWithPrefix: (prefix: string) => {
    const root = get().root;
    if (!root) return;

    const prefixWithSlash = `${prefix}/`;
    let next: string[] | null = null;
    set((state) => {
      const filtered = state.pinnedFiles.filter(
        (path) => path !== prefix && !path.startsWith(prefixWithSlash),
      );
      if (filtered.length === state.pinnedFiles.length) return state;
      next = filtered;
      return { pinnedFiles: filtered };
    });
    if (next) persistPinnedFiles(root, next);
  },

  rewritePinnedPath: (oldPath: string, newPath: string) => {
    const root = get().root;
    if (!root) return;

    const oldPrefix = `${oldPath}/`;
    let next: string[] | null = null;
    set((state) => {
      let changed = false;
      const rewritten = state.pinnedFiles.map((path) => {
        if (path === oldPath) {
          changed = true;
          return newPath;
        }
        if (path.startsWith(oldPrefix)) {
          changed = true;
          return newPath + path.slice(oldPath.length);
        }
        return path;
      });
      if (!changed) return state;
      const updated = dedupe(rewritten);
      next = updated;
      return { pinnedFiles: updated };
    });
    if (next) persistPinnedFiles(root, next);
  },

  bumpSidebarMetadataVersion: () => {
    set((state) => ({ sidebarMetadataVersion: state.sidebarMetadataVersion + 1 }));
  },

  removeRecentWorkspace: async (path: string) => {
    await tauri.removeRecentWorkspace(path);
    set((state) => ({
      recentWorkspaces: state.recentWorkspaces.filter((p) => p !== path),
    }));
  },
}));

// Recent workspaces are hydrated by resolveStartup() via get_startup_state before the first render.

// --- session restore and persistence ----------------------------------------
//
// One writer per window, fed from the editor store's committed state. The
// editor store owns layout mutations; this boundary only observes what it
// published and writes it after the debounce (see contracts/session.md).

const sessionPersister = createSessionPersister(saveSession);

/**
 * A workspace whose stored record could not be read. Its record is left
 * exactly as it is until the user makes a real layout change in that
 * workspace: an empty snapshot (the launcher we fell back to) must not
 * overwrite what might still be recoverable by hand.
 */
let heldRoot: string | null = null;

function reportSessionDiagnostics(problems: string[], notice: string) {
  for (const problem of problems) console.warn(`[session] ${problem}`);
  showEditorNotice(notice);
}

/**
 * Apply a classified session record for `root`. `background` is the startup
 * path: the focused file is seeded synchronously from the bundle and the
 * rest loads without blocking startup.
 */
async function applySessionRecord(
  root: string,
  record: SessionRecord,
  prefetched: FileContent | null,
  { background }: { background: boolean },
) {
  const editor = useEditorStore.getState();
  if (record.status === "malformed") {
    heldRoot = root;
    reportSessionDiagnostics(
      record.problems,
      "The saved window layout for this workspace could not be read, so it was not restored. It is kept on disk until you change the layout.",
    );
    editor.ensureLauncherTab();
    return;
  }
  if (record.status === "missing") {
    editor.ensureLauncherTab();
    return;
  }

  const decoded = decodeSession(record.session, createTabId);
  if (decoded.pruned.length > 0) {
    reportSessionDiagnostics(
      decoded.pruned,
      `${decoded.pruned.length} saved tab${decoded.pruned.length === 1 ? "" : "s"} could not be restored by this version.`,
    );
  }
  const restore = editor.restoreSession(decoded, prefetched);
  if (!background) {
    await restore;
    return;
  }
  // Startup: `restoreSession` publishes the layout and the prefetched file
  // synchronously before it awaits background reads, so the window can show
  // the focused tab while the rest fills in.
  void restore.catch((error) => {
    console.error("Failed to load background tabs from restored session", error);
  });
}

/** Queue the current editor state for `root`, unless that workspace's record
 *  is held and the snapshot would erase it. */
function scheduleSessionSave(root: string) {
  const { tabs, layout } = useEditorStore.getState();
  const snapshot = encodeSession(tabs, layout);
  if (heldRoot === root) {
    if (!snapshot) return;
    // A deliberate, valid layout in this workspace replaces the bad record.
    heldRoot = null;
  }
  sessionPersister.schedule(root, snapshot);
}

useEditorStore.subscribe((state, prev) => {
  // Layout identity moves for every committed tree, focus, or ratio
  // change; tab identity for every navigation. Document edits touch
  // neither, so typing never serializes the layout.
  if (state.layout === prev.layout && state.tabs === prev.tabs) return;
  // No tabs at all is the transient state a reset leaves behind; a window
  // in use always has at least a launcher. Persisting it would erase the
  // record of the workspace being torn down.
  if (state.tabs.length === 0) return;
  // Standalone compact windows have no root, so they never persist a
  // session — the root check covers both cases.
  const root = useWorkspaceStore.getState().root;
  if (!root) return;
  scheduleSessionSave(root);
});

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    // Last best-effort flush; an asynchronous write here is not guaranteed
    // to finish, which is why explicit close flushes first.
    const root = useWorkspaceStore.getState().root;
    if (!root) return;
    scheduleSessionSave(root);
    void sessionPersister.flush();
  });
}
