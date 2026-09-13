# Data Model: Vim Mode

Three entities, matching the spec's Key Entities. Only the first two are Writer's; the
third is owned by the library and listed for completeness.

## 1. Vim mode setting (persisted, global)

One entry in `apps/desktop/shared/settings.schema.json`:

| Field         | Value                                                    |
| ------------- | -------------------------------------------------------- |
| `key`         | `editor.vim-mode`                                        |
| `label`       | `Vim Mode`                                               |
| `description` | `Modal Vim editing: Normal, Insert, Visual, Ex commands` |
| `category`    | `Editor`                                                 |
| `type`        | `boolean`                                                |
| `default`     | `false`                                                  |

Derived automatically: `SettingsMap["editor.vim-mode"]: boolean`, the Settings panel
toggle (rendered by the generic boolean control in the "Editor" section), Rust defaults
(`config.rs` reads the same JSON), persistence, and the `useBooleanSetting` accessor.

Validation: none beyond type. Transition: any → any, at any time, from Settings, the
command palette, or an external edit of the settings file (the store's existing reload
path).

## 2. Editor mode state (per tab, in-memory)

`vim-store.ts` — a Zustand store with one entry per mounted editor that currently has
Vim enabled.

```ts
type VimMode = "normal" | "insert" | "replace" | "visual" | "visual-line" | "visual-block";

interface VimTabState {
  mode: VimMode;
  /** Keys typed so far in an incomplete command, e.g. `d2`, `"a`, `ci`. Empty when idle. */
  pending: string;
  /** Register being recorded into (`q<letter>`), or null. */
  recording: string | null;
}

interface VimStoreState {
  byTab: Map<string, VimTabState>;
  /** The footer element library prompts and messages are mounted into. */
  dialogHost: HTMLElement | null;
}
```

Relationships: keyed by `tabId` (same key as `lib/editor-views.ts` registrations). The
footer reads the entry for the focused tab (`useActiveTabId()`).

Write path: only `vim-mode.ts` writes `byTab` (create on plugin construct, update on
library events, delete on plugin destroy). Only `DocumentFooter` writes `dialogHost`
(layout effect on mount/unmount).

State transitions (driven by library events):

| Event              | Effect on entry                                                          |
| ------------------ | ------------------------------------------------------------------------ |
| plugin constructed | create `{ mode: "normal", pending: "", recording: null }`                |
| `vim-mode-change`  | `mode` ← map(`e.mode`, `e.subMode`)                                      |
| `vim-keypress`     | `pending` ← `cm.state.vim.status`                                        |
| `vim-command-done` | `pending` ← `""`; `recording` ← engine's `macroModeState` (name or null) |
| plugin destroyed   | delete entry; if a dialog node is still in the host, remove it           |

Invariants:

- An entry exists iff that tab's view has the `vim()` extension configured.
- `pending` never contains a completed command (cleared on `vim-command-done`).
- Toggling the setting off deletes every entry, so no stale indicator can remain
  (SC-006).

## 3. Session Vim state (app-wide, library-owned)

`vimGlobalState` inside `@replit/codemirror-vim-core`: registers (`"`, `a`–`z`, `0`–`9`,
`_`, `+`, `/`, `:`, `.`), macro recorder state, last search query and direction, last
substitute, jump list, `:set` options. It is a module singleton, so it is shared by every
view and window of one JS context (FR-027) and discarded on quit. Writer does not
serialise it.

Writer touches it in exactly two places, both in `vim-mode.ts`:

- reads `registerController.unnamedRegister` after each command to mirror to the system
  clipboard;
- writes `unnamedRegister.setText(...)` when the window regains focus or a DOM
  `copy`/`cut` fires in the editor.

## Derived: footer view model

```ts
interface VimFooterModel {
  label: string; // "NORMAL" | "INSERT" | "REPLACE" | "VISUAL" | "V-LINE" | "V-BLOCK"
  pending: string; // shown after the label when non-empty
  recording: string | null; // shown as "recording @a" while non-null
}
```

Computed by a selector on `byTab.get(activeTabId)`; `null` when Vim is off for that
tab, which hides the indicator.
