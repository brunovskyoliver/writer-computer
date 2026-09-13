import { create } from "zustand";

const DISMISS_AFTER_MS = 4000;

interface EditorNoticeState {
  message: string | null;
  /** The tab the notice is about, so the banner can sit over that tab's
   *  pane. `null` for window-wide notices. */
  tabId: string | null;
  showNotice: (message: string, tabId?: string | null) => void;
  dismissNotice: () => void;
}

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

/** Transient, self-dismissing notices shown over the editor: unresolved anchor
 *  links, rejected pastes, and similar "that didn't happen, here's why" cases. */
export const useEditorNoticeStore = create<EditorNoticeState>((set, get) => ({
  message: null,
  tabId: null,
  showNotice: (message, tabId = null) => {
    if (dismissTimer !== null) clearTimeout(dismissTimer);
    set({ message, tabId });
    dismissTimer = setTimeout(() => {
      dismissTimer = null;
      get().dismissNotice();
    }, DISMISS_AFTER_MS);
  },
  dismissNotice: () => {
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
    set({ message: null, tabId: null });
  },
}));

/** Show a notice. Pass the originating `tabId` when there is one so the
 *  banner appears over the pane the user acted in. */
export function showEditorNotice(message: string, tabId: string | null = null) {
  useEditorNoticeStore.getState().showNotice(message, tabId);
}

export function dismissEditorNotice() {
  useEditorNoticeStore.getState().dismissNotice();
}
