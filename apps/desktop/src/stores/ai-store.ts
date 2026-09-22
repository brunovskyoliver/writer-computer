import { create } from "zustand";
import * as editorApi from "@/hooks/editor-api";
import { aiRelated, aiSuggestTags, applyTags, type RelatedNote } from "@/lib/ai";
import { serializeFile } from "@/lib/frontmatter";
import { readFile } from "@/lib/tauri";

interface AiState {
  /** Path the suggestion panel is open for; `null` = hidden. */
  panelFor: string | null;
  suggestions: string[];
  related: RelatedNote[];
  loading: boolean;
  error: string | null;
  /** Bumped by the `ai:graph-changed` listener; graph panes refetch on it. */
  graphVersion: number;

  /** Open the suggestion card for `path` and fire the suggest+related loads. */
  openPanel: (path: string) => Promise<void>;
  /** Write one tag into the note's frontmatter and drop it from the list. */
  acceptTag: (tag: string) => Promise<void>;
  /** Write all remaining suggestions at once, then clear them. */
  acceptAll: () => Promise<void>;
  closePanel: () => void;
  bumpGraphVersion: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useAiStore = create<AiState>((set, get) => ({
  panelFor: null,
  suggestions: [],
  related: [],
  loading: false,
  error: null,
  graphVersion: 0,

  openPanel: async (path) => {
    set({ panelFor: path, suggestions: [], related: [], loading: true, error: null });
    try {
      // Prefer the open buffer — it may be ahead of disk.
      const open = editorApi.getOpenFile(path);
      const content = open
        ? serializeFile(open.frontmatter, open.content)
        : (await readFile(path)).content;
      const [suggestions, related] = await Promise.all([
        aiSuggestTags(path, content),
        aiRelated(path).catch(() => [] as RelatedNote[]),
      ]);
      // The panel may have moved to another file while the request flew.
      if (get().panelFor !== path) return;
      set({ suggestions, related, loading: false });
    } catch (error) {
      if (get().panelFor !== path) return;
      set({ loading: false, error: errorMessage(error) });
    }
  },

  acceptTag: async (tag) => {
    const { panelFor } = get();
    if (!panelFor) return;
    try {
      await applyTags(panelFor, [tag]);
      set((state) => ({ suggestions: state.suggestions.filter((t) => t !== tag) }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  acceptAll: async () => {
    const { panelFor, suggestions } = get();
    if (!panelFor || suggestions.length === 0) return;
    try {
      await applyTags(panelFor, suggestions);
      set({ suggestions: [] });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  closePanel: () =>
    set({ panelFor: null, suggestions: [], related: [], loading: false, error: null }),

  bumpGraphVersion: () => set((state) => ({ graphVersion: state.graphVersion + 1 })),
}));
