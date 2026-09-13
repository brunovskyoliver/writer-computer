import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

/**
 * Per-tab Vim state mirrored out of `@replit/codemirror-vim` so the footer can
 * render the mode indicator in its own typography. Written only by
 * `vim-mode.ts` (`byTab`) and `document-footer.tsx` (`dialogHost`); everything
 * else reads.
 */

export type VimMode = "normal" | "insert" | "replace" | "visual" | "visual-line" | "visual-block";

export interface VimTabState {
  mode: VimMode;
  /** Keys typed so far in an incomplete command, e.g. `d2`, `"a`, `ci`. Empty when idle. */
  pending: string;
  /** Register being recorded into (`q<letter>`), or null. */
  recording: string | null;
}

export interface VimStoreState {
  byTab: Map<string, VimTabState>;
  /** The footer element library prompts and messages are mounted into. */
  dialogHost: HTMLElement | null;
}

export interface VimFooterModel {
  label: string;
  pending: string;
  recording: string | null;
}

export const VIM_MODE_LABELS: Record<VimMode, string> = {
  normal: "NORMAL",
  insert: "INSERT",
  replace: "REPLACE",
  visual: "VISUAL",
  "visual-line": "V-LINE",
  "visual-block": "V-BLOCK",
};

/** Map the library's `vim-mode-change` payload onto our mode union. */
export function toVimMode(mode: string, subMode?: string): VimMode {
  if (mode === "visual") {
    if (subMode === "linewise") return "visual-line";
    if (subMode === "blockwise") return "visual-block";
    return "visual";
  }
  if (mode === "insert" || mode === "replace") return mode;
  return "normal";
}

const INITIAL_TAB_STATE: VimTabState = { mode: "normal", pending: "", recording: null };

export const useVimStore = create<VimStoreState>(() => ({
  byTab: new Map(),
  dialogHost: null,
}));

// Each write replaces the Map so selectors on `byTab` see a new reference.
function patchTab(tabId: string, patch: Partial<VimTabState>) {
  useVimStore.setState((state) => {
    const existing = state.byTab.get(tabId);
    if (!existing) return state;
    const byTab = new Map(state.byTab);
    byTab.set(tabId, { ...existing, ...patch });
    return { byTab };
  });
}

export function createTab(tabId: string) {
  useVimStore.setState((state) => {
    const byTab = new Map(state.byTab);
    byTab.set(tabId, INITIAL_TAB_STATE);
    return { byTab };
  });
}

export function setTabMode(tabId: string, mode: VimMode) {
  patchTab(tabId, { mode });
}

export function setTabPending(tabId: string, pending: string) {
  patchTab(tabId, { pending });
}

export function setTabRecording(tabId: string, recording: string | null) {
  patchTab(tabId, { recording });
}

export function deleteTab(tabId: string) {
  useVimStore.setState((state) => {
    if (!state.byTab.has(tabId)) return state;
    const byTab = new Map(state.byTab);
    byTab.delete(tabId);
    return { byTab };
  });
}

export function registerVimDialogHost(el: HTMLElement | null) {
  useVimStore.setState({ dialogHost: el });
}

export function selectVimFooterModel(
  state: VimStoreState,
  tabId: string | null,
): VimFooterModel | null {
  const entry = tabId ? state.byTab.get(tabId) : undefined;
  if (!entry) return null;
  return { label: VIM_MODE_LABELS[entry.mode], pending: entry.pending, recording: entry.recording };
}

/** Footer view model for `tabId`; `null` when Vim is off for that tab. The
 *  selector builds a fresh object, so compare shallowly to avoid re-renders. */
export function useVimFooterModel(tabId: string | null): VimFooterModel | null {
  return useVimStore(useShallow((state) => selectVimFooterModel(state, tabId)));
}
