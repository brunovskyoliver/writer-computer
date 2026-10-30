import { create } from "zustand";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { recheckOpenFiles } from "@/hooks/file-sync";
import { getDrawingSession, saveDrawingSessions } from "@/lib/drawing-sessions";
import { refreshDrawingEmbeds } from "@/lib/drawing-embed-sync";
import { isDrawingPath } from "@/lib/drawings";
import { getFileName } from "@/lib/paths";
import { saveAllNow } from "@/lib/save";
import * as tauri from "@/lib/tauri";
import type { GitOutcome } from "@/lib/tauri";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

export type GitAction = "pull" | "push";

interface GitState {
  running: GitAction | null;
  pull: () => Promise<void>;
  push: () => Promise<void>;
}

/** Everything git will see has to be on disk first. */
async function flushEditors() {
  const conflicted = [...useEditorStore.getState().openFiles.values()]
    .filter((file) => file.conflict)
    .map((file) => getFileName(file.path));
  if (conflicted.length > 0) {
    throw new Error(
      `${conflicted.join(", ")} changed on disk while open. Choose a version in its tab, then try again.`,
    );
  }
  await saveAllNow();
  await saveDrawingSessions();
}

/**
 * Drawing tabs hold their scene in memory and don't reload, and saving one
 * would replace what was pulled. Close the clean ones so they reopen from disk.
 */
function closeStaleDrawings(pulled: string[]): string | null {
  const editor = useEditorStore.getState();
  const closed: string[] = [];
  const edited: string[] = [];
  for (const tab of editor.tabs) {
    if (tab.location.kind !== "drawing" || !pulled.includes(tab.location.path)) continue;
    const name = getFileName(tab.location.path);
    if (getDrawingSession(tab.location.path)?.isDirty()) {
      edited.push(name);
    } else {
      editor.closeTab(tab.id);
      closed.push(name);
    }
  }
  const notes = [];
  if (closed.length > 0) notes.push(`Closed ${closed.join(", ")}: reopen to see what was pulled.`);
  if (edited.length > 0) {
    notes.push(
      `${edited.join(", ")} was edited during the pull. Saving that tab would replace what was pulled.`,
    );
  }
  return notes.length > 0 ? notes.join(" ") : null;
}

export const useGitStore = create<GitState>((set, get) => {
  async function run(action: GitAction, call: () => Promise<GitOutcome>) {
    const root = useWorkspaceStore.getState().root;
    if (!root || get().running) return;
    const isCurrent = () => useWorkspaceStore.getState().root === root;
    set({ running: action });
    let message: string;
    try {
      await flushEditors();
      const outcome = await call();
      message = outcome.message;
      if (outcome.worktreeChanged && isCurrent()) {
        await recheckOpenFiles(isCurrent).catch((error: unknown) => {
          message += ` Couldn't re-check open notes: ${String(error)}`;
        });
        for (const path of outcome.pulled) if (isDrawingPath(path)) refreshDrawingEmbeds(path);
        useWorkspaceStore.getState().bumpSidebarMetadataVersion();
        const warning = closeStaleDrawings(outcome.pulled);
        if (warning) message += ` ${warning}`;
      }
    } catch (error) {
      // The flush failed or the IPC itself did. Git hasn't touched anything.
      const reason = error instanceof Error ? error.message : String(error);
      message = `${action === "pull" ? "Pull" : "Push"} stopped: ${reason}`;
    }
    set({ running: null });
    showEditorNotice(message);
  }

  return {
    running: null,
    pull: () => run("pull", tauri.gitPull),
    push: () => run("push", tauri.gitPush),
  };
});
