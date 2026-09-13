import type { EditorView } from "@codemirror/view";

/**
 * `:w`, `:q`, `:q!`, `:wq`, `:x` against Writer's autosaving editor.
 *
 * The library's `:write` expects a CM5 `commands.save` hook and has no `:quit`
 * at all, so these are registered on the `Vim` singleton and routed to the
 * app's own save engine and tab-close path. Dependencies are injected so the
 * dispatch logic runs in a node test without the library or the stores.
 */

export interface VimExDeps {
  /** `tabId` and `path` for the view the command ran in; `null` if unregistered. */
  resolve: (view: EditorView) => { tabId: string; path: string } | null;
  getOpenFile: (
    path: string,
  ) => { isDirty: boolean; content: string; diskContent: string } | undefined;
  /** Immediate save; resolves `false` when the write failed (error already surfaced). */
  saveNow: (path: string) => Promise<boolean>;
  closeTab: (tabId: string) => void;
  reloadFromDisk: (path: string, raw: string) => void;
  notify: (view: EditorView, message: string) => void;
}

/** The slice of the library's `Vim` object and ex-command call shape used here. */
export interface VimExRegistry {
  defineEx(name: string, prefix: string | undefined, func: VimExFn): void;
}
export type VimExFn = (cm: { cm6: EditorView }, params: { argString?: string }) => void;

export const E37 = "E37: No write since last change (add ! to override)";
export const NO_FILE = "No file for this editor";

let registered = false;

/** Idempotent: `Vim` is a module singleton and this runs once per JS context,
 *  which under HMR can mean more than once per module evaluation. */
export function registerVimExCommands(vim: VimExRegistry, deps: VimExDeps) {
  if (registered) return;
  registered = true;

  const withFile = (cm: { cm6: EditorView }, run: (tabId: string, path: string) => void) => {
    const target = deps.resolve(cm.cm6);
    if (!target) {
      deps.notify(cm.cm6, NO_FILE);
      return;
    }
    run(target.tabId, target.path);
  };

  const hasUnsavedChanges = (path: string) => {
    const file = deps.getOpenFile(path);
    return file !== undefined && file.isDirty && file.content !== file.diskContent;
  };

  const discardAndClose = (tabId: string, path: string) => {
    const file = deps.getOpenFile(path);
    if (file) deps.reloadFromDisk(path, file.diskContent);
    deps.closeTab(tabId);
  };

  const saveAndClose = async (tabId: string, path: string) => {
    if (await deps.saveNow(path)) deps.closeTab(tabId);
  };

  vim.defineEx("write", "w", (cm) => {
    withFile(cm, (_tabId, path) => void deps.saveNow(path));
  });

  vim.defineEx("quit", "q", (cm, params) => {
    withFile(cm, (tabId, path) => {
      if (isBang(params)) {
        discardAndClose(tabId, path);
      } else if (hasUnsavedChanges(path)) {
        deps.notify(cm.cm6, E37);
      } else {
        deps.closeTab(tabId);
      }
    });
  });

  const writeQuit: VimExFn = (cm) => {
    withFile(cm, (tabId, path) => void saveAndClose(tabId, path));
  };
  vim.defineEx("wq", "wq", writeQuit);
  vim.defineEx("xit", "x", writeQuit);
}

/** The library keeps the command name to `\w+`, so `:q!` arrives as `q` with
 *  `!` as the argument string. */
function isBang(params: { argString?: string }) {
  return (params.argString ?? "").trimStart().startsWith("!");
}

/** Test seam. */
export function resetVimExCommandsForTests() {
  registered = false;
}
