import { Annotation, type ChangeSet, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * The live CodeMirror views and their per-view state.
 *
 * Lives in `lib/` rather than beside the rest of `editor-api` because the
 * editor store needs to clear a closed tab's view state and re-key the path
 * index on rename, and `lib/` must not import `stores/` — that back-edge would
 * invert the layering and form a cycle. Anything here that needs to know the
 * tab *order* is exposed as an ordered-input helper and resolved in
 * `hooks/editor-api.ts`, which may read the store.
 */

/**
 * A mounted editor, keyed by the tab that owns it.
 *
 * Keyed by tab rather than by path because one document can be open in several
 * panes at once, each with its own view, cursor, scroll, and undo history. The
 * path is a field, so "every view of this document" is a derived lookup and
 * never a second source of truth.
 *
 * `generation` guards the unregister: React can mount the replacement view
 * before the outgoing one runs its cleanup, and a blind delete on the tab id
 * would then drop the live registration.
 */
export interface EditorRegistration {
  tabId: string;
  path: string;
  view: EditorView;
  generation: number;
}

const registrations = new Map<string, EditorRegistration>();
let registrationSequence = 0;

/** Register `view` as the editor for `tabId`. Returns the generation to hand
 *  back to `unregisterEditorView`. */
export function registerEditorView(tabId: string, path: string, view: EditorView): number {
  registrationSequence += 1;
  registrations.set(tabId, { tabId, path, view, generation: registrationSequence });
  return registrationSequence;
}

/** Point an existing registration at another document. A tab reuses one view
 *  across navigation, so this re-keys the path index without a remount. */
export function retargetEditorView(tabId: string, path: string) {
  const registration = registrations.get(tabId);
  if (registration) registration.path = path;
}

/** Drop a registration, but only if it is still the one `generation` created.
 *  A tab moving between panes must not unregister at all — it keeps its view. */
export function unregisterEditorView(tabId: string, generation: number) {
  if (registrations.get(tabId)?.generation === generation) registrations.delete(tabId);
}

export function getEditorRegistration(tabId: string): EditorRegistration | null {
  return registrations.get(tabId) ?? null;
}

export function getEditorView(tabId: string): EditorView | null {
  return registrations.get(tabId)?.view ?? null;
}

/** Reverse lookup for callbacks that only hold the view (Vim ex commands).
 *  Linear scan; the tab count is small. */
export function getEditorRegistrationForView(view: EditorView): EditorRegistration | null {
  for (const registration of registrations.values()) {
    if (registration.view === view) return registration;
  }
  return null;
}

/** Every live view showing `path`, ordered by `tabOrder` first and then by
 *  registration order for anything the caller did not rank. */
export function getEditorViewsForPath(path: string, tabOrder: string[] = []): EditorView[] {
  const ranked = tabOrder.flatMap((tabId) => {
    const registration = registrations.get(tabId);
    return registration?.path === path ? [registration] : [];
  });
  const seen = new Set(ranked.map((registration) => registration.tabId));
  const rest = [...registrations.values()].filter(
    (registration) => registration.path === path && !seen.has(registration.tabId),
  );
  return [...ranked, ...rest].map((registration) => registration.view);
}

/** Rewrite registration and view-state paths after a rename or folder move, so
 *  the index is correct immediately rather than after React re-renders. */
export function rewriteEditorPaths(rewrite: (path: string) => string) {
  for (const registration of registrations.values()) {
    registration.path = rewrite(registration.path);
  }
  for (const [tabId, state] of viewStateByTab) {
    viewStateByTab.set(tabId, { ...state, path: rewrite(state.path) });
  }
}

// --- per-tab view state ----------------------------------------------------

/**
 * Cursor and scroll belong to a *view*, not to a document: the same note open
 * in two panes has two carets. Runtime only — never serialized, never in the
 * store, so moving the caret cannot clone the document map or wake a layout
 * subscriber.
 *
 * `path` invalidates the entry when the tab navigates elsewhere, which is what
 * the old per-document `OpenFile.cursorPos`/`scrollPos` fields did implicitly.
 */
interface TabViewState {
  path: string;
  cursor: number;
  scroll: number;
}

const EMPTY_VIEW_STATE = { cursor: 0, scroll: 0 };
const viewStateByTab = new Map<string, TabViewState>();

export function getTabViewState(tabId: string, path: string): { cursor: number; scroll: number } {
  const state = viewStateByTab.get(tabId);
  return state && state.path === path ? state : EMPTY_VIEW_STATE;
}

function updateTabViewState(tabId: string, path: string, patch: Partial<TabViewState>) {
  const existing = viewStateByTab.get(tabId);
  const base = existing && existing.path === path ? existing : { path, ...EMPTY_VIEW_STATE };
  viewStateByTab.set(tabId, { ...base, ...patch, path });
}

export function setTabCursor(tabId: string, path: string, cursor: number) {
  updateTabViewState(tabId, path, { cursor });
}

export function setTabScroll(tabId: string, path: string, scroll: number) {
  updateTabViewState(tabId, path, { scroll });
}

/** Called when a tab is truly closed. A move must not call this — the tab
 *  keeps its caret and scroll wherever it lands. */
export function clearTabViewState(tabId: string) {
  viewStateByTab.delete(tabId);
}

// --- shared buffer ---------------------------------------------------------

/** Marks a transaction as a sibling synchronization rather than a user edit,
 *  so the update listener does not republish it and loop. */
export const syncTransaction = Annotation.define<boolean>();

/**
 * Push one view's document change into every other view of the same file,
 * synchronously. Each sibling maps its own selection through the changes, so
 * the carets stay where their users left them, and the history extension maps
 * each view's existing undo events through the incoming change.
 *
 * The originating view has already written to the store and scheduled the
 * save; siblings must do neither, which is what the annotation buys.
 */
export function syncSiblingViews(path: string, origin: EditorView, changes: ChangeSet) {
  for (const registration of registrations.values()) {
    if (registration.path !== path || registration.view === origin) continue;
    registration.view.dispatch({
      changes,
      // Two separate jobs. The annotation stops the sibling's update listener
      // from republishing the change and looping it back. `addToHistory:
      // false` keeps the change out of the sibling's own undo stack, while the
      // history extension still maps that stack's existing events through it —
      // so undoing here reverts what this tab typed, not what the other did.
      annotations: [syncTransaction.of(true), Transaction.addToHistory.of(false)],
      scrollIntoView: false,
    });
  }
}

/** Test seam: drop every registration and view state. */
export function resetEditorViews() {
  registrations.clear();
  viewStateByTab.clear();
}
