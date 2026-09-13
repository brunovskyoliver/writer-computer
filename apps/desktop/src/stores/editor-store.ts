import {
  hasDrawingSession,
  withDrawingSaveBoundary,
  discardDrawingSessions,
  reportDrawingSaveError,
} from "@/lib/drawing-sessions";
import { clearTabViewState, rewriteEditorPaths } from "@/lib/editor-views";
import { create } from "zustand";
import type { FileContent } from "@/types/fs";
import * as tauri from "@/lib/tauri";
import {
  getFrontmatterDisplayDate,
  inferTitle,
  parseDocument,
  type TitleSource,
} from "@/lib/frontmatter";
import { getDocumentStats, type DocumentStats } from "@/lib/document-stats";
import { isDrawingPath } from "@/lib/drawings";
import { cancelSave, scheduleSave, registerSaveStore } from "@/lib/save";
import {
  activateTab as activateTabInLayout,
  createLayout,
  findPane,
  focusedTabId,
  insertTab,
  layoutTabIds,
  normalizeLayout,
  removeTab as removeTabFromLayout,
  removeTabs as removeTabsFromLayout,
  setFocusedPane as focusPaneInLayout,
  type Layout,
} from "@/lib/editor-layout";
import {
  locationBehavior,
  serializeLocation,
  deserializeLocation,
  type Location,
  type SerializedLocation,
} from "@/components/editor-area/page-kinds";

export interface OpenFile {
  path: string;
  frontmatter: string | null;
  content: string;
  title: string;
  titleSource: TitleSource;
  diskContent: string;
  isDirty: boolean;
  isLoading: boolean;
  saveError: string | null;
  reloadVersion: number;
  displayDate: string | null;
  stats: DocumentStats;
}

export interface Tab {
  id: string;
  location: Location;
  back: Location[];
  forward: Location[];
}

export type { Location, FileLocation } from "@/components/editor-area/page-kinds";

export interface SessionTab {
  location: SerializedLocation;
  back: SerializedLocation[];
  forward: SerializedLocation[];
}

interface EditorState {
  openFiles: Map<string, OpenFile>;
  /** Every open tab, ordered by pane traversal. `layout` decides which pane
   *  owns each one; this is just the canonical collection keyed by id. */
  tabs: Tab[];
  /** The one writable layout tree for this window. */
  layout: Layout;
  /** Derived from the focused pane — read freely, never assign. */
  activeTabId: string | null;
  /** Derived from the focused pane's active tab — read freely, never assign. */
  activeFilePath: string | null;

  openFile: (path: string) => Promise<void>;
  openCompactFile: (path: string, prefetched?: FileContent | null) => Promise<void>;
  openFileInNewTab: (path: string) => Promise<void>;
  openNewTab: () => void;
  ensureLauncherTab: () => void;
  openOrFocus: (match: (tab: Tab) => boolean, factory: () => Tab) => void;
  replaceTabWithFile: (tabId: string, path: string) => Promise<void>;
  closeFile: (path: string) => void;
  closeTab: (tabId: string) => void;
  closeActiveTab: () => void;
  setActiveFile: (path: string) => void;
  setActiveTab: (tabId: string) => void;
  setFocusedPane: (paneId: string) => void;
  navigateToFile: (path: string) => Promise<void>;
  navigateBack: () => Promise<void>;
  navigateForward: () => Promise<void>;
  renameOpenFile: (oldPath: string, newPath: string) => void;
  removePathReferences: (path: string) => void;
  removePathsWithPrefix: (prefix: string) => void;
  rewritePathPrefix: (oldPrefix: string, newPrefix: string) => void;
  restoreSession: (
    tabs: SessionTab[],
    activeIndex: number | null,
    prefetchedActiveFile?: FileContent | null,
  ) => Promise<void>;
  updateContent: (path: string, content: string) => void;
  updateFrontmatter: (path: string, frontmatter: string | null) => void;
  markSaved: (path: string, diskContent: string, hasNewerChanges?: boolean) => void;
  setSaveError: (path: string, error: string | null) => void;
  reloadFromDisk: (path: string, rawContent: string) => void;
}

type EditorStateSetter = (
  partial:
    | EditorState
    | Partial<EditorState>
    | ((state: EditorState) => EditorState | Partial<EditorState>),
  replace?: boolean,
) => void;

const pendingLoads = new Map<string, Promise<void>>();
const pendingNavigationVersionByTabId = new Map<string, number>();

// How long openFile waits for a fresh file to finish loading before falling
// back to creating the tab with a "Loading..." placeholder. Below ~100 ms is
// imperceptible, so fast disk reads never flash the spinner.
const OPEN_FILE_GRACE_MS = 40;

let tabSequence = 0;

function createTabId() {
  tabSequence += 1;
  return `tab-${tabSequence}`;
}

export function createLauncherTab(id = createTabId()): Tab {
  return { id, location: { kind: "launcher" }, back: [], forward: [] };
}

/**
 * The single constructor of a tab location from a filesystem path. Every site
 * that turns a path into a location goes through here, so deciding *which*
 * kind of tab a path opens in is a one-line change in one file rather than a
 * branch repeated at every call site (see SPECs/excalidraw-embed/plan.md).
 *
 * Drawings (`.excalidraw.svg`) dispatch to a `drawing` location; everything
 * else is a `file`.
 */
export function locationForPath(path: string): Location {
  return isDrawingPath(path) ? { kind: "drawing", path } : { kind: "file", path };
}

export function createFileTab(path: string, id = createTabId()): Tab {
  return { id, location: locationForPath(path), back: [], forward: [] };
}

export function createSettingsTab(id = createTabId()): Tab {
  return { id, location: { kind: "settings" }, back: [], forward: [] };
}

const EMPTY_STATS: DocumentStats = { words: 0, characters: 0, paragraphs: 0 };

function createLoadingFile(path: string): OpenFile {
  return {
    path,
    frontmatter: null,
    content: "",
    title: "",
    titleSource: "none",
    diskContent: "",
    isDirty: false,
    isLoading: true,
    saveError: null,
    reloadVersion: 0,
    displayDate: null,
    stats: EMPTY_STATS,
  };
}

function withDerivedDate<T extends { frontmatter: string | null }>(file: T) {
  return { ...file, displayDate: getFrontmatterDisplayDate(file.frontmatter) };
}

// Word/character/paragraph counts are display-only (status bar) and cost a
// full-document pass, so edits refresh them on a trailing timer instead of
// synchronously on every keystroke. Loads and reloads still derive them
// eagerly via `withDerived`.
const STATS_REFRESH_MS = 150;
const statsRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleStatsRefresh(path: string, set: EditorStateSetter) {
  const pending = statsRefreshTimers.get(path);
  if (pending) clearTimeout(pending);
  statsRefreshTimers.set(
    path,
    setTimeout(() => {
      statsRefreshTimers.delete(path);
      set((state) => {
        const file = state.openFiles.get(path);
        if (!file) return state;
        const stats = getDocumentStats(file.content);
        const files = new Map(state.openFiles);
        files.set(path, { ...file, stats });
        return { openFiles: files };
      });
    }, STATS_REFRESH_MS),
  );
}

function withDerived<T extends { frontmatter: string | null; content: string }>(file: T) {
  return {
    ...file,
    displayDate: getFrontmatterDisplayDate(file.frontmatter),
    stats: getDocumentStats(file.content),
  };
}

function cloneTab(tab: Tab): Tab {
  return { ...tab, back: [...tab.back], forward: [...tab.forward] };
}

function locationPaths(location: Location): string[] {
  return locationBehavior(location).paths(location);
}

function locationPrimaryPath(location: Location): string | null {
  return locationBehavior(location).primaryPath(location);
}

function deriveActiveFilePath(tabs: Tab[], activeTabId: string | null): string | null {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  return activeTab ? locationPrimaryPath(activeTab.location) : null;
}

/**
 * The single exit from every tab or layout mutation.
 *
 * Orders `tabs` by pane traversal, drops any tab the layout no longer owns,
 * and re-derives the compatibility `activeTabId`/`activeFilePath` from the
 * focused pane. Routing every mutation through here is what makes a move that
 * empties a pane, collapses a split, and changes focus one atomic update — and
 * it means no call site gets to decide for itself what "active" means.
 */
function publish(
  tabs: Tab[],
  layout: Layout,
): Pick<EditorState, "tabs" | "layout" | "activeTabId" | "activeFilePath"> {
  const normalized = normalizeLayout(layout);
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ordered = layoutTabIds(normalized).flatMap((tabId) => {
    const tab = byId.get(tabId);
    return tab ? [tab] : [];
  });
  const activeTabId = focusedTabId(normalized);
  return {
    tabs: ordered,
    layout: normalized,
    activeTabId,
    activeFilePath: deriveActiveFilePath(ordered, activeTabId),
  };
}

/** Remove from the layout every tab that `nextTabs` no longer contains,
 *  collapsing whatever panes that empties. */
function dropMissingTabs(state: Pick<EditorState, "tabs" | "layout">, nextTabs: Tab[]) {
  const surviving = new Set(nextTabs.map((tab) => tab.id));
  const removed = state.tabs.filter((tab) => !surviving.has(tab.id)).map((tab) => tab.id);
  return removeTabsFromLayout(state.layout, removed);
}

/** Add a tab to `paneId` (default: the focused pane) and make it active. A
 *  pane captured before an await may be gone by now, so fall back to focus. */
function appendTab(
  state: Pick<EditorState, "tabs" | "layout">,
  tab: Tab,
  paneId: string = state.layout.focusedPaneId,
) {
  const target = findPane(state.layout, paneId) ? paneId : state.layout.focusedPaneId;
  return publish([...state.tabs, tab], insertTab(state.layout, target, tab.id));
}

function getTabIndex(tabs: Tab[], tabId: string) {
  return tabs.findIndex((tab) => tab.id === tabId);
}

function getActiveTab(state: Pick<EditorState, "tabs" | "activeTabId">) {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
}

function collectReferencedPaths(tabs: Tab[]) {
  const paths = new Set<string>();
  for (const tab of tabs) {
    for (const p of locationPaths(tab.location)) paths.add(p);
    for (const loc of tab.back) for (const p of locationPaths(loc)) paths.add(p);
    for (const loc of tab.forward) for (const p of locationPaths(loc)) paths.add(p);
  }
  return paths;
}

function maybePruneFiles(
  state: Pick<EditorState, "openFiles" | "tabs">,
  nextTabs: Tab[],
  candidatePaths: string[],
) {
  const referenced = collectReferencedPaths(nextTabs);
  let files: Map<string, OpenFile> | null = null;

  for (const path of candidatePaths) {
    if (referenced.has(path)) continue;
    const file = (files ?? state.openFiles).get(path);
    if (!file || file.isDirty) continue;
    cancelSave(path);
    if (!files) files = new Map(state.openFiles);
    files.delete(path);
  }

  return files;
}

function tabPaths(tab: Tab): string[] {
  const paths = new Set<string>();
  for (const p of locationPaths(tab.location)) paths.add(p);
  for (const loc of tab.back) for (const p of locationPaths(loc)) paths.add(p);
  for (const loc of tab.forward) for (const p of locationPaths(loc)) paths.add(p);
  return [...paths];
}

function startNavigation(tabId: string) {
  const nextVersion = (pendingNavigationVersionByTabId.get(tabId) ?? 0) + 1;
  pendingNavigationVersionByTabId.set(tabId, nextVersion);
  return nextVersion;
}

function isNavigationCurrent(tabId: string, version: number) {
  return pendingNavigationVersionByTabId.get(tabId) === version;
}

function rewriteLocation(location: Location, from: string, to: string): Location | null {
  return locationBehavior(location).rewritePath(location as never, from, to) as Location | null;
}

function removeFromLocation(location: Location, path: string): Location | null {
  return locationBehavior(location).removePath(location as never, path) as Location | null;
}

function applyRewriteToTab(tab: Tab, rewrite: (loc: Location) => Location | null): Tab | null {
  const newLocation = rewrite(tab.location);
  if (!newLocation) return null;
  const back = tab.back.map(rewrite).filter((l): l is Location => l !== null);
  const forward = tab.forward.map(rewrite).filter((l): l is Location => l !== null);
  return { ...tab, location: newLocation, back, forward };
}

async function ensureFileLoaded(path: string, set: EditorStateSetter, get: () => EditorState) {
  // A drawing is not markdown and `drawing-pane` owns its own I/O. Reading one
  // in here would park an SVG in `openFiles` with the save machinery attached,
  // and the next autosave would overwrite the drawing with its own text.
  // Guarding here rather than at the call sites covers all of them, including
  // session restore, and drops the optimistic placeholder the callers insert
  // before they await.
  if (isDrawingPath(path)) {
    set((state) => {
      if (!state.openFiles.has(path)) return state;
      const files = new Map(state.openFiles);
      files.delete(path);
      return { openFiles: files };
    });
    return;
  }

  const existing = get().openFiles.get(path);
  if (existing && !existing.isLoading) return;

  const pending = pendingLoads.get(path);
  if (pending) {
    await pending;
    return;
  }

  if (!existing) {
    set((state) => {
      if (state.openFiles.has(path)) return state;
      const files = new Map(state.openFiles);
      files.set(path, createLoadingFile(path));
      return { openFiles: files };
    });
  }

  const loadPromise = tauri
    .readFile(path)
    .then((raw) => {
      const parsed = parseDocument(raw.content);
      set((state) => {
        const file = state.openFiles.get(path);
        if (!file) return state;
        const files = new Map(state.openFiles);
        files.set(
          path,
          withDerived({
            ...file,
            path,
            frontmatter: parsed.frontmatter,
            content: parsed.body ?? "",
            title: parsed.title,
            titleSource: parsed.titleSource,
            diskContent: raw.content,
            isLoading: false,
          }),
        );
        return { openFiles: files };
      });
    })
    .catch((error) => {
      set((state) => {
        const file = state.openFiles.get(path);
        if (!file) return state;
        const files = new Map(state.openFiles);
        files.delete(path);
        return { openFiles: files };
      });
      throw error;
    })
    .finally(() => {
      pendingLoads.delete(path);
    });

  pendingLoads.set(path, loadPromise);
  await loadPromise;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  openFiles: new Map(),
  tabs: [],
  layout: createLayout(),
  activeTabId: null,
  activeFilePath: null,

  openFile: async (path: string) => {
    const state = get();
    const activeTab = getActiveTab(state);
    // Captured before any await: a slow read must land in the pane the user
    // opened from, not in whichever pane happens to be focused when it lands.
    const targetPaneId = state.layout.focusedPaneId;

    if (activeTab?.location.kind === "launcher") {
      await state.replaceTabWithFile(activeTab.id, path);
      return;
    }

    // Reuse the active file tab by navigating in-place. Drawings go the same
    // way whatever the active tab is: `navigateToFile` owns the rule that they
    // open in a tab of their own.
    if (activeTab?.location.kind === "file" || isDrawingPath(path)) {
      await state.navigateToFile(path);
      return;
    }

    // No tabs at all — create one.
    const loadPromise = ensureFileLoaded(path, set as EditorStateSetter, get);
    loadPromise.catch(() => {});

    const loadFailedBeforeGrace = await Promise.race([
      loadPromise.then(
        () => false,
        () => true,
      ),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), OPEN_FILE_GRACE_MS)),
    ]);
    if (loadFailedBeforeGrace) return;

    const nextTab = createFileTab(path);
    set((state) => {
      // The pane this open was aimed at can disappear while the read is in
      // flight — a workspace switch, a compact-window reset, a closed pane.
      // Drop the result rather than landing it in whichever pane happens to
      // be focused by now.
      if (findPane(state.layout, targetPaneId)) return appendTab(state, nextTab, targetPaneId);
      const files = maybePruneFiles(state, state.tabs, [path]);
      return files ? { openFiles: files } : state;
    });
    if (!get().tabs.some((tab) => tab.id === nextTab.id)) return;

    try {
      await loadPromise;
    } catch {
      get().closeTab(nextTab.id);
    }
  },

  openCompactFile: async (path: string, prefetched: FileContent | null = null) => {
    // Seed the prefetched content (standalone startup hands the file over
    // in the startup IPC) so the editor mounts loaded; `ensureFileLoaded`
    // then short-circuits on the non-loading entry.
    if (prefetched && prefetched.path === path) {
      const parsed = parseDocument(prefetched.content);
      set((state) => {
        const files = new Map(state.openFiles);
        files.set(
          path,
          withDerived({
            ...createLoadingFile(path),
            frontmatter: parsed.frontmatter,
            content: parsed.body ?? "",
            title: parsed.title,
            titleSource: parsed.titleSource,
            diskContent: prefetched.content,
            isLoading: false,
          }),
        );
        return { openFiles: files };
      });
    }

    const previousTabIds = get().tabs.map((tab) => tab.id);
    const loadPromise = ensureFileLoaded(path, set as EditorStateSetter, get);
    loadPromise.catch(() => {});

    const nextTab = createFileTab(path);
    set((state) => {
      const candidatePaths = [
        ...new Set(state.tabs.flatMap((tab) => tabPaths(tab).filter((p) => p !== path))),
      ];
      const filesWithTarget = state.openFiles.has(path)
        ? null
        : new Map(state.openFiles).set(path, createLoadingFile(path));
      const baseState = filesWithTarget ? { ...state, openFiles: filesWithTarget } : state;
      const tabs = [nextTab];
      const prunedFiles = maybePruneFiles(baseState, tabs, candidatePaths);
      // A compact window is single-view by definition: drop the whole tree.
      return {
        ...publish(tabs, createLayout([nextTab.id], nextTab.id, state.layout.revision + 1)),
        ...(prunedFiles
          ? { openFiles: prunedFiles }
          : filesWithTarget
            ? { openFiles: filesWithTarget }
            : {}),
      };
    });

    for (const tabId of previousTabIds) {
      pendingNavigationVersionByTabId.delete(tabId);
    }

    try {
      await loadPromise;
    } catch {
      get().closeTab(nextTab.id);
    }
  },

  // Always create a fresh tab for `path`, even if another tab already shows it.
  // Used by the sidebar context menu's "Open in new tab" action so it never
  // collapses into the existing tab the way `openFile` does.
  openFileInNewTab: async (path: string) => {
    const nextTab = createFileTab(path);

    set((state) => {
      const openFiles = state.openFiles.has(path)
        ? undefined
        : new Map(state.openFiles).set(path, createLoadingFile(path));
      return { ...appendTab(state, nextTab), ...(openFiles ? { openFiles } : {}) };
    });

    try {
      await ensureFileLoaded(path, set as EditorStateSetter, get);
    } catch {
      get().closeTab(nextTab.id);
      throw new Error(`Failed to open ${path}`);
    }
  },

  openNewTab: () => {
    const nextTab = createLauncherTab();
    set((state) => appendTab(state, nextTab));
  },

  ensureLauncherTab: () => {
    set((state) => {
      if (state.tabs.length > 0) return state;
      return appendTab(state, createLauncherTab());
    });
  },

  openOrFocus: (match, factory) => {
    const state = get();
    const existing = state.tabs.find(match);
    if (existing) {
      if (existing.id !== state.activeTabId) {
        state.setActiveTab(existing.id);
      }
      return;
    }
    const activeTab = getActiveTab(state);
    const nextTab = factory();
    set((currentState) => {
      if (activeTab?.location.kind === "launcher") {
        const index = getTabIndex(currentState.tabs, activeTab.id);
        if (index !== -1) {
          // Reusing the launcher's id leaves pane membership untouched.
          const tabs = [...currentState.tabs];
          tabs[index] = { ...nextTab, id: activeTab.id };
          return publish(tabs, activateTabInLayout(currentState.layout, activeTab.id));
        }
      }
      return appendTab(currentState, nextTab);
    });
  },

  replaceTabWithFile: async (tabId: string, path: string) => {
    const targetTab = get().tabs.find((tab) => tab.id === tabId);
    if (!targetTab || targetTab.location.kind !== "launcher") {
      await get().openFile(path);
      return;
    }

    const nextTab = createFileTab(path, tabId);
    const version = startNavigation(tabId);

    set((state) => {
      const index = getTabIndex(state.tabs, tabId);
      if (index === -1) return state;
      if (state.tabs[index]?.location.kind !== "launcher") return state;
      const tabs = [...state.tabs];
      tabs[index] = nextTab;
      const openFiles = state.openFiles.has(path)
        ? undefined
        : new Map(state.openFiles).set(path, createLoadingFile(path));
      // Same tab id, so the layout is unchanged; only the location moved.
      return { ...publish(tabs, state.layout), ...(openFiles ? { openFiles } : {}) };
    });

    try {
      await ensureFileLoaded(path, set as EditorStateSetter, get);
    } catch {
      if (!isNavigationCurrent(tabId, version)) return;

      set((state) => {
        const index = getTabIndex(state.tabs, tabId);
        if (index === -1) {
          const files = maybePruneFiles(state, state.tabs, [path]);
          return files ? { openFiles: files } : state;
        }

        const currentTab = state.tabs[index];
        const currentLocation = currentTab?.location;
        if (!currentLocation || currentLocation.kind !== "file" || currentLocation.path !== path) {
          const files = maybePruneFiles(state, state.tabs, [path]);
          return files ? { openFiles: files } : state;
        }

        const tabs = [...state.tabs];
        tabs[index] = targetTab;
        const files = maybePruneFiles(state, tabs, [path]);

        return { ...publish(tabs, state.layout), ...(files ? { openFiles: files } : {}) };
      });
    }
  },

  closeFile: (path: string) => {
    const { activeTabId, tabs } = get();
    const activeTab = activeTabId ? tabs.find((tab) => tab.id === activeTabId) : null;
    if (activeTab?.location.kind === "file" && activeTab.location.path === path) {
      get().closeTab(activeTab.id);
      return;
    }

    const targetTab = tabs.find(
      (tab) => tab.location.kind === "file" && tab.location.path === path,
    );
    if (targetTab) get().closeTab(targetTab.id);
  },

  closeTab: (tabId: string) => {
    const close = () => {
      set((state) => {
        const index = getTabIndex(state.tabs, tabId);
        if (index === -1) return state;

        const closedTab = state.tabs[index]!;
        let tabs = state.tabs.filter((tab) => tab.id !== tabId);
        // The layout picks the surviving neighbour inside the closed tab's own
        // pane and collapses that pane if it just emptied.
        let layout = removeTabFromLayout(state.layout, tabId);

        if (tabs.length === 0) {
          const launcherTab = createLauncherTab();
          tabs = [launcherTab];
          layout = insertTab(layout, layout.focusedPaneId, launcherTab.id);
        }

        const files = maybePruneFiles(state, tabs, tabPaths(closedTab));

        return { ...publish(tabs, layout), ...(files ? { openFiles: files } : {}) };
      });

      pendingNavigationVersionByTabId.delete(tabId);
      // A close ends the view; a move does not, and never reaches here.
      clearTabViewState(tabId);
    };
    const tab = get().tabs.find((candidate) => candidate.id === tabId);
    const path = tab?.location.kind === "drawing" ? tab.location.path : null;
    if (path && hasDrawingSession(path)) {
      void withDrawingSaveBoundary(close, path).catch(reportDrawingSaveError);
    } else {
      close();
    }
  },

  closeActiveTab: () => {
    const activeTabId = get().activeTabId;
    if (activeTabId) get().closeTab(activeTabId);
  },

  setActiveFile: (path: string) => {
    const tab = get().tabs.find(
      (candidate) => candidate.location.kind === "file" && candidate.location.path === path,
    );
    if (!tab) return;
    set((state) => publish(state.tabs, activateTabInLayout(state.layout, tab.id)));
  },

  setActiveTab: (tabId: string) => {
    const tab = get().tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    set((state) => publish(state.tabs, activateTabInLayout(state.layout, tabId)));
  },

  // Focus follows the pane, and the active file follows focus. Selecting a
  // pane is therefore the same kind of state change as selecting a tab.
  setFocusedPane: (paneId: string) => {
    set((state) => publish(state.tabs, focusPaneInLayout(state.layout, paneId)));
  },

  navigateToFile: async (path: string) => {
    const state = get();
    const activeTab = getActiveTab(state);
    if (activeTab?.location.kind === "launcher") {
      await state.replaceTabWithFile(activeTab.id, path);
      return;
    }

    // A drawing is a surface of its own, not a document you navigate to, so it
    // never takes over the tab it was opened from: the note stays in the tab
    // bar behind it. Every route into a drawing lands here — the sidebar and
    // the New Drawing command through `openFile`, a double-clicked inline
    // embed directly — so this is the one place the rule lives. A drawing
    // already open is focused rather than opened twice; `openFileInNewTab` is
    // still the explicit "give me a second copy" action.
    if (isDrawingPath(path)) {
      const existing = state.tabs.find(
        (tab) => tab.location.kind === "drawing" && tab.location.path === path,
      );
      if (existing) {
        get().setActiveTab(existing.id);
        return;
      }
      const drawingTab = createFileTab(path);
      set((currentState) => appendTab(currentState, drawingTab));
      return;
    }

    if (!activeTab) {
      await state.openFile(path);
      return;
    }
    if (activeTab.location.kind === "file" && activeTab.location.path === path) return;

    const previousTab = cloneTab(activeTab);
    const nextLocation: Location = locationForPath(path);
    const nextTab: Tab = {
      ...cloneTab(activeTab),
      location: nextLocation,
      back: [...activeTab.back, activeTab.location],
      forward: [],
    };

    const version = startNavigation(activeTab.id);

    set((currentState) => {
      const index = getTabIndex(currentState.tabs, activeTab.id);
      if (index === -1) return currentState;
      const tabs = [...currentState.tabs];
      tabs[index] = nextTab;
      const openFiles = currentState.openFiles.has(path)
        ? undefined
        : new Map(currentState.openFiles).set(path, createLoadingFile(path));
      return { ...publish(tabs, currentState.layout), ...(openFiles ? { openFiles } : {}) };
    });

    try {
      await ensureFileLoaded(path, set as EditorStateSetter, get);
    } catch {
      if (!isNavigationCurrent(activeTab.id, version)) return;

      set((currentState) => {
        const index = getTabIndex(currentState.tabs, activeTab.id);
        if (index === -1) return currentState;
        const tabs = [...currentState.tabs];
        tabs[index] = previousTab;
        const files = maybePruneFiles(currentState, tabs, [path]);
        return { ...publish(tabs, currentState.layout), ...(files ? { openFiles: files } : {}) };
      });
    }
  },

  navigateBack: async () => {
    const state = get();
    const activeTab = getActiveTab(state);
    if (!activeTab || activeTab.back.length === 0) return;

    const targetLocation = activeTab.back[activeTab.back.length - 1]!;
    const previousTab = cloneTab(activeTab);
    const nextTab: Tab = {
      ...cloneTab(activeTab),
      location: targetLocation,
      back: activeTab.back.slice(0, -1),
      forward: [activeTab.location, ...activeTab.forward],
    };
    const targetPath = locationPrimaryPath(targetLocation);
    const version = startNavigation(activeTab.id);

    set((currentState) => {
      const index = getTabIndex(currentState.tabs, activeTab.id);
      if (index === -1) return currentState;
      const tabs = [...currentState.tabs];
      tabs[index] = nextTab;
      return publish(tabs, currentState.layout);
    });

    if (!targetPath) return;

    try {
      await ensureFileLoaded(targetPath, set as EditorStateSetter, get);
    } catch {
      if (!isNavigationCurrent(activeTab.id, version)) return;

      set((currentState) => {
        const index = getTabIndex(currentState.tabs, activeTab.id);
        if (index === -1) return currentState;
        const tabs = [...currentState.tabs];
        tabs[index] = previousTab;
        const files = maybePruneFiles(currentState, tabs, [targetPath]);
        return { ...publish(tabs, currentState.layout), ...(files ? { openFiles: files } : {}) };
      });
    }
  },

  navigateForward: async () => {
    const state = get();
    const activeTab = getActiveTab(state);
    if (!activeTab || activeTab.forward.length === 0) return;

    const [targetLocation, ...remainingForward] = activeTab.forward;
    const previousTab = cloneTab(activeTab);
    const nextTab: Tab = {
      ...cloneTab(activeTab),
      location: targetLocation!,
      back: [...activeTab.back, activeTab.location],
      forward: remainingForward,
    };
    const targetPath = locationPrimaryPath(targetLocation!);
    const version = startNavigation(activeTab.id);

    set((currentState) => {
      const index = getTabIndex(currentState.tabs, activeTab.id);
      if (index === -1) return currentState;
      const tabs = [...currentState.tabs];
      tabs[index] = nextTab;
      return publish(tabs, currentState.layout);
    });

    if (!targetPath) return;

    try {
      await ensureFileLoaded(targetPath, set as EditorStateSetter, get);
    } catch {
      if (!isNavigationCurrent(activeTab.id, version)) return;

      set((currentState) => {
        const index = getTabIndex(currentState.tabs, activeTab.id);
        if (index === -1) return currentState;
        const tabs = [...currentState.tabs];
        tabs[index] = previousTab;
        const files = maybePruneFiles(currentState, tabs, [targetPath]);
        return { ...publish(tabs, currentState.layout), ...(files ? { openFiles: files } : {}) };
      });
    }
  },

  renameOpenFile: (oldPath: string, newPath: string) => {
    let shouldScheduleSave = false;

    set((state) => {
      const file = state.openFiles.get(oldPath);
      if (!file) return state;

      shouldScheduleSave = file.isDirty;

      const files = new Map(state.openFiles);
      files.delete(oldPath);
      files.set(newPath, { ...file, path: newPath });

      const rewrite = (loc: Location) => rewriteLocation(loc, oldPath, newPath);
      const tabs = state.tabs.map((tab) => applyRewriteToTab(tab, rewrite) ?? tab);

      // Tab ids are untouched by a rename, so pane membership is too.
      return { openFiles: files, ...publish(tabs, state.layout) };
    });

    rewriteEditorPaths((path) => (path === oldPath ? newPath : path));
    cancelSave(oldPath);
    if (shouldScheduleSave) scheduleSave(newPath);
  },

  // Drop every reference to `path` from editor state. Used after a delete so
  // tabs, history, openFiles, and pending saves are all cleaned up explicitly
  // instead of relying on the file watcher to fix things up later.
  removePathReferences: (path: string) => {
    discardDrawingSessions(path);
    set((state) => {
      const transform = (loc: Location) => removeFromLocation(loc, path);
      const tabs = state.tabs
        .map((tab) => applyRewriteToTab(tab, transform))
        .filter((tab): tab is Tab => tab !== null);

      const files = state.openFiles.has(path) ? new Map(state.openFiles) : null;
      files?.delete(path);

      return {
        ...publish(tabs, dropMissingTabs(state, tabs)),
        ...(files ? { openFiles: files } : {}),
      };
    });

    cancelSave(path);

    if (get().tabs.length === 0) {
      get().ensureLauncherTab();
    }
  },

  // Drop every reference to paths starting with `prefix` from editor state.
  // Used after deleting a folder to clean up all contained files.
  removePathsWithPrefix: (prefix: string) => {
    discardDrawingSessions(prefix);
    const dirPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    const matches = (p: string) => p === prefix || p.startsWith(dirPrefix);

    const cancelledPaths: string[] = [];

    set((state) => {
      const transform = (loc: Location): Location | null => {
        for (const p of locationPaths(loc)) {
          if (matches(p)) {
            return removeFromLocation(loc, p);
          }
        }
        return loc;
      };
      const tabs = state.tabs
        .map((tab) => applyRewriteToTab(tab, transform))
        .filter((tab): tab is Tab => tab !== null);

      const files = new Map(state.openFiles);
      for (const path of files.keys()) {
        if (matches(path)) {
          cancelledPaths.push(path);
          files.delete(path);
        }
      }

      return { ...publish(tabs, dropMissingTabs(state, tabs)), openFiles: files };
    });

    for (const path of cancelledPaths) {
      cancelSave(path);
    }

    if (get().tabs.length === 0) {
      get().ensureLauncherTab();
    }
  },

  // Rewrite a path prefix across all tabs, histories, and openFiles.
  // Used after renaming a folder to update all contained file references.
  rewritePathPrefix: (oldPrefix: string, newPrefix: string) => {
    const dirPrefix = oldPrefix.endsWith("/") ? oldPrefix : `${oldPrefix}/`;
    const rewritePath = (p: string) => {
      if (p === oldPrefix) return newPrefix;
      if (p.startsWith(dirPrefix)) return newPrefix + p.slice(oldPrefix.length);
      return p;
    };

    const reschedulePaths: string[] = [];

    set((state) => {
      const transform = (loc: Location): Location | null => {
        let next: Location = loc;
        for (const p of locationPaths(loc)) {
          const rewritten = rewritePath(p);
          if (rewritten !== p) {
            const applied = rewriteLocation(next, p, rewritten);
            if (!applied) return null;
            next = applied;
          }
        }
        return next;
      };
      const tabs = state.tabs
        .map((tab) => applyRewriteToTab(tab, transform))
        .filter((tab): tab is Tab => tab !== null);

      const files = new Map<string, OpenFile>();
      for (const [path, file] of state.openFiles) {
        const newPath = rewritePath(path);
        if (newPath !== path) {
          files.set(newPath, { ...file, path: newPath });
          if (file.isDirty) reschedulePaths.push(newPath);
          cancelSave(path);
        } else {
          files.set(path, file);
        }
      }

      return { openFiles: files, ...publish(tabs, state.layout) };
    });

    rewriteEditorPaths(rewritePath);
    for (const path of reschedulePaths) {
      scheduleSave(path);
    }
  },

  restoreSession: async (
    tabs: SessionTab[],
    activeIndex: number | null,
    prefetchedActiveFile: FileContent | null = null,
  ) => {
    const restoredTabs: Tab[] = [];
    for (const sessionTab of tabs) {
      const location = deserializeLocation(sessionTab.location);
      if (!location) continue;
      const back = sessionTab.back
        .map((l) => deserializeLocation(l))
        .filter((l): l is Location => l !== null);
      const forward = sessionTab.forward
        .map((l) => deserializeLocation(l))
        .filter((l): l is Location => l !== null);
      restoredTabs.push({
        id: createTabId(),
        location,
        back,
        forward,
      });
    }

    if (restoredTabs.length === 0) {
      set((state) => ({
        openFiles: new Map(),
        ...publish([], createLayout([], null, state.layout.revision + 1)),
      }));
      get().ensureLauncherTab();
      return;
    }

    const uniquePaths = [
      ...new Set(
        restoredTabs.flatMap((tab) => [
          ...locationPaths(tab.location),
          ...tab.back.flatMap((l) => locationPaths(l)),
          ...tab.forward.flatMap((l) => locationPaths(l)),
        ]),
      ),
    ];
    const activeTabIndex = activeIndex ?? 0;
    const activeTab = restoredTabs[activeTabIndex] ?? restoredTabs[0] ?? null;
    const activePath = activeTab ? locationPrimaryPath(activeTab.location) : null;

    // If the bundled `restore_workspace` IPC pre-fetched the active file, seed
    // it directly so the editor can mount with content already in place — no
    // round-trip back to Rust for the most-visible tab.
    const seededActive =
      prefetchedActiveFile && activePath && prefetchedActiveFile.path === activePath
        ? (() => {
            const parsed = parseDocument(prefetchedActiveFile.content);
            return withDerived({
              ...createLoadingFile(activePath),
              path: activePath,
              frontmatter: parsed.frontmatter,
              content: parsed.body ?? "",
              title: parsed.title,
              titleSource: parsed.titleSource,
              diskContent: prefetchedActiveFile.content,
              isLoading: false,
            });
          })()
        : null;

    set((state) => {
      const files = new Map(state.openFiles);
      for (const path of uniquePaths) {
        if (!files.has(path)) files.set(path, createLoadingFile(path));
      }
      if (seededActive && activePath) {
        files.set(activePath, seededActive);
      }

      // A v1 session is a flat tab list, which restores as one pane. The
      // same normalization path runs for it as for a runtime change.
      return {
        openFiles: files,
        ...publish(
          restoredTabs,
          createLayout(
            restoredTabs.map((tab) => tab.id),
            activeTab?.id ?? null,
            state.layout.revision + 1,
          ),
        ),
      };
    });

    // Skip the active path if we already seeded it from the prefetch — the
    // remaining background tabs still get loaded in parallel.
    const pathsToLoad = seededActive
      ? uniquePaths.filter((path) => path !== activePath)
      : uniquePaths;

    const results = await Promise.allSettled(
      pathsToLoad.map((path) => ensureFileLoaded(path, set as EditorStateSetter, get)),
    );
    const failedPaths = new Set(
      pathsToLoad.filter((_, index) => results[index]?.status === "rejected"),
    );

    if (failedPaths.size === 0) return;

    let shouldEnsureLauncher = false;
    set((state) => {
      const transform = (loc: Location): Location | null => {
        for (const p of locationPaths(loc)) {
          if (failedPaths.has(p)) return null;
        }
        return loc;
      };
      const nextTabs = state.tabs
        .map((tab) => applyRewriteToTab(tab, transform))
        .filter((tab): tab is Tab => tab !== null);
      const files = new Map(state.openFiles);
      for (const path of failedPaths) files.delete(path);

      shouldEnsureLauncher = nextTabs.length === 0;

      return { openFiles: files, ...publish(nextTabs, dropMissingTabs(state, nextTabs)) };
    });

    if (shouldEnsureLauncher) get().ensureLauncherTab();
  },

  updateContent: (path: string, content: string) => {
    const file = get().openFiles.get(path);
    if (!file) return;

    set((state) => {
      const existing = state.openFiles.get(path);
      if (!existing) return state;
      if (existing.content === content && existing.isDirty) return state;

      const { title, titleSource } = inferTitle(content, existing.frontmatter);
      const files = new Map(state.openFiles);
      files.set(path, {
        ...existing,
        content,
        title,
        titleSource,
        isDirty: true,
      });
      return { openFiles: files };
    });

    scheduleStatsRefresh(path, set as EditorStateSetter);
    scheduleSave(path);
  },

  updateFrontmatter: (path: string, frontmatter: string | null) => {
    set((state) => {
      const file = state.openFiles.get(path);
      if (!file || file.frontmatter === frontmatter) return state;

      const { title, titleSource } = inferTitle(file.content, frontmatter);
      const files = new Map(state.openFiles);
      files.set(
        path,
        withDerivedDate({
          ...file,
          frontmatter,
          title,
          titleSource,
          isDirty: true,
        }),
      );
      return { openFiles: files };
    });

    scheduleSave(path);
  },

  markSaved: (path: string, diskContent: string, hasNewerChanges = false) => {
    set((state) => {
      const file = state.openFiles.get(path);
      if (!file) return state;

      const files = new Map(state.openFiles);
      files.set(path, {
        ...file,
        diskContent,
        isDirty: hasNewerChanges,
        saveError: null,
      });
      return { openFiles: files };
    });
  },

  setSaveError: (path: string, error: string | null) => {
    set((state) => {
      const file = state.openFiles.get(path);
      if (!file || file.saveError === error) return state;

      const files = new Map(state.openFiles);
      files.set(path, { ...file, saveError: error });
      return { openFiles: files };
    });
  },

  reloadFromDisk: (path: string, rawContent: string) => {
    cancelSave(path);
    const parsed = parseDocument(rawContent);
    set((state) => {
      const file = state.openFiles.get(path);
      if (!file) return state;

      const files = new Map(state.openFiles);
      files.set(
        path,
        withDerived({
          ...file,
          frontmatter: parsed.frontmatter,
          content: parsed.body ?? "",
          title: parsed.title,
          titleSource: parsed.titleSource,
          diskContent: rawContent,
          isDirty: false,
          reloadVersion: file.reloadVersion + 1,
        }),
      );
      return { openFiles: files };
    });
  },
}));

// Wire the save engine to this store. The save module lives in `lib/` and must
// not import `stores/`, so it reads/writes the store through this injected
// accessor instead (see `registerSaveStore`).
registerSaveStore({
  getOpenFile: (path) => useEditorStore.getState().openFiles.get(path),
  markSaved: (path, diskContent, hasNewerChanges) =>
    useEditorStore.getState().markSaved(path, diskContent, hasNewerChanges),
  setSaveError: (path, error) => useEditorStore.getState().setSaveError(path, error),
});

export function getEditorSessionSnapshot(state: Pick<EditorState, "tabs" | "activeTabId">) {
  const tabs: SessionTab[] = [];
  let activeIndex: number | null = null;
  state.tabs.forEach((tab) => {
    const location = serializeLocation(tab.location);
    if (!location) return;
    const back = tab.back
      .map((l) => serializeLocation(l))
      .filter((l): l is SerializedLocation => l !== null);
    const forward = tab.forward
      .map((l) => serializeLocation(l))
      .filter((l): l is SerializedLocation => l !== null);
    const index = tabs.length;
    tabs.push({ location, back, forward });
    if (state.activeTabId && tab.id === state.activeTabId) {
      activeIndex = index;
    }
  });
  return { tabs, activeIndex };
}
