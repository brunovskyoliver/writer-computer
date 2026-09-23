import type { EditorView } from "@codemirror/view";
import * as editorViews from "@/lib/editor-views";
import { applyLineTarget, type LineTarget } from "@/components/editor-area/line-target";
import { findOuterScroller } from "@/components/editor-area/editor-scroll";
import { setPendingLineTarget } from "@/lib/pending-anchor";
import { encodeAnchorFragment } from "@/lib/pdf-anchor";
import { requestPdfAnchor } from "@/stores/pdf-anchor-store";
import { useEditorStore, type OpenTarget } from "@/stores/editor-store";
import type { SearchMatch } from "@/types/fs";
export type { OpenFile, Tab, OpenTarget } from "@/stores/editor-store";

export function getOpenFile(path: string) {
  return useEditorStore.getState().openFiles.get(path) ?? null;
}

export function getOpenFiles() {
  return useEditorStore.getState().openFiles;
}

export function getActiveFilePath() {
  return useEditorStore.getState().activeFilePath;
}

/** The pane an open route should capture before it awaits anything. */
export function getFocusedPaneId() {
  return useEditorStore.getState().layout.focusedPaneId;
}

/** The tab a view belongs to, for routes that start inside an editor. */
export function getTabIdForView(view: EditorView): string | null {
  return editorViews.getEditorRegistrationForView(view)?.tabId ?? null;
}

export function closeFile(path: string) {
  useEditorStore.getState().closeFile(path);
}

export function closeActiveTab() {
  useEditorStore.getState().closeActiveTab();
}

export function closeTab(tabId: string) {
  useEditorStore.getState().closeTab(tabId);
}

export function markSaved(path: string, diskContent: string) {
  useEditorStore.getState().markSaved(path, diskContent);
}

export function updateContent(path: string, content: string) {
  useEditorStore.getState().updateContent(path, content);
}

export function updateFrontmatter(path: string, frontmatter: string | null) {
  useEditorStore.getState().updateFrontmatter(path, frontmatter);
}

export function reloadFromDisk(path: string, rawContent: string) {
  useEditorStore.getState().reloadFromDisk(path, rawContent);
}

export function openFile(path: string, target?: OpenTarget) {
  return useEditorStore.getState().openFile(path, target);
}

export function navigateToFile(path: string, target?: OpenTarget) {
  return useEditorStore.getState().navigateToFile(path, target);
}

/**
 * Activate one content-search result (SPECs/global-content-search/
 * contracts/line-target.md).
 *
 * A result is an *open*, not a navigation: `openFile` focuses a tab that
 * already shows the file or mints a new one — it never moves a file tab's
 * location. The line handoff then lands on whichever tab ended up showing
 * the file: applied to its live view directly, or queued as a pending target
 * — `OpenTarget.pendingTarget` is written inside the publish that creates
 * the tab, so a pane mounting in the same commit already finds it.
 *
 * `pdf`: reuse-or-open via `openFile`, then queue a `page=N&text=<hint>`
 * anchor on the returned tab; the pane consumes it reactively and re-finds
 * the passage in its own coordinates.
 */
export function openSearchMatch(match: SearchMatch, needle: string) {
  if (match.kind === "pdf") {
    void openFile(match.path).then((tab) => {
      if (!tab || match.page === null) return;
      const anchor = { kind: "text", page: match.page, text: match.line_text } as const;
      requestPdfAnchor(tab.id, encodeAnchorFragment(anchor));
    });
    return;
  }

  const lineTarget =
    match.line_number !== null
      ? {
          line: match.line_number,
          offset: match.match_ranges[0]?.[0] ?? 0,
          length: match.match_ranges[0]?.[1] ?? 0,
          needle,
        }
      : null;

  openFileAtLineTarget(match.path, lineTarget);
}

/**
 * Open `path` and land on `lineTarget` — the shared open-then-locate path
 * for content-search matches and AI formula relations (line-relations-spec).
 * A live view is landed directly; a still-loading tab gets the target
 * queued via `setPendingLineTarget`.
 */
export function openFileAtLineTarget(path: string, lineTarget: LineTarget | null) {
  void openFile(
    path,
    lineTarget ? { pendingTarget: { kind: "line", ...lineTarget } } : undefined,
  ).then((tab) => {
    if (!tab || !lineTarget) return;
    const registration = editorViews.getEditorRegistration(tab.id);
    if (registration) {
      // A live view is landed directly: a queued target on an already
      // mounted editor sits unread and replays on a later visit. A wrong
      // path means the tab moved on — the target is stale, so drop it.
      if (registration.path !== path) return;
      const scrollContainer = findOuterScroller(registration.view.dom);
      if (scrollContainer) applyLineTarget(registration.view, scrollContainer, lineTarget);
      return;
    }
    // No live view yet — the tab is still loading. The pending write
    // happened inside the publish for a tab this open created; for a
    // dedupe-found tab it lands now, before its mount can run.
    setPendingLineTarget(tab.id, path, lineTarget);
  });
}

export function renameOpenFile(oldPath: string, newPath: string) {
  useEditorStore.getState().renameOpenFile(oldPath, newPath);
}

export function openFileInNewTab(path: string, target?: OpenTarget) {
  return useEditorStore.getState().openFileInNewTab(path, target);
}

export function removePathReferences(path: string) {
  useEditorStore.getState().removePathReferences(path);
}

export function removePathsWithPrefix(prefix: string) {
  useEditorStore.getState().removePathsWithPrefix(prefix);
}

export function rewritePathPrefix(oldPrefix: string, newPrefix: string) {
  useEditorStore.getState().rewritePathPrefix(oldPrefix, newPrefix);
}

// --- editor registrations --------------------------------------------------

/**
 * The registry itself lives in `lib/editor-views.ts` so the editor store can
 * clear a closed tab's view state without importing this module. Re-exported
 * here because call sites in components already speak `editorApi`.
 */
export {
  getEditorRegistrationForView,
  getEditorView,
  getTabViewState,
  registerEditorView,
  retargetEditorView,
  setTabCursor,
  setTabScroll,
  syncSiblingViews,
  syncTransaction,
  unregisterEditorView,
} from "@/lib/editor-views";

/** Every live view showing `path`, in tab traversal order. */
export function getEditorViewsForPath(path: string): EditorView[] {
  const tabOrder = useEditorStore.getState().tabs.map((tab) => tab.id);
  return editorViews.getEditorViewsForPath(path, tabOrder);
}

/** The view an API-level insert should target: the originating tab's if the
 *  caller captured one and it still shows this file, else the focused tab's,
 *  else the first in tab traversal order. */
function viewForPath(path: string, tabId: string | null): EditorView | null {
  const { activeTabId } = useEditorStore.getState();
  for (const candidate of [tabId, activeTabId]) {
    const registration = candidate ? editorViews.getEditorRegistration(candidate) : null;
    if (registration?.path === path) return registration.view;
  }
  return getEditorViewsForPath(path)[0] ?? null;
}

/** Insert at the note's caret through the view, so the edit flows through the
 *  update listener into the store, the sibling views, and the save scheduler
 *  the same way a typed character does. False when that note has no live
 *  editor. Pass the originating `tabId` when the caller captured one before
 *  async work, so the insert lands in the view the user was in. */
export function insertAtCursor(path: string, text: string, tabId: string | null = null): boolean {
  const view = viewForPath(path, tabId);
  if (!view) return false;
  const cursor = view.state.selection.main.head;
  const line = view.state.doc.lineAt(cursor);
  const textBeforeOnLine = line.text.slice(0, cursor - line.from);
  // If inserting a heading on a line that already has non-whitespace text,
  // precede it with a newline so Markdown parses the heading properly.
  const needsLeadingNewline = text.startsWith("#") && textBeforeOnLine.trim().length > 0;
  const insertText = needsLeadingNewline ? `\n\n${text}` : text;
  view.dispatch({
    changes: { from: cursor, insert: insertText },
    selection: { anchor: cursor + insertText.length },
  });
  return true;
}
