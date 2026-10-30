import { useGitStore, revealGitPanel } from "@/stores/git-store";
export { revealGitPanel };
export type { GitAction, GitConfirm, GitResult } from "@/stores/git-store";

export function useGitStatus() {
  return useGitStore((state) => state.status);
}

export function useGitRunning() {
  return useGitStore((state) => state.running);
}

export function useGitResult(root: string | null) {
  return useGitStore((state) => (root ? state.results[root] : undefined) ?? null);
}

export function useGitPanelOpen() {
  return useGitStore((state) => state.panelOpen);
}

export function useGitMessage() {
  return useGitStore((state) => state.message);
}

export function useGitExcluded() {
  return useGitStore((state) => state.excluded);
}

export function useGitConfirm() {
  return useGitStore((state) => state.confirm);
}

/** Actions for handlers and non-component callers; no subscription. */
export function gitActions() {
  return useGitStore.getState();
}
