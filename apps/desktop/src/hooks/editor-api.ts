import type { EditorView } from "@codemirror/view";
import * as editorViews from "@/lib/editor-views";
import { useEditorStore } from "@/stores/editor-store";
export type { OpenFile, Tab, SessionTab } from "@/stores/editor-store";

export function getOpenFile(path: string) {
  return useEditorStore.getState().openFiles.get(path) ?? null;
}

export function getOpenFiles() {
  return useEditorStore.getState().openFiles;
}

export function getActiveFilePath() {
  return useEditorStore.getState().activeFilePath;
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

export function navigateToFile(path: string) {
  return useEditorStore.getState().navigateToFile(path);
}

export function renameOpenFile(oldPath: string, newPath: string) {
  useEditorStore.getState().renameOpenFile(oldPath, newPath);
}

export function openFileInNewTab(path: string) {
  return useEditorStore.getState().openFileInNewTab(path);
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

/** The view an API-level insert should target: the focused tab's, if it shows
 *  this file, otherwise the first in tab traversal order. */
function viewForPath(path: string): EditorView | null {
  const { activeTabId } = useEditorStore.getState();
  const focused = activeTabId ? editorViews.getEditorRegistration(activeTabId) : null;
  if (focused?.path === path) return focused.view;
  return getEditorViewsForPath(path)[0] ?? null;
}

/** Insert at the note's caret through the view, so the edit flows through the
 *  update listener into the store, the sibling views, and the save scheduler
 *  the same way a typed character does. False when that note has no live
 *  editor. */
export function insertAtCursor(path: string, text: string): boolean {
  const view = viewForPath(path);
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
