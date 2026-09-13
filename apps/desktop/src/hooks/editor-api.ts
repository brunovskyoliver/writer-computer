import type { EditorView } from "@codemirror/view";
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

export function markSaved(path: string, diskContent: string) {
  useEditorStore.getState().markSaved(path, diskContent);
}

export function updateContent(path: string, content: string) {
  useEditorStore.getState().updateContent(path, content);
}

export function updateCursorPos(path: string, pos: number) {
  useEditorStore.getState().updateCursorPos(path, pos);
}

export function updateScrollPos(path: string, pos: number) {
  useEditorStore.getState().updateScrollPos(path, pos);
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

// Path → live CodeMirror view. Inactive tabs keep their `EditorPane` mounted,
// so several views exist at once, and the swap effect retargets one view at
// another file without remounting — hence keyed by path, with the view's stale
// keys dropped on every set.
const editorViews = new Map<string, EditorView>();

export function setEditorView(path: string, view: EditorView) {
  clearEditorView(view);
  editorViews.set(path, view);
}

export function clearEditorView(view: EditorView) {
  for (const [key, value] of editorViews) if (value === view) editorViews.delete(key);
}

/** Insert at the note's caret through the view, so the edit flows through the
 *  update listener into the store and the save scheduler the same way a typed
 *  character does. False when that note has no live editor. */
export function insertAtCursor(path: string, text: string): boolean {
  const view = editorViews.get(path);
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
