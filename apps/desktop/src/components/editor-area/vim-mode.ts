import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { CodeMirror, CodeMirrorV } from "@replit/codemirror-vim";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as editorApi from "@/hooks/editor-api";
import { saveNow } from "@/lib/save";
import { useSettingsStore } from "@/stores/settings-store";
import { createVimClipboardBridge, type VimClipboardBridge } from "./vim-clipboard";
import { registerVimExCommands } from "./vim-ex-commands";
import { redirectVimScrollToOuterScroller } from "./vim-scroll";
import {
  createTab,
  deleteTab,
  setTabMode,
  setTabPending,
  setTabRecording,
  toVimMode,
  useVimStore,
} from "./vim-store";

/**
 * Opt-in Vim emulation for one editor view.
 *
 * `@replit/codemirror-vim` lives in a compartment that holds `vim()` while
 * `editor.vim-mode` is on and nothing otherwise, so the off path costs no
 * keystroke work and no startup bytes (the library is a dynamic import). The
 * plugin owns the settings subscription, mirrors the library's events into
 * `vim-store` for the footer, and moves the library's prompt/notification
 * nodes into the footer's dialog host so they render in the app's chrome.
 * Registers are a library singleton, so the clipboard bridge is module-scoped
 * and shared by every enabled view.
 */

type VimModule = typeof import("@replit/codemirror-vim");

let vimModule: Promise<VimModule> | null = null;
let clipboardBridge: VimClipboardBridge | null = null;
function loadVim(): Promise<VimModule> {
  vimModule ??= import("@replit/codemirror-vim").then((mod) => {
    clipboardBridge = createVimClipboardBridge({
      register: () => mod.Vim.getRegisterController().unnamedRegister,
      readText,
      writeText,
      // `copy` / `cut` bubble from the editor to the window, and `focus` fires
      // there when the app comes back to the front.
      target: window,
    });
    registerVimExCommands(mod.Vim, {
      resolve: (view) => {
        const registration = editorApi.getEditorRegistrationForView(view);
        return registration ? { tabId: registration.tabId, path: registration.path } : null;
      },
      getOpenFile: (path) => editorApi.getOpenFile(path) ?? undefined,
      saveNow,
      closeTab: editorApi.closeTab,
      reloadFromDisk: editorApi.reloadFromDisk,
      notify: (view, message) => {
        const cm = mod.getCM(view);
        if (!cm) throw new Error("[vim-mode] notify on a view without the vim plugin");
        const node = document.createElement("div");
        node.className = "cm-vim-message";
        node.textContent = message;
        cm.openNotification(node, { bottom: true, duration: 5000 });
      },
    });
    return mod;
  });
  return vimModule;
}

function isVimSettingOn(): boolean {
  return useSettingsStore.getState().settings["editor.vim-mode"] === true;
}

/**
 * The macro-recording message is the one library dialog built from a bare
 * `<span>`: prompts carry an `<input>`, notifications wrap a `<div>`. The
 * footer already shows `recording @x` from the store (the library's own
 * message is dropped as soon as any `:` prompt closes), so that one stays out
 * of the host.
 */
function isRecordingDialog(dialog: HTMLElement): boolean {
  return !dialog.querySelector("input") && dialog.firstElementChild instanceof HTMLSpanElement;
}

class VimModePlugin implements PluginValue {
  private readonly unsubscribe: () => void;
  private cm: CodeMirror | null = null;
  private vim: VimModule["Vim"] | null = null;
  private enabled = false;
  private destroyed = false;
  private hostedDialog: HTMLElement | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly compartment: Compartment,
    private readonly getTabId: () => string,
  ) {
    this.unsubscribe = useSettingsStore.subscribe((state, prev) => {
      const next = state.settings["editor.vim-mode"] === true;
      if (next === (prev.settings["editor.vim-mode"] === true)) return;
      if (next) void this.enable();
      else this.disable();
    });
    if (isVimSettingOn()) void this.enable();
  }

  private async enable() {
    const mod = await loadVim();
    // The import is async; the setting may have flipped back, or the view may
    // be gone, before it resolved.
    if (this.enabled || this.destroyed || !isVimSettingOn()) return;

    this.view.dispatch({ effects: this.compartment.reconfigure(mod.vim()) });
    const cm = mod.getCM(this.view);
    if (!cm) throw new Error("[vim-mode] vim() configured but no CM5 adapter on the view");

    // A fresh adapter is built on every enable, so the redirect goes with it.
    redirectVimScrollToOuterScroller(cm, this.view);
    this.cm = cm;
    this.vim = mod.Vim;
    this.enabled = true;
    clipboardBridge!.acquire();
    createTab(this.getTabId());

    cm.on("vim-mode-change", this.onModeChange);
    cm.on("vim-keypress", this.onKeypress);
    cm.on("vim-command-done", this.onCommandDone);
    cm.on("dialog", this.onDialog);
  }

  private disable() {
    if (!this.enabled) return;
    const cm = this.cm!;
    cm.off("vim-mode-change", this.onModeChange);
    cm.off("vim-keypress", this.onKeypress);
    cm.off("vim-command-done", this.onCommandDone);
    cm.off("dialog", this.onDialog);
    this.dropHostedDialog();

    // A recording is global; leaving it live behind a disabled view would
    // silently resume on the next enable. Its dialog goes away with the
    // panel below, and its close callback would focus the editor (stealing
    // focus from the Settings toggle), so it is dropped rather than run.
    const macro = this.vim!.getVimGlobalState_().macroModeState;
    if (macro.isRecording) {
      macro.onRecordingDone = undefined;
      macro.exitMacroRecordMode();
    }

    this.enabled = false;
    this.cm = null;
    this.vim = null;
    clipboardBridge!.release();
    // Reconfiguring never touches the document: caret, scroll and history
    // survive the flip.
    this.view.dispatch({ effects: this.compartment.reconfigure([]) });
    deleteTab(this.getTabId());
  }

  /**
   * Vim keeps search matches lit until `:noh`. Writer drops them on the first
   * edit or mouse click instead; `n` / `N` / `*` / `#` only move the caret
   * and keep the highlight. `:noh` dispatches, so it runs after the update.
   */
  update(update: ViewUpdate) {
    if (!this.enabled) return;
    const searchState = this.cm?.state.vim?.searchState_;
    if (!searchState?.getOverlay()) return;
    const pointer = update.transactions.some((tr) => tr.isUserEvent("select.pointer"));
    if (!update.docChanged && !pointer) return;
    queueMicrotask(() => {
      if (!this.enabled || !this.cm || !searchState.getOverlay()) return;
      // `CodeMirrorV` only narrows `state.vim` to non-null, which the
      // search-state read above already established.
      this.vim?.handleEx(this.cm as CodeMirrorV, "nohlsearch");
    });
  }

  private readonly onModeChange = (e: { mode: string; subMode?: string }) => {
    setTabMode(this.getTabId(), toVimMode(e.mode, e.subMode));
  };

  private readonly onKeypress = () => {
    setTabPending(this.getTabId(), this.cm?.state.vim?.status ?? "");
  };

  /**
   * The engine signals `vim-command-done` when it clears its input state,
   * which is *before* it runs the action or operator it just parsed. The
   * recording flag and the registers are read a microtask later so they
   * reflect the command that just finished, not the one before it.
   */
  private readonly onCommandDone = () => {
    const tabId = this.getTabId();
    setTabPending(tabId, "");
    queueMicrotask(() => {
      if (!this.enabled) return;
      const macro = this.vim!.getVimGlobalState_().macroModeState;
      setTabRecording(tabId, macro.isRecording ? (macro.latestRegister ?? null) : null);
      clipboardBridge!.syncRegisterToClipboard();
    });
  };

  /**
   * Runs after the library's own `dialog` handler, which has already parked
   * the node in its (hidden) editor panel. `appendChild` moves it into the
   * footer before the library focuses the prompt's input.
   */
  private readonly onDialog = () => {
    const dialog = this.cm?.state.dialog ?? null;
    if (!dialog) {
      this.dropHostedDialog();
      return;
    }
    if (isRecordingDialog(dialog)) return;
    const host = useVimStore.getState().dialogHost;
    if (!host) {
      console.warn("[vim-mode] no dialog host mounted; the Vim prompt has nowhere to render");
      return;
    }
    this.dropHostedDialog();
    host.appendChild(dialog);
    this.hostedDialog = dialog;
  };

  /** Prompt nodes are not removed by the library on close (only notifications
   *  are), so the host has to drop whatever it was last given. */
  private dropHostedDialog() {
    const dialog = this.hostedDialog;
    if (!dialog) return;
    this.hostedDialog = null;
    const hadFocus = dialog.contains(document.activeElement);
    dialog.remove();
    if (hadFocus && !this.destroyed) this.view.focus();
  }

  destroy() {
    this.unsubscribe();
    this.destroyed = true;
    if (!this.enabled) return;
    // The view is going away; skip the reconfigure and just release the mirror.
    this.enabled = false;
    this.dropHostedDialog();
    clipboardBridge!.release();
    deleteTab(this.getTabId());
  }
}

export function vimModeExtension(getTabId: () => string): Extension {
  const compartment = new Compartment();
  return [
    compartment.of([]),
    ViewPlugin.define((view) => new VimModePlugin(view, compartment, getTabId)),
  ];
}
