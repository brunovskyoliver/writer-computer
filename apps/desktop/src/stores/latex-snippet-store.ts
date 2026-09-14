/**
 * Owns the LaTeX snippet file: its path, its load status, and the compiled set
 * the editor scans per keystroke. This is the only module that reads the file
 * or calls the two Rust commands — editor views and Settings only read state
 * from here (docs/consolidation.md, "side-effect ownership").
 *
 * API: SPECs/latex-suite/contracts/ipc-and-events.md ("Frontend store API")
 */

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import * as tauri from "@/lib/tauri";
import { useEditorStore } from "@/stores/editor-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  compileSnippetSet,
  EMPTY_SNIPPET_SET,
  parseVariables,
  type CompiledSnippetSet,
} from "@/lib/latex-snippets/compile";
import type { EntryError, LoadError } from "@/lib/latex-snippets/options";
import { parseSnippetFile } from "@/lib/latex-snippets/parse-snippet-file";

export type SnippetLoadStatus =
  /** Before the first load: the engine is inert. */
  | { kind: "empty" }
  /** Loaded; `warnings` lists the entries that were skipped. */
  | { kind: "loaded"; set: CompiledSnippetSet; warnings: EntryError[] }
  /** The file could not be read or parsed; `set` is the last valid one (FR-017). */
  | { kind: "failed"; error: LoadError; set: CompiledSnippetSet };

interface LatexSnippetState {
  filePath: string | null;
  status: SnippetLoadStatus;

  /** The single write path for `status`: ensure the file, read, parse, compile
   *  with the current variables. Safe to call concurrently — a stale read can
   *  never overwrite a newer result. */
  load: () => Promise<void>;
  /** Restore the shipped defaults, then reload. */
  reset: () => Promise<void>;
  /** Open the snippet file as an editor tab. */
  openInEditor: () => Promise<void>;
  /** What the editor reads per keystroke, whatever the load status. */
  getActiveSet: () => CompiledSnippetSet;
  /** Disable one snippet for the session (its regex timed out or threw) and
   *  surface the reason in Settings. */
  markDisabled: (id: number, error: EntryError) => void;
}

/** Monotonic load counter: only the newest load may write `status`. */
let loadSequence = 0;

function allSnippets(set: CompiledSnippetSet) {
  return (["text", "inline", "display"] as const).flatMap((mode) => [
    ...set.byMode[mode].auto,
    ...set.byMode[mode].tab,
  ]);
}

export const useLatexSnippetStore = create<LatexSnippetState>((setState, get) => ({
  filePath: null,
  status: { kind: "empty" },

  load: async () => {
    const sequence = ++loadSequence;
    const isCurrent = () => sequence === loadSequence;

    const fail = (error: LoadError) => {
      if (!isCurrent()) return;
      setState({ status: { kind: "failed", error, set: get().getActiveSet() } });
    };

    try {
      const filePath = get().filePath ?? (await tauri.getLatexSnippetsPath());
      if (!isCurrent()) return;
      setState({ filePath });

      const file = await tauri.readFile(filePath);
      if (!isCurrent()) return;

      const parsed = await parseSnippetFile(file.content);
      if (!isCurrent()) return;
      if ("failure" in parsed) {
        fail(parsed.failure);
        return;
      }

      // `list` settings come back from IPC as untyped JSON (and the typed
      // schema registry widens them), so validate at the boundary.
      const configured: unknown = useSettingsStore.getState().getSetting("latex.snippet-variables");
      const items = Array.isArray(configured)
        ? configured.filter((item): item is string => typeof item === "string")
        : [];
      const { variables, errors: variableErrors } = parseVariables(items);
      const { set, errors: compileErrors } = compileSnippetSet(parsed.entries, variables);

      setState({
        status: {
          kind: "loaded",
          set,
          warnings: [...parsed.errors, ...variableErrors, ...compileErrors],
        },
      });
    } catch (error) {
      fail({ message: error instanceof Error ? error.message : String(error) });
    }
  },

  reset: async () => {
    const filePath = await tauri.resetLatexSnippets();
    setState({ filePath });
    await get().load();
  },

  openInEditor: async () => {
    const filePath = get().filePath ?? (await tauri.getLatexSnippetsPath());
    setState({ filePath });
    await useEditorStore.getState().openFileInNewTab(filePath);
  },

  getActiveSet: () => {
    const { status } = get();
    return status.kind === "empty" ? EMPTY_SNIPPET_SET : status.set;
  },

  markDisabled: (id, error) => {
    const { status } = get();
    if (status.kind === "empty") return;

    // One snippet object is shared by every bucket it sits in, so disabling it
    // here disables it everywhere the matcher looks.
    const snippet = allSnippets(status.set).find((candidate) => candidate.id === id);
    if (!snippet || snippet.disabled) return;
    snippet.disabled = error;

    // A failed status has no warning list; the last valid set stays active and
    // the disabled snippet is simply skipped until the next reload.
    if (status.kind === "loaded") {
      setState({ status: { ...status, warnings: [...status.warnings, error] } });
    }
  },
}));

function sameItems(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

/**
 * Reload when the file changes on disk (the global watcher emits for every
 * window) and recompile when the snippet variables change. Returns one
 * teardown for both.
 */
export function startLatexSnippetSubscriptions(): () => void {
  const fileChanged = listen<{ path: string }>("fs:file-changed", (event) => {
    const { filePath, load } = useLatexSnippetStore.getState();
    if (event.payload.path !== filePath) return;
    void load();
  });

  const unsubscribeSettings = useSettingsStore.subscribe((state, previous) => {
    const key = "latex.snippet-variables";
    if (sameItems(state.settings[key], previous.settings[key])) return;
    void useLatexSnippetStore.getState().load();
  });

  return () => {
    void fileChanged.then((unlisten) => unlisten());
    unsubscribeSettings();
  };
}
