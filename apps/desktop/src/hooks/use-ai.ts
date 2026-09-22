import { useAiStore } from "@/stores/ai-store";

export function useAiPanelFor() {
  return useAiStore((s) => s.panelFor);
}

export function useAiSuggestions() {
  return useAiStore((s) => s.suggestions);
}

export function useAiRelated() {
  return useAiStore((s) => s.related);
}

export function useAiPanelLoading() {
  return useAiStore((s) => s.loading);
}

export function useAiPanelError() {
  return useAiStore((s) => s.error);
}

export function useGraphVersion() {
  return useAiStore((s) => s.graphVersion);
}

export function useAiPanelActions() {
  const openPanel = useAiStore((s) => s.openPanel);
  const acceptTag = useAiStore((s) => s.acceptTag);
  const acceptAll = useAiStore((s) => s.acceptAll);
  const closePanel = useAiStore((s) => s.closePanel);
  return { openPanel, acceptTag, acceptAll, closePanel };
}
