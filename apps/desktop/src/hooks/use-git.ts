import { useGitStore } from "@/stores/git-store";

export function useGitRunning() {
  return useGitStore((state) => state.running);
}

export function gitActions() {
  return useGitStore.getState();
}
