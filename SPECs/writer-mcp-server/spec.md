# Feature Specification: Writer MCP Server

**Feature Branch**: `writer-mcp-server`

**Created**: 2026-09-15

**Status**: Draft

**Input**: User description: "Implement an MCP server which would run during the Writer app and would allow me to contribute, read, list, open, and control the Writer app from Codex, Claude, or any other solution out there."

## Summary

While Writer is running, it exposes itself as a Model Context Protocol (MCP) server. Any MCP-capable agent on the same machine — Claude Code, Codex, Cursor, a custom script — can connect and work with the user's open workspaces: list and read notes, search, create and edit files, open files or workspaces in the app, and drive a small set of app actions (focus a window, open a file in a new tab or window, reveal a file in the sidebar).

This is the mirror image of [`SPECs/custom-mcp-spec.md`](../custom-mcp-spec.md), which makes Writer an MCP _client_ that calls out to user-configured tool servers. The two are independent: this spec makes Writer a _server_ that other agents call into. [`SPECs/writer-cli-spec.md`](../writer-cli-spec.md) listed "No MCP server" as a v1 non-goal; this spec is that deferred work.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Agent reads and searches the open workspace (Priority: P1)

The user has a workspace open in Writer and is working with an agent in a terminal. They ask the agent something about their notes ("what did I write about spaced repetition last week?"). The agent connects to Writer, lists the open workspaces, searches for matching notes, reads them, and answers — without the user pasting paths or file contents.

**Why this priority**: Read access is the foundation every other story builds on, and it delivers value by itself: the agent sees the notes the user is actually looking at, with Writer's own index and ignore rules, instead of crawling the disk blind. It is also the lowest-risk slice: nothing is written.

**Independent Test**: With Writer open on a workspace containing a few markdown files, connect an MCP client, call the list/search/read tools, and confirm the results match what the Writer sidebar and fuzzy search show for the same queries.

**Acceptance Scenarios**:

1. **Given** Writer is running with one workspace open, **When** an agent asks for the list of workspaces, **Then** it receives that workspace's root path and the file currently active in that window (if any).
2. **Given** a workspace with 200 markdown files, **When** the agent searches with a fuzzy query, **Then** it receives the same ranked matches the in-app search shows for that query, capped at a documented limit.
3. **Given** a note path inside an open workspace, **When** the agent reads it, **Then** it receives the note's full text as it exists on disk, including frontmatter.
4. **Given** a path outside every open workspace, **When** the agent tries to read it, **Then** the request is refused with an error that names the boundary, and nothing is read.
5. **Given** Writer has two windows open on different workspaces, **When** the agent lists workspaces, **Then** both appear and every subsequent tool call can name which one it targets.

---

### User Story 2 - Agent contributes to notes (Priority: P2)

The user asks the agent to draft or amend something ("add a summary section to today's lecture note", "create a note for this paper with these highlights"). The agent creates a new file or edits an existing one through Writer. If that file is open in a tab, the editor shows the new content immediately; if the user has unsaved edits in it, those are not lost.

**Why this priority**: "Contribute" is the half of the request that makes this more than a file browser. It carries real risk — clobbering a note the user is mid-edit on — so it is scoped second and gets the strictest rules.

**Independent Test**: With a note open in a Writer tab, have an agent write new content to it and confirm the tab updates; then type unsaved text in the tab, have the agent write again, and confirm the write is rejected and the user's text survives.

**Acceptance Scenarios**:

1. **Given** an open workspace, **When** the agent creates a new markdown file at a relative path, **Then** the file appears on disk and in the sidebar, and its content is exactly what the agent sent.
2. **Given** a note that is open in a tab with no unsaved changes, **When** the agent replaces its content, **Then** the tab shows the new content without the user doing anything.
3. **Given** a note that is open in a tab **with** unsaved changes, **When** the agent tries to write to it, **Then** the write is refused with a clear conflict error, the user's unsaved text is untouched, and the agent is told it may retry after the user saves.
4. **Given** a target path that already exists, **When** the agent calls the create tool, **Then** the call is refused rather than overwriting; a separate explicit write call is required.
5. **Given** any write, **When** it lands, **Then** Writer's own change tracking treats it the same as a save from the editor (no spurious "file changed externally" prompt, recents and index update as they would for a user save).

---

### User Story 3 - Agent opens things in the app (Priority: P2)

The agent has found or created a note and wants to show it to the user: "I've drafted the outline, opening it now." Writer brings the right window forward with that note in a tab. The agent can also ask Writer to open a folder as a workspace, either in the current window or a new one.

**Why this priority**: Closing the loop between agent output and what the user sees is what makes the integration feel like one tool. It reuses navigation the app already has, so it is cheap relative to its value.

**Independent Test**: From an MCP client, ask Writer to open a specific note; confirm the correct window is focused and the note is the active tab. Ask it to open a folder as a new workspace; confirm a new window appears rooted there.

**Acceptance Scenarios**:

1. **Given** a note inside an open workspace, **When** the agent asks to open it, **Then** the window hosting that workspace becomes the active tab's owner: the note is shown in the active tab (or a new tab if the agent asks for one) and the window comes to the front.
2. **Given** a folder not currently open, **When** the agent asks to open it as a workspace, **Then** a new window opens on that folder, or — if the folder is already open somewhere — that existing window is focused instead of a duplicate being created.
3. **Given** the agent asks to open a file that does not exist, **Then** the call fails with a not-found error and no tab or window is created.
4. **Given** the agent asks to reveal a note in the sidebar, **Then** the sidebar expands to it and highlights it, the same as the tab context-menu action.

---

### User Story 4 - User controls the integration (Priority: P3)

The user decides whether Writer listens for agents at all, sees at a glance that it is listening, and can copy the one line of configuration an agent needs to connect. When they turn it off, connected agents are disconnected and nothing new can connect.

**Why this priority**: Exposing an editor's contents to any local process is a trust decision the user must make explicitly. This must ship in v1, but it is a thin layer over the other three stories.

**Independent Test**: Toggle the setting off; confirm an MCP client cannot connect. Toggle it on; confirm it can, and that the settings surface shows the exact connection snippet that worked.

**Acceptance Scenarios**:

1. **Given** a fresh install, **When** the user opens Writer, **Then** the MCP server is off and nothing is listening.
2. **Given** the user enables the setting, **Then** the server starts within the same session (no relaunch), the settings surface shows it as running, and it shows a ready-to-paste configuration snippet for connecting an agent.
3. **Given** the server is running and an agent is connected, **When** the user disables the setting, **Then** the connection is closed and further connection attempts fail.
4. **Given** the server is enabled, **When** Writer quits, **Then** the server stops and leaves no stale listener behind that would block the next launch.

---

### Edge Cases

- **Two windows, same workspace requested**: the app already guarantees one window per workspace; tool calls that name a workspace resolve to that single window.
- **Ambiguous target**: a tool call that omits the workspace when more than one is open MUST fail with an error listing the open workspaces, not silently pick one. When exactly one workspace is open it is the default.
- **Compact / standalone windows**: a window hosting a single file with no workspace root appears in the workspace list as a file-scoped entry; reads and writes are limited to that one file.
- **Paths**: every tool accepts paths relative to a named workspace root. Absolute paths are accepted only if they resolve inside an open workspace after symlink resolution; `..` escapes are refused.
- **Non-markdown files**: reads and writes are limited to the file kinds Writer itself edits (`.md`, `.markdown`, and the other document types Writer opens in a tab). Binary assets such as images are listed but not readable or writable through this surface in v1.
- **Large files / large workspaces**: reads of very large files return an error above a documented size cap rather than stalling; list results are paginated or capped with a documented limit.
- **Concurrent agent writes to one file**: writes are serialized through the same path the editor uses; the second write sees the first's result, never an interleaving.
- **Agent writes while the file watcher is active**: a tool write MUST be recognised as Writer's own write so the external-change path does not fire on it.
- **Server fails to start** (port or socket in use, permission denied): the setting surface shows the error; the app otherwise runs normally. Failure to start the server never blocks app launch.
- **Agent connects while no workspace is open**: list returns an empty set; open-workspace is the only useful action; everything else fails with "no workspace open".

## Requirements _(mandatory)_

### Functional Requirements

**Availability and lifecycle**

- **FR-001**: Writer MUST expose an MCP server while the app is running and the feature is enabled, and MUST stop it on disable or app quit.
- **FR-002**: The server MUST be off by default and enabled by a single user-facing setting.
- **FR-003**: The server MUST start and stop within the running session without requiring a relaunch.
- **FR-004**: Failure to start the server MUST be surfaced in the settings surface and MUST NOT prevent the app from launching or opening workspaces.
- **FR-005**: The settings surface MUST show whether the server is running and MUST present a copyable configuration snippet sufficient to connect a standard MCP client.

**Discovery and connection**

- **FR-006**: The server MUST be reachable only from the local machine.
- **FR-007**: Agents MUST connect through a stdio bridge: the `writer` shell command gains an `mcp` subcommand that speaks MCP on its own stdin/stdout and forwards to the running app over a local, user-private channel. This is the only transport in v1; no network port is opened.
- **FR-008**: The bridge MUST fail fast with a clear message when Writer is not running or the server is disabled, rather than hanging or launching the app.
- **FR-008a**: The settings surface MUST show the bridge command and, if the `writer` command is not yet installed, point the user at the existing Install CLI action.

**Read tools**

- **FR-009**: Agents MUST be able to list open workspaces, receiving for each: a stable identifier, the root path, and the currently active file if any.
- **FR-010**: Agents MUST be able to list files within a workspace, honouring the same ignore rules and file-kind filter Writer's sidebar uses.
- **FR-011**: Agents MUST be able to fuzzy-search files within a workspace by path, with the same ranking as the in-app search and a documented result cap.
- **FR-012**: Agents MUST be able to read a file's full text as stored on disk.
- **FR-013**: Agents MUST be able to read the list of open tabs for a workspace and which tab is active.

**Write tools**

- **FR-014**: Agents MUST be able to create a new file with given content; creating over an existing file MUST fail.
- **FR-015**: Agents MUST be able to replace an existing file's content in full.
- **FR-016**: A write to a file that is open in a tab with unsaved changes MUST be refused with a conflict error; the user's unsaved content MUST be preserved.
- **FR-017**: A write to a file that is open in a tab without unsaved changes MUST be reflected in that tab without user action.
- **FR-018**: Every agent write MUST go through the same write path as an editor save, so change tracking, recents, and the file index behave identically.
- **FR-019**: Agents MUST be able to create a folder inside a workspace.

**Open and control tools**

- **FR-020**: Agents MUST be able to open a file inside an open workspace, either in the window's active tab or in a new tab, and bring that window to the front.
- **FR-021**: Agents MUST be able to open a folder as a workspace; if the folder is already open in a window, that window MUST be focused instead of a duplicate being created.
- **FR-022**: Agents MUST be able to reveal a file in the sidebar of its workspace window.
- **FR-023**: Agents MUST be able to focus a specific workspace window.
- **FR-024**: Agents MUST be able to open a single file in a standalone (compact) window.

**Scope and safety**

- **FR-025**: Every path-taking tool MUST resolve the path against a named workspace and MUST refuse paths that resolve outside every open workspace after symlink resolution.
- **FR-026**: When more than one workspace is open and a tool call does not name one, the call MUST fail with an error listing the candidates. When exactly one is open it MUST be the default.
- **FR-027**: Deleting or renaming files MUST NOT be available through this surface in v1.
- **FR-028**: Reads and writes MUST be limited to the document kinds Writer edits in a tab; other file kinds MAY appear in listings but MUST be refused for read and write.
- **FR-029**: Tool errors MUST be explicit and specific (not found, outside workspace, unsaved conflict, ambiguous workspace, server disabled) so an agent can recover without guessing.
- **FR-030**: Agent-originated actions MUST NOT steal focus from the user except for tools whose purpose is to open or focus something (FR-020 to FR-024).

**Documentation**

- **FR-031**: The complete tool list, each tool's inputs and outputs, and the connection instructions MUST be documented in a single doc under `docs/`, and adding a tool MUST update that doc in the same change.

### Key Entities

- **Workspace**: an open folder in a Writer window. Has a stable identifier for the session, a root path, an active file, and a set of open tabs. A compact single-file window is a degenerate workspace scoped to one file.
- **Document**: a file inside a workspace that Writer can open in a tab. Identified by its path relative to the workspace root. Has content, a dirty flag when open in a tab, and a file kind.
- **Tab**: an open view of a document in a window, with an active flag.
- **Tool call**: one agent request naming a workspace (explicit or defaulted), a tool, and arguments; yields a result or one of the enumerated errors.
- **Server status**: enabled/disabled, running/stopped/failed, and the connection details an agent needs.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A user can go from "MCP off" to a connected agent successfully reading a note in under two minutes using only the settings surface and its snippet, with no documentation lookup.
- **SC-002**: For any workspace of up to 5,000 markdown files, list, search, and read calls return in under one second on a typical laptop.
- **SC-003**: Zero cases where an agent write discards unsaved user edits, across the full acceptance suite.
- **SC-004**: 100% of tool calls that name a path outside the open workspaces are refused.
- **SC-005**: Opening a note through an agent shows it in the correct window within one second and is indistinguishable in end state from the user clicking it in the sidebar.
- **SC-006**: Toggling the server off disconnects any connected agent within one second and the app continues to run normally.
- **SC-007**: With the setting off (the default), there is no listener and no process observable from outside the app.

## Assumptions

- The target user is the app's owner running local agents (Claude Code, Codex, Cursor and similar) on the same machine; multi-user or remote access is out of scope.
- The MCP surface reuses the app's existing workspace state, file index, fuzzy search, write path, and navigation. No parallel index or second write path is introduced.
- The existing `writer` shell command hosts the stdio bridge (`writer mcp`), and the existing "Install CLI" flow covers making it available on `PATH`. The bridge is a thin proxy; all tool logic lives in the running app so there is one implementation of every tool.
- The bridge and the app must be built from the same release; a version mismatch between the two MUST be reported by the bridge rather than tolerated.
- Anyone with local access to the user's session already has the user's filesystem permissions, so the server does not authenticate callers beyond being local-only. The off-by-default setting is the trust gate.
- Tool output is plain text and structured JSON; no rendered or formatted output is needed.
- Editing granularity in v1 is whole-file replace. Partial edits (insert at heading, patch a range, append) are deferred until agents demonstrably need them; a full replace plus the unsaved-changes guard is enough for the drafting workflows described.
- Watching for changes (agent is notified when the user edits or switches files) is deferred to a later version.
- Writer's own [MCP client spec](../custom-mcp-spec.md) is unaffected and can proceed independently.

## Out of Scope (v1)

- Deleting, renaming, or moving files through the server (FR-027).
- Partial or range-based edits.
- Push notifications or subscriptions to workspace or editor changes.
- Remote or authenticated access from other machines.
- Exposing settings, theme, or other preferences for agent control.
- Reading or writing binary assets (images, PDFs, drawings) through the server.
- Bundling MCP configuration into any specific agent's config file on the user's behalf; the settings surface provides the snippet and the user pastes it.
