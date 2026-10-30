import { create } from "zustand";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { recheckOpenFiles } from "@/hooks/file-sync";
import { getDrawingSession, saveDrawingSessions } from "@/lib/drawing-sessions";
import { isDrawingPath } from "@/lib/drawings";
import { refreshDrawingEmbeds } from "@/lib/drawing-embed-sync";
import { defaultCommitMessage } from "@/lib/git";
import { getFileName } from "@/lib/paths";
import { saveAllNow } from "@/lib/save";
import * as tauri from "@/lib/tauri";
import type { GitKind, GitOutcome, GitStatus } from "@/lib/tauri";
import { useEditorStore } from "@/stores/editor-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

export type GitAction = "sync" | "pull" | "push" | "publish" | "commit" | "abort" | "init";

const ACTION_NAMES: Record<GitAction, string> = {
  sync: "Sync",
  pull: "Pull",
  push: "Push",
  publish: "Publish",
  commit: "Commit",
  abort: "Abort",
  init: "Initialize",
};

/** Failures the user must act on, even if the sidebar is hidden. */
const NEEDS_PANEL: ReadonlySet<GitKind> = new Set<GitKind>([
  "conflict",
  "secrets",
  "oneSided",
  "noUpstream",
]);

export interface GitResult {
  ok: boolean;
  kind: GitKind | "unsaved";
  message: string;
  at: number;
}

export interface GitConfirm {
  action: "sync" | "commit";
  /** What the warning is about. */
  kind: "secrets" | "oneSided";
  /** The files named in this warning. */
  suspects: string[];
  /** What earlier warnings for this same commit already confirmed. */
  allowed: string[];
  sides: string[];
}

interface GitState {
  root: string | null;
  status: GitStatus | null;
  running: GitAction | null;
  /** Per workspace, so switching away and back keeps the last result. */
  results: Record<string, GitResult>;
  panelOpen: boolean;
  /** What the user typed. Empty means the generated default. */
  message: string;
  /** Files left out of the next commit; everything else is chosen. */
  excluded: string[];
  confirm: GitConfirm | null;

  refresh: () => Promise<void>;
  sync: () => Promise<void>;
  pull: () => Promise<void>;
  push: () => Promise<void>;
  publish: () => Promise<void>;
  commit: () => Promise<void>;
  abortMerge: () => Promise<void>;
  init: () => Promise<void>;
  /** The user read the warning and wants those files committed as they are. */
  commitSuspects: () => Promise<void>;
  dismissConfirm: () => void;
  setPanelOpen: (open: boolean) => void;
  setMessage: (message: string) => void;
  toggleFile: (path: string) => void;
}

let statusRequest = 0;

/** Everything the commit will contain has to be on disk first. */
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
  async function run(
    action: GitAction,
    call: () => Promise<GitOutcome>,
    flush = true,
    confirmed: { allowed: string[]; sides: string[] } = { allowed: [], sides: [] },
  ) {
    const root = useWorkspaceStore.getState().root;
    if (!root) return;
    if (get().running) {
      showEditorNotice(`Git is busy: ${ACTION_NAMES[get().running!]} is still running.`);
      return;
    }
    set({ running: action, confirm: null });
    statusRequest += 1;
    const isCurrent = () => useWorkspaceStore.getState().root === root;

    let outcome: GitOutcome | null = null;
    let result: GitResult;
    try {
      if (flush) await flushEditors();
      outcome = await call();
      result = { ok: outcome.ok, kind: outcome.kind, message: outcome.message, at: Date.now() };
    } catch (error) {
      // The flush failed or the IPC itself did. Git hasn't touched the commit.
      const reason = error instanceof Error ? error.message : String(error);
      result = {
        ok: false,
        kind: "unsaved",
        message: `${ACTION_NAMES[action]} stopped: ${reason}`,
        at: Date.now(),
      };
    }

    if (outcome?.worktreeChanged && isCurrent()) {
      await recheckOpenFiles(isCurrent).catch((error: unknown) => {
        result.message += ` Couldn't re-check open notes: ${String(error)}`;
      });
      for (const path of outcome.pulled) if (isDrawingPath(path)) refreshDrawingEmbeds(path);
      useWorkspaceStore.getState().bumpSidebarMetadataVersion();
      const warning = closeStaleDrawings(outcome.pulled);
      if (warning) result.message += ` ${warning}`;
    }

    set((state) => ({
      running: null,
      results: { ...state.results, [root]: result },
    }));
    if (!isCurrent()) return;

    if (outcome) {
      const changed = outcome.ok && (action === "sync" || action === "commit");
      set((state) => ({
        status: outcome.status,
        root,
        message: changed ? "" : state.message,
        excluded: changed ? [] : state.excluded,
      }));
      if (
        (outcome.kind === "secrets" || outcome.kind === "oneSided") &&
        (action === "sync" || action === "commit")
      ) {
        set({ confirm: { action, kind: outcome.kind, suspects: outcome.suspects, ...confirmed } });
      }
      if (NEEDS_PANEL.has(outcome.kind)) revealGitPanelState(set);
    }
    showEditorNotice(result.message);
  }

  async function syncWith(allowed: string[]) {
    // The message comes from the files as they stand after the flush.
    await run(
      "sync",
      async () => {
        const fresh = await tauri.gitStatus();
        const typed = get().message.trim();
        return tauri.gitSync(typed || defaultCommitMessage(fresh.files), allowed);
      },
      true,
      { allowed, sides: [] },
    );
  }

  async function commitWith(allowed: string[], sides: string[]) {
    await run(
      "commit",
      async () => {
        const fresh = await tauri.gitStatus();
        const excluded = get().excluded;
        const chosen = fresh.files.filter((file) => !excluded.includes(file.path));
        const typed = get().message.trim();
        const merging = fresh.inProgress === "merge";
        return tauri.gitCommit(
          chosen.map((file) => file.path),
          typed || defaultCommitMessage(chosen, merging),
          allowed,
          sides,
        );
      },
      true,
      { allowed, sides },
    );
  }

  return {
    root: null,
    status: null,
    running: null,
    results: {},
    panelOpen: false,
    message: "",
    excluded: [],
    confirm: null,

    refresh: async () => {
      const root = useWorkspaceStore.getState().root;
      if (root !== get().root) {
        set({ root, status: null, message: "", excluded: [], confirm: null });
      }
      if (!root || get().running) return;
      const request = ++statusRequest;
      try {
        const status = await tauri.gitStatus();
        // An operation or a newer refresh has overtaken this read.
        if (request !== statusRequest || useWorkspaceStore.getState().root !== root) return;
        const present = new Set(status.files.map((file) => file.path));
        set((state) => ({
          status,
          excluded: state.excluded.filter((path) => present.has(path)),
        }));
      } catch (error) {
        if (request !== statusRequest || useWorkspaceStore.getState().root !== root) return;
        set({
          status: {
            kind: "other",
            message: `Couldn't read git status: ${String(error)}`,
            repoRoot: null,
            branch: null,
            upstream: null,
            hasRemote: false,
            ahead: 0,
            behind: 0,
            files: [],
            outsideChanges: 0,
            inProgress: null,
            conflicts: [],
          },
        });
      }
    },

    sync: () => syncWith([]),
    pull: () => run("pull", tauri.gitPull),
    push: () => run("push", tauri.gitPush, false),
    publish: () => run("publish", tauri.gitPublish, false),
    commit: () => commitWith([], []),
    // No flush: a dirty buffer here is a partial resolution. It stays in the
    // editor and becomes a visible conflict instead of being written then discarded.
    abortMerge: () => run("abort", tauri.gitAbortMerge, false),
    init: () => run("init", tauri.gitInit, false),

    commitSuspects: async () => {
      const confirm = get().confirm;
      if (!confirm) return;
      const named = confirm.kind === "secrets" ? confirm.suspects : [];
      const allowed = [...confirm.allowed, ...named];
      if (confirm.action === "sync") await syncWith(allowed);
      else if (confirm.kind === "oneSided") {
        await commitWith(allowed, [...confirm.sides, ...confirm.suspects]);
      } else await commitWith(allowed, confirm.sides);
    },
    dismissConfirm: () => set({ confirm: null }),
    setPanelOpen: (panelOpen) => set({ panelOpen }),
    setMessage: (message) => set({ message }),
    toggleFile: (path) =>
      set((state) => ({
        excluded: state.excluded.includes(path)
          ? state.excluded.filter((other) => other !== path)
          : [...state.excluded, path],
      })),
  };
});

function revealGitPanelState(set: (partial: Partial<GitState>) => void) {
  set({ panelOpen: true });
  const settings = useSettingsStore.getState();
  if (settings.settings["appearance.sidebar-visible"] === false) {
    void settings.setSetting("appearance.sidebar-visible", true);
  }
}

/** Open the panel, and the sidebar around it. */
export function revealGitPanel() {
  revealGitPanelState(useGitStore.setState);
}
