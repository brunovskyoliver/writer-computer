# Contracts: Vim Mode

Interfaces this feature exposes to the rest of the app and to the user. Anything not
listed here is an implementation detail of `vim-mode.ts`.

## 1. Setting

- Key: `editor.vim-mode` (boolean, default `false`) — declared once in
  `apps/desktop/shared/settings.schema.json`.
- Read: `useBooleanSetting("editor.vim-mode", false)` in React;
  `useSettingsStore.getState().settings["editor.vim-mode"]` elsewhere.
- Write: `setSetting("editor.vim-mode", value)` — the only write path (Settings panel,
  command palette, external file reload all go through it).

## 2. Command palette

| id                | label             | description | run                                                |
| ----------------- | ----------------- | ----------- | -------------------------------------------------- |
| `toggle-vim-mode` | `Toggle Vim Mode` | `Command`   | `setSetting("editor.vim-mode", !current); close()` |

Always available (does not depend on a workspace root).

## 3. Editor extension

```ts
// components/editor-area/vim-mode.ts
export function vimModeExtension(getTabId: () => string): Extension;
```

- Returned value goes **first** in `createEditorExtensions`' array.
- Contains: a `Compartment` (initially `[]` or `vim()` per the current setting), a
  `ViewPlugin` that owns the settings subscription, the event mirror into `vim-store`,
  the dialog relocation, and the clipboard bridge; and a high-precedence theme that hides
  `.cm-vim-panel`.
- Loads `@replit/codemirror-vim` with a dynamic import on first enable; the module
  promise is cached at module scope.
- Guarantees: reconfiguring never dispatches a document change; disabling removes the
  tab's `vim-store` entry synchronously in the same tick; the setting is re-read after
  the import resolves before enabling.

## 4. Ex commands (user-facing)

Registered once via `Vim.defineEx` from `vim-ex-commands.ts` (`registerVimExCommands(deps)`
is idempotent — a module flag prevents double registration under HMR).

| Command         | Effect                                                                                               | Message on failure                                    |
| --------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `:w`            | Save now through `lib/save.ts` (`saveNow(path)`).                                                    | existing save-error surface (`setSaveError`)          |
| `:q`            | Close the tab if the buffer equals the disk image; otherwise refuse.                                 | `E37: No write since last change (add ! to override)` |
| `:q!`           | Restore the disk image (`reloadFromDisk(path, diskContent)`), then close the tab.                    | —                                                     |
| `:wq`, `:x`     | Save now; if the write succeeded, close the tab.                                                     | as `:w`; tab stays open                               |
| everything else | Library-provided (`:s`, `:%s`, `:noh`, `:<n>`, `:g`, `:sort`, `:normal`, `:map`, `:set`, `:reg`, …). | `Not an editor command: <name>` (library)             |

Dependencies are injected so the module is unit-testable:

```ts
export interface VimExDeps {
  resolve(view: EditorView): { tabId: string; path: string } | null; // via lib/editor-views
  getOpenFile(path: string): { isDirty: boolean; content: string; diskContent: string } | undefined;
  saveNow(path: string): Promise<boolean>; // false when the write failed
  closeTab(tabId: string): void;
  reloadFromDisk(path: string, raw: string): void;
  notify(view: EditorView, message: string): void; // cm.openNotification through the footer host
}
```

## 5. Save engine addition

```ts
// lib/save.ts
export function saveNow(path: string): Promise<boolean>;
```

Runs `performSave` immediately (ignores the 1 s throttle; if a save is already in flight,
waits for it and then performs the follow-up). Resolves `true` if `markSaved` ran with no
newer changes, `false` if the write threw (error already recorded on the file).

## 6. View registry addition

```ts
// lib/editor-views.ts
export function getEditorRegistrationForView(view: EditorView): EditorRegistration | null;
```

Linear scan over the registration map (tab count is small). Used only by ex-command
callbacks, which receive the CM5 adapter (`cm.cm6` is the `EditorView`).

## 7. Vim store (read API for UI)

```ts
// components/editor-area/vim-store.ts
export const useVimStore: UseBoundStore<StoreApi<VimStoreState>>;
export function useVimFooterModel(tabId: string | null): VimFooterModel | null; // one selector
export function registerVimDialogHost(el: HTMLElement | null): void; // footer only
export const VIM_MODE_LABELS: Record<VimMode, string>;
```

## 8. DOM / CSS hooks

| Selector                                 | Owner                  | Purpose                                                                 |
| ---------------------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| `[data-vim-dialog-host]`                 | `document-footer.tsx`  | Container the library's prompt/notification nodes are moved into.       |
| `[data-vim-mode]`                        | `document-footer.tsx`  | Mode label element (value = label) — used by the e2e harness.           |
| `.cm-vim-panel`                          | theme in `vim-mode.ts` | Hidden (`display: none`); the library's in-editor panel is never shown. |
| `.cm-fat-cursor`                         | `prosemark-theme.css`  | Normal/Visual block caret, `--accent` background.                       |
| `[data-vim-dialog-host] .cm-vim-message` | `prosemark-theme.css`  | Overrides the library's inline red on error messages.                   |
| `[data-vim-dialog-host] input`           | `prosemark-theme.css`  | Footer-native prompt input (inherit font, transparent background).      |

## 9. Documentation

- `docs/keyboard-shortcuts.md`: new "Vim Mode" section listing the supported vocabulary
  by group, the Ex commands above, the footer indicator, and the note that Cmd shortcuts
  keep working and that motions step over hidden markdown syntax.
- `docs/editor.md` file map: `vim-mode.ts`, `vim-ex-commands.ts`, `vim-store.ts`.
- `CHANGELOG.md`: user-facing entry under the completion date.
