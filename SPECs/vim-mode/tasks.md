---
description: "Task list for the Vim Mode feature"
---

# Tasks: Vim Mode

**Input**: Design documents from `SPECs/vim-mode/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/vim-mode.md, quickstart.md

**Tests**: quickstart.md names four automated test files (schema, store, ex commands, `saveNow`). Those are included; nothing beyond them (constitution VI: do not over-test UI). Key-level Vim behaviour is the library's and is validated manually per quickstart.md.

**Organization**: Tasks are grouped by user story. Stories 3–5 are almost entirely library-provided once Story 1 and Story 2 land; their phases are short and mostly verification.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US5)
- Every task names the exact file(s) it touches

## Path Conventions

Frontend only. All app paths are under `apps/desktop/`; docs under `docs/`; spec under `SPECs/vim-mode/`. Rust is untouched.

---

## Phase 1: Setup

**Purpose**: branch and dependency so every later task can import the library

- [x] T001 Create branch `vim-mode` from `master` (planning was done on `excalidraw-embed`; do not carry that branch's uncommitted work) and move the Vim task in `TODOS.md` from Up Next to In Progress with a link to `SPECs/vim-mode/spec.md`
- [x] T002 Add `"@replit/codemirror-vim": ^6.4.0` to the `catalog:` block in `pnpm-workspace.yaml` and `"@replit/codemirror-vim": "catalog:"` to `dependencies` in `apps/desktop/package.json`, then run `vp install` and confirm `node_modules/@replit/codemirror-vim/package.json` reports 6.4.0
- [x] T003 Run `vp check && vp test` on the fresh branch and record that both are green before any feature code is written

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the setting, the store, and the two small library additions every story reads from

**⚠️ CRITICAL**: US1 needs T004–T007; US2 additionally needs T008–T011

- [x] T004 [P] Add the `editor.vim-mode` entry to `apps/desktop/shared/settings.schema.json` next to the other `editor.*` entries with exactly: `key: "editor.vim-mode"`, `label: "Vim Mode"`, `description: "Modal Vim editing: Normal, Insert, Visual, Ex commands"`, `category: "Editor"`, `type: "boolean"`, `default: false`
- [x] T005 [P] Extend `apps/desktop/tests/settings-schema.test.ts` with an assertion that `editor.vim-mode` exists, has `type === "boolean"` and `default === false`, and that the generated `SettingsMap` type accepts `settings["editor.vim-mode"]` as `boolean` (follow the pattern the existing `editor.*` assertions use)
- [x] T006 [P] Create `apps/desktop/src/components/editor-area/vim-store.ts`: export `type VimMode = "normal" | "insert" | "replace" | "visual" | "visual-line" | "visual-block"`, `interface VimTabState { mode: VimMode; pending: string; recording: string | null }`, `interface VimStoreState { byTab: Map<string, VimTabState>; dialogHost: HTMLElement | null }`, `VIM_MODE_LABELS: Record<VimMode, string>` (`normal→"NORMAL"`, `insert→"INSERT"`, `replace→"REPLACE"`, `visual→"VISUAL"`, `visual-line→"V-LINE"`, `visual-block→"V-BLOCK"`), a `toVimMode(mode: string, subMode?: string): VimMode` mapper (`"visual"+"linewise"→visual-line`, `"visual"+"blockwise"→visual-block`), `useVimStore` (Zustand), write actions `createTab(tabId)`, `setTabMode(tabId, mode)`, `setTabPending(tabId, pending)`, `setTabRecording(tabId, register | null)`, `deleteTab(tabId)` (each replaces the `Map` so selectors re-run, per `docs/zustand.md`), `registerVimDialogHost(el: HTMLElement | null)`, and `useVimFooterModel(tabId: string | null): VimFooterModel | null` (`{ label, pending, recording }`, `null` when no entry). One selector, no derived state in the store.
- [x] T007 [P] Create `apps/desktop/tests/vim-store.test.ts` covering: `toVimMode` for all six inputs; `createTab` yields `{ mode: "normal", pending: "", recording: null }`; `setTabMode`/`setTabPending`/`setTabRecording` update only that tab; `deleteTab` removes it; `useVimFooterModel`'s underlying selector returns `null` for a missing tab and `{ label: "V-LINE", … }` for `visual-line`
- [x] T008 [P] Add `export function saveNow(path: string): Promise<boolean>` to `apps/desktop/src/lib/save.ts`: run `performSave` immediately ignoring the 1 s throttle; if a save for `path` is already in flight (`isSaveInFlight`), await it and then perform the follow-up save; resolve `true` when `markSaved` ran with no newer changes, `false` when the write threw (the error is already recorded on the file through the existing path — do not add a second error surface)
- [x] T009 [P] Extend `apps/desktop/tests/save.test.ts` with: `saveNow` writes before the throttle window elapses; resolves `false` and leaves the file dirty when the injected write rejects; when a throttled save is pending, `saveNow` produces exactly one final write with the latest content
- [x] T010 [P] Add `export function getEditorRegistrationForView(view: EditorView): EditorRegistration | null` to `apps/desktop/src/lib/editor-views.ts` — a linear scan over the registration map returning the entry whose `view === view`
- [x] T011 [P] Add one assertion to `apps/desktop/tests/editor-api.test.ts` (or the test file that already exercises `registerEditorView`) that `getEditorRegistrationForView` resolves a registered view and returns `null` for an unknown one

**Checkpoint**: `vp check && vp test` green; the Settings panel already shows a "Vim Mode" toggle (generic boolean control) that does nothing yet

---

## Phase 3: User Story 1 - Turn Vim mode on and edit modally (Priority: P1) 🎯 MVP

**Goal**: the setting flips every open editor into/out of Vim live, the footer shows the mode, the caret changes shape, and the core modal loop works.

**Independent Test**: Settings → Editor → Vim Mode on; `i`, type, `Esc`, `dd`, `u`, `.`, `gg`, `G` behave as Vim and the footer reads `NORMAL`/`INSERT`; toggle off and `j` inserts `j` with caret and scroll untouched; relaunch and the setting persists.

### Implementation for User Story 1

- [x] T012 [US1] Create `apps/desktop/src/components/editor-area/vim-mode.ts` exporting `vimModeExtension(getTabId: () => string): Extension`. Contents: a module-scoped cached `loadVim = () => import("@replit/codemirror-vim")` promise; a `Compartment` initialised to `[]` (the setting is read synchronously, but the library is not loaded at construction — if the setting is already on, the plugin enables after the import resolves); a `ViewPlugin` that on construction subscribes to `useSettingsStore` for `settings["editor.vim-mode"]`, and on change runs `enable(view)` / `disable(view)`; a high-precedence `EditorView.theme({ ".cm-vim-panel": { display: "none" } })`. `enable` awaits `loadVim()`, then re-reads the setting and returns early if it is now off (research R2), then `view.dispatch({ effects: compartment.reconfigure(vim()) })` and calls `createTab(tabId)`. `disable` reconfigures to `[]` and calls `deleteTab(tabId)` in the same tick. `destroy()` unsubscribes and calls `deleteTab`. Reconfigure must never touch the document.
- [x] T013 [US1] In `vim-mode.ts`, after enabling, resolve the CM5 adapter with `getCM(view)` and register listeners that mirror into the store: `vim-mode-change` → `setTabMode(tabId, toVimMode(e.mode, e.subMode))`; `vim-keypress` → `setTabPending(tabId, cm.state.vim?.status ?? "")`; `vim-command-done` → `setTabPending(tabId, "")` and `setTabRecording(tabId, Vim.getVimGlobalState_().macroModeState.isRecording ? registerName : null)`. Remove the listeners in `disable` and `destroy` (keep the handler references on the plugin instance).
- [x] T014 [US1] Wire the extension first in the array returned by `createEditorExtensions` in `apps/desktop/src/components/editor-area/editor-extensions.ts` (before every keymap, per the library README); thread a `getTabId` callback through the existing call site in `apps/desktop/src/components/editor-area/use-prosemark-editor.ts` using the tab id the hook already has
- [x] T015 [P] [US1] Add the mode indicator to `apps/desktop/src/components/editor-area/document-footer.tsx`: read `useVimFooterModel(useActiveTabId())`; when non-null render `<span data-vim-mode={label}>` with the label, followed by `pending` when non-empty and `recording @x` when `recording` is non-null, using the footer's existing `text-[13px] text-[var(--text-muted)]` typography and `gap-5` spacing; render nothing when null. Also render an always-mounted `<div data-vim-dialog-host />` and register it via `registerVimDialogHost` in a `useLayoutEffect` (unregister with `null` on unmount). Ensure the indicator and host still render in compact mode / when the footer's other content is hidden (spec edge case: never invisible while Vim is on).
- [x] T016 [P] [US1] Add `.cm-fat-cursor { background: var(--accent); color: var(--background); }` to `apps/desktop/src/components/editor-area/prosemark-theme.css` next to the existing caret rule (FR-009)
- [x] T017 [P] [US1] Add the `toggle-vim-mode` command to `apps/desktop/src/components/command-palette/index.tsx`: label `Toggle Vim Mode`, description `Command`, always available (not gated on a workspace root), `run` = `setSetting("editor.vim-mode", !current); close()`. Extend `apps/desktop/tests/command-palette.test.ts` only if it already enumerates command ids (add the id to that list; no new test otherwise).
- [ ] T018 [US1] **Handed to the user 2026-09-13** (code complete, `vp build` confirms the vim chunk is lazy: `dist/assets/dist-*.js`, 120 KB, dynamic import only). Manual validation per quickstart.md "Story 1": toggle on → `NORMAL` + block caret; motions/`5j`; `i hello Esc`; `dd u Ctrl+R .`; palette toggle off/on ten times with caret + scroll intact (SC-006); relaunch persists. Also confirm with Vim off that `vp build` puts `@replit/codemirror-vim` in its own chunk not requested at startup (SC-004). Fix anything found before moving on.

**Checkpoint**: Vim mode is usable as a modal editor with no Ex commands yet

---

## Phase 4: User Story 2 - Save and close with Ex commands (Priority: P1)

**Goal**: `:` opens a prompt in the footer; `:w`, `:q`, `:q!`, `:wq`, `:x` go through Writer's own save and tab-close paths; errors and unknown commands show in the footer.

**Independent Test**: edit, `:w` → dirty marker clears immediately and the file on disk changes; `:q` on a dirty tab refuses with `E37`; `:q!` closes and disk is unchanged; `:wq` saves and closes; `:foo` shows `Not an editor command: foo`; `Esc` cancels the prompt.

### Implementation for User Story 2

- [x] T019 [P] [US2] Create `apps/desktop/src/components/editor-area/vim-ex-commands.ts` exporting `interface VimExDeps { resolve(view): { tabId; path } | null; getOpenFile(path): { isDirty; content; diskContent } | undefined; saveNow(path): Promise<boolean>; closeTab(tabId): void; reloadFromDisk(path, raw): void; notify(view, message): void }` and `registerVimExCommands(Vim, deps): void`, idempotent via a module flag (HMR). Register with `Vim.defineEx`: `write`/`w` → `saveNow(path)`; `quit`/`q` → if `file.isDirty && file.content !== file.diskContent` then `notify("E37: No write since last change (add ! to override)")` else `closeTab(tabId)`; `q` with `params.bang` → `reloadFromDisk(path, file.diskContent)` then `closeTab(tabId)`; `wq`/`x` → `await saveNow(path)`, `closeTab` only on `true`. When `resolve` returns `null`, notify `"No file for this editor"` and do nothing.
- [x] T020 [P] [US2] Create `apps/desktop/tests/vim-ex-commands.test.ts` with a fake `Vim` whose `defineEx` records handlers, and fake deps: `:q` dirty → notifies E37 and does not close; `:q` clean → closes; `:q!` dirty → `reloadFromDisk(path, diskContent)` then `closeTab`; `:wq` with `saveNow → false` → no close; `:wq` with `true` → close; `:w` → `saveNow` called with the tab's path; `registerVimExCommands` called twice registers once
- [x] T021 [US2] In `vim-mode.ts`, after `loadVim()` resolves (once, module-scoped), call `registerVimExCommands(Vim, deps)` with real deps: `resolve` = `getEditorRegistrationForView`, `getOpenFile` = read from the workspace/open-files store, `saveNow` from `lib/save.ts`, `closeTab` and `reloadFromDisk` = the existing store actions, `notify` = `(view, msg) => getCM(view).openNotification(msg)` (rendered through the dialog host by T022)
- [x] T022 [US2] In `vim-mode.ts`, register a `dialog` handler on the CM5 adapter _after_ the plugin's own: when `cm.state.dialog` is non-null, `useVimStore.getState().dialogHost?.appendChild(cm.state.dialog)` so the node leaves the hidden `.cm-vim-panel` and lands in the footer before the library's synchronous `input.focus()` (research R3). If `dialogHost` is `null`, leave the node where it is and `console.warn` once (explicit failure, not silent). On `disable`/`destroy`, remove any dialog node still inside the host.
- [x] T023 [P] [US2] Add footer prompt styling to `apps/desktop/src/components/editor-area/prosemark-theme.css`: `[data-vim-dialog-host] .cm-vim-message { color: inherit; }` and `[data-vim-dialog-host] input { font: inherit; color: inherit; background: transparent; border: 0; outline: none; }` so the library's inline red and default input chrome are overridden (SC-007)
- [ ] T024 [US2] **Handed to the user 2026-09-13** (code complete, ex-command dispatch unit-tested). Manual validation per quickstart.md "Story 2" including the `chmod 444` save-failure case (existing save-error surface appears, tab stays dirty), `:` then `Esc`, `:foo`, and the edge case "toggle Vim off while the `:` prompt is open" (prompt disappears, typing works)

**Checkpoint**: US1 + US2 together are the shippable MVP

---

## Phase 5: User Story 3 - Search and substitute (Priority: P2)

**Goal**: `/`, `?`, `n`, `N`, `*`, `#`, `:s`, `:%s`, `'<,'>`, the `c` flag and `:noh` work with prompts in the footer and matches in the app's find colour.

**Independent Test**: note with three occurrences; `/word` Enter lands on the next, `n` twice visits the rest, `:%s/word/term/g` replaces all three and one `u` reverts.

### Implementation for User Story 3

- [x] T025 [US3] **Verified 2026-09-13: no app or library rule for `.cm-searchMatch`; both use `@codemirror/search`'s base theme.** Verify in `apps/desktop/src/components/editor-area/prosemark-theme.css` and `editor-search-extensions.ts` that Vim search decorations (`.cm-searchMatch`, set via `@codemirror/search`'s `setSearchQuery` with `forVim`) pick up the app's existing find-match colour with no new rule; add a rule only if the highlight is visibly missing
- [x] T026 [US3] **Confirmed 2026-09-13: the `c` prompt carries an `<input>`, notifications are `<div>`-wrapped, both pass the recording-dialog filter into the host. The library emits no substitution count (recorded in spec Assumptions).** Confirm the `:s///c` confirm prompt and the substitution-count notification both route through the dialog host from T022 (they are library `openDialog`/`openNotification` calls); fix relocation in `vim-mode.ts` if any prompt still appears inside the editor
- [ ] T027 [US3] **Handed to the user 2026-09-13** (code paths verified by reading the library; no automated coverage possible). Manual validation per quickstart.md "Story 3" and the coexistence case "Cmd+F find overlay and Vim `/` search do not break each other"; on `big.md`, `:%s/lorem/LOREM/g` under 1 s and one `u` reverts (SC-005)

**Checkpoint**: search and bulk edit are usable

---

## Phase 6: User Story 4 - Visual modes and scrolling (Priority: P2)

**Goal**: `v`/`V`/`Ctrl+V` selections in the app's selection colour with block `I`/`A`/`c`; `Ctrl+D/U/F/B/E/Y` and `zz`/`zt`/`zb` scroll.

**Independent Test**: `V j j d` deletes three lines; `Ctrl+V j j I - Esc` prefixes three lines; `Ctrl+D` moves the viewport about half a screen.

### Implementation for User Story 4

- [x] T028 [US4] **Verified 2026-09-13: `.cm-vimCursorLayer` is a `.cm-cursorLayer` (z-index 150) above `.cm-selectionLayer` (z-index −2); no theme change.** Verify Visual selections use `.cm-selectionBackground` → `--editor-selection-bg` in `apps/desktop/src/components/editor-area/prosemark-theme.css` and that `.cm-fat-cursor` (T016) renders correctly at the selection head in `visual-block`; adjust the theme only if the block caret is hidden by the selection layer
- [x] T029 [US4] **Done 2026-09-13: keymaps all run through one default-precedence handler placed after `vim()`, and `Ctrl+V` only reaches the `paste` DOM handler via native paste (Cmd+V). Scrolling was broken: the adapter reads `view.scrollDOM`, which does not scroll here — fixed by `vim-scroll.ts` (adapter `getScrollInfo`/`scrollTo`/`findPosV` redirected to the ancestor scroller; docs/editor.md updated).** Confirm `Ctrl+D/U/F/B/E/Y` are not intercepted by any keymap ahead of `vim()` in `apps/desktop/src/components/editor-area/editor-extensions.ts` and that `Ctrl+V` in Normal mode is not claimed by the paste path in `editor-clipboard.ts` (Cmd+V must still paste; Ctrl+V starts Visual-Block). Verify scrolling works when the editor uses the ancestor scroller set up in `editor-search-extensions.ts` / `editor-scroll.ts` (the `scrollHandler` ownership rules in `docs/editor.md`)
- [ ] T030 [US4] **Handed to the user 2026-09-13** (code complete; scroll redirect needs a runtime pass on `big.md`). Manual validation per quickstart.md "Story 4" on `big.md`, including footer labels `VISUAL`, `V-LINE`, `V-BLOCK` and `Esc` dropping the selection

**Checkpoint**: all explicitly user-named keys (`Shift+V`, `Ctrl+V`, `Ctrl+U`, `Ctrl+D`) verified

---

## Phase 7: User Story 5 - Macros, registers, marks, repeat (Priority: P3)

**Goal**: macros with a footer recording indicator, named registers, marks, counts, text objects, and the unnamed register bridged to the system clipboard.

**Independent Test**: `qa A . Esc j q` then `3@a` → lines 1–4 end with `.`; `yy` then Cmd+V in another app pastes it; copy elsewhere, return, `p` pastes it.

### Implementation for User Story 5

- [ ] T031 [US5] Add the clipboard bridge to `apps/desktop/src/components/editor-area/vim-mode.ts` (one module-scoped bridge shared by all views, installed on first enable, torn down when the last view disables): after every `vim-command-done`, read `Vim.getRegisterController().unnamedRegister.toString()`; if it differs from `lastMirrored`, set `lastMirrored` and `writeText` it via `@tauri-apps/plugin-clipboard-manager`. On `window` `focus` and on the editor DOM `copy`/`cut` events, `readText()` and, if the text differs from `lastMirrored`, `unnamedRegister.setText(text)` and update `lastMirrored`. Surface `readText`/`writeText` rejections with `console.error` (do not swallow).
- [ ] T032 [US5] Confirm the recording indicator path end-to-end: `vim-command-done` in T013 sets `recording` to the register letter (read `macroModeState.latestRegister`) and the footer (T015) shows `recording @a`; stop with `q` clears it. Fix the mirror if the library's state field differs from research R3.
- [ ] T033 [US5] Manual validation per quickstart.md "Story 5" and the coexistence cases: two panes of one note keep independent modes but share registers (FR-008, FR-027); yank → Cmd+V in another app; copy elsewhere → `p`; "toggle Vim off while recording" leaves no stale indicator

**Checkpoint**: full spec vocabulary verified

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: docs, coexistence sweep, performance, and wrap-up

- [ ] T034 [P] Add a "Vim Mode" section to `docs/keyboard-shortcuts.md`: how to enable (Settings / palette), the supported vocabulary by group (motions, operators, text objects, Visual, scrolling, search/substitute, registers/macros/marks), the Ex command table from `contracts/vim-mode.md` §4, the footer indicator, and the notes that Cmd shortcuts keep working in every mode and that motions step over hidden markdown syntax (research R6)
- [ ] T035 [P] Add `vim-mode.ts`, `vim-ex-commands.ts`, `vim-store.ts` to the file map in `docs/editor.md` (the `editor-extensions.ts` paragraph) with one line each, plus the rule that `vim()` must stay first in the extension list
- [ ] T036 [P] Add a user-facing entry to `CHANGELOG.md` for the completion date: opt-in Vim mode (Settings → Editor → Vim Mode / palette), footer mode indicator and command line, `:w`/`:q`/`:wq`/`:x`, clipboard interop
- [ ] T037 Coexistence sweep per quickstart.md "Coexistence and edge cases": Cmd+B/I/K/D/F/Z/Enter and Alt+Arrow in every mode (FR-028); Insert-mode `Enter`/`Tab`/`Shift+Tab`/autocomplete unchanged and `Esc` closes an open completion first (FR-029); `Esc` in Normal closes nothing (FR-030); table cell / mermaid / drawing widgets keep their own keys (FR-004); soft-wrapped paragraph `j`/`k` vs `gj`/`gk`. Record any deviation in `SPECs/vim-mode/spec.md` Assumptions rather than patching the library.
- [ ] T038 Performance check per quickstart.md: Insert-mode typing on `big.md` with Vim on shows no dropped frames vs. off (SC-003); startup with Vim off does not request the vim chunk (SC-004). Investigate and fix any regression before closing.
- [ ] T039 Run `vp check && vp test`; move the task in `TODOS.md` to Done; commit per `docs/workflows/agent-loop.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none
- **Foundational (Phase 2)**: after Setup. T004–T011 are all independent files and can run in parallel.
- **US1 (Phase 3)**: after T004, T006 (store), and T002 (dependency). Does not need T008–T011.
- **US2 (Phase 4)**: after US1 (needs `vim-mode.ts` and the dialog host) plus T008–T011.
- **US3, US4 (Phases 5–6)**: after US2 (prompts live in the footer host). Independent of each other.
- **US5 (Phase 7)**: after US1 (store/footer) and T013 (event mirror). Independent of US3/US4.
- **Polish (Phase 8)**: after every story you intend to ship. T034–T036 can start any time after US2.

### User Story Dependencies

- **US1 (P1)**: foundational only
- **US2 (P1)**: US1 — shares `vim-mode.ts` and the footer host
- **US3 (P2)**: US2 — the `/` prompt is the same relocation path as `:`
- **US4 (P2)**: US1 — verification only
- **US5 (P3)**: US1 — adds the clipboard bridge to `vim-mode.ts`

### Within Each Story

- Store and extension before footer rendering; footer before manual validation
- Ex-command module and its test before wiring into `vim-mode.ts`
- Every story ends with its quickstart manual pass; do not start the next story with a known failure

### Parallel Opportunities

- Phase 2: T004, T005, T006, T007, T008, T009, T010, T011 all touch different files
- Phase 3: T015, T016, T017 in parallel once T012–T014 are done
- Phase 4: T019/T020 (ex commands + test) in parallel with T023 (CSS), before T021/T022
- Phase 8: T034, T035, T036 in parallel

---

## Parallel Example: Foundational

```bash
Task: "Add editor.vim-mode entry in apps/desktop/shared/settings.schema.json"
Task: "Create vim-store.ts in apps/desktop/src/components/editor-area/"
Task: "Add saveNow to apps/desktop/src/lib/save.ts"
Task: "Add getEditorRegistrationForView to apps/desktop/src/lib/editor-views.ts"
Task: "Write tests/vim-store.test.ts, tests/settings-schema.test.ts, tests/save.test.ts additions"
```

## Parallel Example: User Story 1

```bash
# After T012–T014:
Task: "Footer indicator + dialog host in document-footer.tsx"
Task: "Fat-cursor rule in prosemark-theme.css"
Task: "Toggle Vim Mode command in command-palette/index.tsx"
```

---

## Implementation Strategy

### MVP First (US1 + US2)

1. Phase 1 → Phase 2 (all [P])
2. Phase 3 (US1): modal editing with a live toggle
3. Phase 4 (US2): `:w`/`:q`/`:wq` through Writer's save engine
4. **STOP and VALIDATE** with quickstart Stories 1–2, then commit — this is a usable Vim editor

### Incremental Delivery

- US3 and US4 are verification-heavy: run them together in one session after the MVP
- US5 adds one real piece of code (the clipboard bridge); ship it separately so a clipboard bug cannot block the rest
- Docs/changelog (T034–T036) land with the MVP commit if US3–US5 are deferred; update them again when the later stories ship

### Notes

- `vim()` goes first in the extension list; every other keymap sits behind it
- Only `vim-mode.ts` writes `byTab`; only `document-footer.tsx` writes `dialogHost`
- `Vim` is a module singleton — `defineEx` registration and the clipboard bridge are installed once, not per view
- Commit after each task or checkpoint; one task at a time in loop mode
