# Workspace switching

**Created**: 2026-10-01 · **Status**: Implemented — e2e: `apps/desktop/e2e/specs/workspace-switching.spec.js`

**Input**: "I would like to have multiple workspaces and switch between them … now I can only have one and then I need to pick the folder again … maybe drag them out so that I can have two windows with two sidebars."

**Builds on**: [`multi-window-spec.md`](multi-window-spec.md) — one process, one `WorkspaceState` per window, "a workspace already open in a window is focused, never duplicated".

## Behaviour

- **Switcher menu** (sidebar footer): every known workspace — the current one checked, those open in another window marked "— other window", then the recent ones. Picking one shows it **in this window**: the current workspace's session is saved and restored the next time it is picked. Picking one that another window has brings that window forward instead.
- **Open in New Window ▸** lists the other workspaces (and "Other Folder…"): the workspace gets its own window, sidebar and tabs. This stands in for dragging a workspace out — a native menu cannot be dragged.
- **Open Folder…** switches this window to the picked folder. **Close Workspace** as before. **Remove from List ▸** forgets a recent workspace.
- **Palette**: "Switch Workspace: <name>" for every other recent workspace, same rule as the menu. The palette re-reads the shared recents list when it opens, so a workspace first opened in another window is offered too.
- Folders sharing a name show their parent (`notes (work)`, `notes (uni)`). Up to 20 recent workspaces are kept (was 10).

## Requirements

- **FR-1**: `switchWorkspace(path)` (workspace store): focus the other window hosting `path` (`focus_workspace_window`), else close this window's workspace (session flushed) and open `path` here. `openWorkspace` keeps its "second workspace → new window" rule for the welcome screen and drops.
- **FR-2**: `workspace_windows` reports every window's workspace root and which one asked; the menu reads it and the recents list fresh on every open.
- **FR-3**: The menu is built by the pure `workspaceMenuSpec` (unit-tested); native check items come from a `check` kind in `MenuItemSpec`.

## Non-goals

- Dragging a workspace or tab out into a new window (tab tear-off; see multi-window-spec).
- Restoring several windows at launch.
