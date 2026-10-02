import type { ActionFn } from "@replit/codemirror-vim";
import { isEditorInputFrozen, runAsyncEditorInput } from "@/lib/editor-input";

type VimApi = Pick<
  typeof import("@replit/codemirror-vim").Vim,
  "defineAction" | "getRegisterController"
>;
type Cm = Parameters<ActionFn>[0];
type Register = ReturnType<ReturnType<VimApi["getRegisterController"]>["getRegister"]>;
interface PasteContext {
  continuePaste(
    cm: Cm,
    args: Parameters<ActionFn>[1],
    state: Parameters<ActionFn>[2],
    text: string,
    register: Register,
  ): void;
}
interface PasteDeps {
  readText(): Promise<string>;
  isDisposed(cm: Cm): boolean;
  notify(cm: Cm, message: string): void;
}
const registered = new WeakSet<object>();

/** Track the explicit system-register read while keeping the library's
 * count, visual, blockwise and indentation behavior in its continuation. */
export function registerVimPaste(vim: VimApi, deps: PasteDeps) {
  if (registered.has(vim)) return;
  registered.add(vim);
  vim.defineAction("paste", function (this: unknown, cm, args, state) {
    if (deps.isDisposed(cm)) return;
    if (isEditorInputFrozen()) {
      deps.notify(cm, "Editor input is paused while Writer changes workspaces.");
      return;
    }
    // continuePaste is the dependency's internal action context. Keep that
    // assumption here and test it against the installed core on upgrades.
    const context = this as Partial<PasteContext>;
    const continuation = context.continuePaste;
    if (typeof continuation !== "function") {
      throw new Error("[vim-mode] paste action context has no continuePaste");
    }
    const register = vim.getRegisterController().getRegister(args.registerName);
    if (args.registerName !== "+") {
      continuation.call(context, cm, args, state, register.toString(), register);
      return;
    }
    void runAsyncEditorInput(async () => {
      const text = await deps.readText();
      if (!deps.isDisposed(cm)) continuation.call(context, cm, args, state, text, register);
    }).catch((error: unknown) => {
      if (!deps.isDisposed(cm))
        deps.notify(cm, error instanceof Error ? error.message : String(error));
    });
  });
}
