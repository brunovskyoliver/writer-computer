import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue } from "@codemirror/view";
import type { CodeMirror } from "@replit/codemirror-vim";
import { useSettingsStore } from "@/stores/settings-store";
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
 */

type VimModule = typeof import("@replit/codemirror-vim");

let vimModule: Promise<VimModule> | null = null;
function loadVim(): Promise<VimModule> {
  vimModule ??= import("@replit/codemirror-vim");
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

    this.cm = cm;
    this.vim = mod.Vim;
    this.enabled = true;
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

    this.enabled = false;
    this.cm = null;
    this.vim = null;
    // Reconfiguring never touches the document: caret, scroll and history
    // survive the flip.
    this.view.dispatch({ effects: this.compartment.reconfigure([]) });
    deleteTab(this.getTabId());
  }

  private readonly onModeChange = (e: { mode: string; subMode?: string }) => {
    setTabMode(this.getTabId(), toVimMode(e.mode, e.subMode));
  };

  private readonly onKeypress = () => {
    setTabPending(this.getTabId(), this.cm?.state.vim?.status ?? "");
  };

  private readonly onCommandDone = () => {
    const tabId = this.getTabId();
    setTabPending(tabId, "");
    const macro = this.vim?.getVimGlobalState_().macroModeState;
    setTabRecording(tabId, macro?.isRecording ? (macro.latestRegister ?? null) : null);
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
