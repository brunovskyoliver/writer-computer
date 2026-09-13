/**
 * Bridge between Vim's unnamed register and the system clipboard (FR-024).
 *
 * The engine only touches the clipboard for the explicit `"+` register, and
 * `p` is synchronous so it cannot await a clipboard read. The bridge keeps the
 * two in step from the outside: after every Vim command the register is
 * mirrored out if it changed, and on the events that precede a `p` by human
 * time (window focus, `copy` / `cut` anywhere in the app) the clipboard is
 * read back in. `lastMirrored` is the value both sides last agreed on, so a
 * yank's own echo never overwrites the register and an unchanged clipboard
 * never re-writes it.
 *
 * Registers are a library singleton, so there is one bridge for every view;
 * `vim-mode.ts` acquires it per enabled view and it tears down with the last.
 */

export interface VimRegister {
  toString(): string;
  setText(text?: string, linewise?: boolean, blockwise?: boolean): void;
}

export interface VimClipboardDeps {
  register: () => VimRegister;
  readText: () => Promise<string>;
  writeText: (text: string) => Promise<void>;
  /** `window` and `document` in the app; injected so the bridge is testable. */
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
}

export interface VimClipboardBridge {
  acquire(): void;
  release(): void;
  /** Call after every `vim-command-done`. */
  syncRegisterToClipboard(): void;
}

export function createVimClipboardBridge(deps: VimClipboardDeps): VimClipboardBridge {
  let users = 0;
  let lastMirrored: string | null = null;
  // Reads are async IPC round trips; only the newest one may land.
  let readGeneration = 0;

  const pullClipboard = () => {
    const generation = ++readGeneration;
    deps.readText().then(
      (text) => {
        if (generation !== readGeneration || users === 0) return;
        if (text === lastMirrored) return;
        lastMirrored = text;
        // A trailing newline is what a linewise yank leaves, so paste it as
        // whole lines the way `yy` / `p` would.
        deps.register().setText(text, text.endsWith("\n"));
      },
      (error: unknown) => console.error("[vim-mode] clipboard read failed", error),
    );
  };

  return {
    acquire() {
      if (users++ > 0) return;
      deps.target.addEventListener("focus", pullClipboard);
      deps.target.addEventListener("copy", pullClipboard);
      deps.target.addEventListener("cut", pullClipboard);
      // Seed the register with whatever the user copied before turning Vim on.
      pullClipboard();
    },

    release() {
      if (users === 0) throw new Error("[vim-mode] clipboard bridge released more than acquired");
      if (--users > 0) return;
      deps.target.removeEventListener("focus", pullClipboard);
      deps.target.removeEventListener("copy", pullClipboard);
      deps.target.removeEventListener("cut", pullClipboard);
      readGeneration++;
      lastMirrored = null;
    },

    syncRegisterToClipboard() {
      if (users === 0) return;
      const text = deps.register().toString();
      // An empty register (nothing yanked yet) must not wipe the clipboard.
      if (text === "" || text === lastMirrored) return;
      lastMirrored = text;
      // A pending read from before this yank must not clobber the register.
      readGeneration++;
      deps.writeText(text).catch((error: unknown) => {
        console.error("[vim-mode] clipboard write failed", error);
      });
    },
  };
}
