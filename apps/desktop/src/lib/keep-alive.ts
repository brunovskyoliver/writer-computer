/**
 * Recency bookkeeping for the hidden keepAlive view budget.
 *
 * Every keepAlive tab body used to stay mounted for the tab's whole life —
 * a live CodeMirror/Excalidraw/pdf.js tree per background tab, ~6–20 MB
 * each. `editor-store` stamps each pane's active tab here on every publish,
 * and `isTabSuspended` evicts the least-recently-visible hidden tabs beyond
 * `MAX_HIDDEN_VIEWS`, so the mounted view count stays bounded instead of
 * scaling with open tabs.
 *
 * What an evicted tab loses is only what cannot outlive the view: the
 * CodeMirror undo stack. Cursor and scroll persist in `editor-views`
 * `viewStateByTab`, document text in `openFiles`/`pendingDocs`, drawing
 * scenes in their `drawing-sessions` session, PDF page in the location —
 * a remount restores all of it.
 */

/** Hidden keepAlive tabs allowed to keep a live view. Visible tabs and
 *  dirty-file tabs never count toward the cap. */
export const MAX_HIDDEN_VIEWS = 8;

let sequence = 0;
const lastVisibleAt = new Map<string, number>();

/** Stamp `tabId` as visible now. Called from `publish` for every pane's
 *  active tab — the stamp order *is* "most recently seen on screen". */
export function noteVisibleTab(tabId: string): void {
  lastVisibleAt.set(tabId, ++sequence);
}

/** Recency rank: higher was on screen more recently; 0 = never mounted. */
export function lastVisibleRank(tabId: string): number {
  return lastVisibleAt.get(tabId) ?? 0;
}

/** The tab is gone for good — its rank means nothing now. */
export function forgetKeepAliveTab(tabId: string): void {
  lastVisibleAt.delete(tabId);
}

/** Workspace/test reset — ranks are per-window-lifetime, not per-workspace. */
export function resetKeepAlive(): void {
  lastVisibleAt.clear();
}
