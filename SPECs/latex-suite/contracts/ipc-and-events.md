# Contract: Rust Commands and Tauri Events

## New commands (`src-tauri/src/commands/latex.rs`)

| Command                | Args | Returns                | Behaviour                                                                                                                                                                                                                             |
| ---------------------- | ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `latex_snippets_path`  | —    | `String` absolute path | Ensures `<app_data_dir>/latex-snippets.js` exists: if missing, creates parent dir and writes the shipped default (`include_str!` of `shared/latex-snippets.default.js`). Never overwrites an existing file. Errors as `AppError::Io`. |
| `reset_latex_snippets` | —    | `String` absolute path | Overwrites the file with the shipped default atomically (write temp + rename, same pattern as session saves). Confirmation is the frontend's job (FR-016).                                                                            |

Both are registered in `lib.rs` `generate_handler!` and wrapped in `src/lib/tauri.ts` as `getLatexSnippetsPath()` / `resetLatexSnippets()`. Reading the file uses the existing `read_file`; writing from the tab uses the existing `write_file`.

## Changed: `Settings::reload_global()` (`config.rs`)

Re-reads the global `config` file into the global layer of an existing `Settings` (defaults and workspace layer untouched). Called by the global watcher for every window under `AppState::global_settings_file_lock`. Unit-tested with a temp dir: write key → reload → `get_global_or_default` sees it; a missing file is not an error (empty layer).

## New: global config-directory watcher (`watcher.rs`)

`start_global_config_watcher(app: AppHandle, dir: PathBuf) -> notify::Result<RecommendedWatcher>` — started once in `setup`, handle stored in `AppState` so it lives for the process. Non-recursive watch on `app_data_dir()`, same `DEBOUNCE_MS` loop as the other two watchers. For each debounced batch:

| Path (file name)    | Action                                                                                                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `latex-snippets.js` | `app.emit("fs:file-changed", FileChangeEvent { path, kind, workspace: None })` — to every window.                                                                                                                                                         |
| `config`            | For every window label in `AppState::labels()`: `reload_global()` under the global lock, then re-apply telemetry from the settings snapshot (same as `with_global_settings_mut`). Then `app.emit("settings:changed", Option::<WorkspaceIdentity>::None)`. |
| anything else       | ignored                                                                                                                                                                                                                                                   |

No self-write suppression: both consumers are idempotent on a reload of content they already hold.

## Events (frontend listeners)

| Event              | Payload                           | Existing listener change                                                                                                                                             |
| ------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `fs:file-changed`  | `{ path, kind, workspace: null }` | none — `use-file-watcher` already reloads open tabs for `workspace: null`. **New** listener in `latex-snippet-store` filters `path === filePath` and calls `load()`. |
| `settings:changed` | `WorkspaceIdentity \| null`       | `use-file-watcher`: type becomes `listen<WorkspaceIdentity                                                                                                           | null>`; `isWorkspaceEventCurrent(null, …)` is already true. |

## Frontend store API (`stores/latex-snippet-store.ts`)

```ts
useLatexSnippetStore.getState().load(): Promise<void>      // idempotent; sequence-guarded
useLatexSnippetStore.getState().reset(): Promise<void>     // reset_latex_snippets + load
useLatexSnippetStore.getState().openInEditor(): Promise<void>
useLatexSnippetStore.getState().getActiveSet(): CompiledSnippetSet
useLatexSnippetStore.getState().status: SnippetLoadStatus
```

`load()` is called from app startup (after settings hydrate, non-blocking) and from the two subscriptions. It is the single write path for `status` (Principle IV).
