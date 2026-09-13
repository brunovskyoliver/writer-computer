# Feature Specification: Tab Tiling and Split Panes

**Feature Branch**: `tab-tiling-splits` (intended; not yet created — work is currently on `excalidraw-embed`)

**Created**: 2026-09-13

**Status**: Draft

**Input**: User description: "i would like to implement better tiling of tabs and windows, so i can have multiple windows opened in one writer.. i should be able to draw a file from sidebar / the top header of tabs and drag it into the canvas and release and would do vertical / horizontal split of the current tab on which i release it.. on dragging and holding it would preview using obsidian like bg fill with smaller opacity and orange color the space in which the tab would be placed.. i can have split vertical / horizontal view, each can have its own tab bar where i can drag tabs into and click throughout them.."

## Overview

Today a Writer window shows one editor area with one tab strip: exactly one document is
visible at a time. This feature lets a window be tiled into several editor panes, each with
its own tab strip and its own active document, so two or more notes are readable side by
side. Panes are created by dragging — a file from the sidebar, or a tab from any tab strip —
and dropping it against an edge of an existing pane. While dragging, the region the document
would land in is highlighted so the result is visible before releasing.

"Multiple windows inside one Writer" in the user description means multiple editor panes
inside one OS window. Separate OS windows already ship (see
[`SPECs/multi-window-spec.md`](../multi-window-spec.md)); dragging a tab out into a new OS
window (tear-off) stays a non-goal here.

## Clarifications

### Session 2026-09-13

- Q: Should dragging a tab outside the Writer window tear it off into a new OS window, or do nothing? → A: No tear-off — the drag cancels and the layout is unchanged. Splits are in-window only.
- Q: With one note open in two panes, does scrolling one pane move the other? → A: No — scroll position and cursor are per pane, so the two views are independent.
- Q: With one note open in two panes, do edits in one appear in the other, or are they separate copies? → A: One shared buffer — edits are live in every pane, with a single dirty state, save, and reload notice.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Split a pane by dragging a file from the sidebar (Priority: P1)

A user reading a note wants their reference note open beside it. They press on the file in
the sidebar's file tree, drag it over the editor area, hold near the right edge of the pane
showing their note, see the right half of that pane highlighted, and release. The editor
area is now two panes side by side: the original note on the left, the reference on the
right, each with its own tab strip.

**Why this priority**: This is the core value of the feature — two documents visible at
once — and it is reachable with one gesture from the app's primary navigation surface. On
its own it is a complete, useful product.

**Independent Test**: Open a workspace, open one note, drag a second file from the sidebar
to the right edge of the editor pane, release. Two panes are visible, each showing the
expected document, and both are editable.

**Acceptance Scenarios**:

1. **Given** a window with one pane showing note A, **When** the user drags file B from the
   sidebar and releases it over the right edge region of that pane, **Then** the pane splits
   vertically into two panes of equal width, A on the left, B on the right, and B's pane is
   focused.
2. **Given** the same starting state, **When** the user releases over the bottom edge region,
   **Then** the pane splits horizontally, A on top and B below.
3. **Given** the same starting state, **When** the user releases over the centre region of
   the pane, **Then** no split occurs and B opens as a new tab in that pane, becoming its
   active tab.
4. **Given** a drag in progress, **When** the user releases outside the editor area and
   outside the sidebar tree, **Then** nothing changes — no split, no move, no tab opened.
5. **Given** a drag that started in the sidebar, **When** the pointer is over the sidebar
   file tree, **Then** the existing move-file-on-disk behaviour applies and no split preview
   is shown; the split preview appears only once the pointer enters the editor area.

---

### User Story 2 - Move a tab between panes by dragging it (Priority: P1)

With two panes open, the user drags a tab out of the left pane's tab strip and drops it into
the right pane's tab strip. The document moves to the right pane, keeping its unsaved edits,
scroll position, and back/forward history. Dropping it against an edge of a pane instead of
onto a tab strip splits that pane.

**Why this priority**: Without it, a layout can only be built and never rearranged, and a
mistaken split can only be undone by closing tabs. It shares the drop-target machinery with
Story 1, so it is the natural second half of the same slice.

**Independent Test**: With two panes open, drag a tab from one strip to the other and
confirm the document, its dirty state, and its history moved intact.

**Acceptance Scenarios**:

1. **Given** two panes each with tabs, **When** the user drags a tab from pane 1 and drops it
   on pane 2's tab strip, **Then** the tab is removed from pane 1, appended at the drop
   position in pane 2, becomes pane 2's active tab, and pane 2 gains focus.
2. **Given** a tab with unsaved changes, **When** it is moved to another pane, **Then** the
   unsaved content, the dirty indicator, the cursor position, and the back/forward history
   travel with it and no save or reload is triggered by the move.
3. **Given** a pane with exactly one tab, **When** that tab is dragged into another pane,
   **Then** the emptied pane is removed and its space is given to its sibling.
4. **Given** a tab dragged within its own strip, **When** it is dropped at another position
   in the same strip, **Then** the tabs reorder and no split occurs.
5. **Given** a tab dragged from a strip, **When** it is dropped over the edge region of any
   pane, **Then** that pane splits and the tab becomes the only tab of the new pane.
6. **Given** a drag that begins on a tab, **When** the pointer moves, **Then** the OS window
   does not move with it — the tab strip's window-drag behaviour is suppressed for the
   duration of the drag.

---

### User Story 3 - Drop preview while dragging (Priority: P1)

While a file or tab is being dragged over the editor area, the exact region the document
would occupy is filled with a translucent orange overlay: the right half of a pane for a
vertical split, the bottom half for a horizontal split, the whole pane body for "open as a
tab here", and the insertion gap in a tab strip for a reorder or move.

**Why this priority**: The gesture is ambiguous without it — edge versus centre is invisible
— so the preview is what makes Stories 1 and 2 usable rather than guesswork. It ships with
them.

**Independent Test**: Start a drag and move the pointer across a pane's edges and centre;
the highlighted region changes to match the split that would result, and matches what
actually happens on release.

**Acceptance Scenarios**:

1. **Given** a drag in progress, **When** the pointer sits in a pane's left, right, top, or
   bottom edge region, **Then** that half of the pane is filled with the translucent orange
   overlay.
2. **Given** a drag in progress, **When** the pointer moves from an edge region to the pane
   centre, **Then** the overlay grows to cover the whole pane body, indicating the document
   opens as a tab in that pane.
3. **Given** a drag in progress, **When** the pointer leaves the editor area entirely,
   **Then** no overlay is shown anywhere.
4. **Given** a drag in progress, **When** the pointer is over a region where the drop is not
   allowed, **Then** no overlay is shown, and releasing performs no change.
5. **Given** any drag ends — by release, by pressing Escape, or by the pointer being
   cancelled — **Then** every overlay is removed.

---

### User Story 4 - Work across panes (Priority: P2)

With a layout in place the user clicks between panes and their tabs, types in either one,
opens files from the sidebar into whichever pane they last used, resizes a split by dragging
the divider between panes, and closes tabs until a pane empties and collapses.

**Why this priority**: The layout has to behave like an editor once it exists, but each of
these follows from a layout already being on screen, so they come after the gesture that
creates one.

**Independent Test**: Build a two-pane layout, then click, type, resize, and close in both
panes and confirm each acts on the intended pane only.

**Acceptance Scenarios**:

1. **Given** two panes, **When** the user clicks in a pane's body or on one of its tabs,
   **Then** that pane becomes the focused pane and keyboard input goes to it.
2. **Given** a focused pane, **When** the user opens a file from the sidebar, the command
   palette, a wiki link, or the recents list, **Then** it opens in the focused pane, obeying
   the existing rules for whether it replaces the current tab or opens a new one.
3. **Given** two panes, **When** the user drags the divider between them, **Then** the panes
   resize continuously, neither shrinks below a readable minimum width or height, and the
   sizes persist across a restart.
4. **Given** a pane with one tab, **When** that tab is closed, **Then** the pane is removed
   and its sibling takes over the space; when the last pane's last tab is closed, the window
   falls back to its existing empty/launcher state rather than showing nothing.
5. **Given** the same file open in two panes, **When** the user edits it in one, **Then** the
   other pane shows the same edits and the same dirty state, because both views share one
   document buffer.
6. **Given** the same file open in two panes, **When** the user scrolls or moves the cursor
   in one, **Then** the other pane's scroll position and cursor stay where they were.
7. **Given** a tiled layout, **When** the app is quit and reopened, **Then** the layout — its
   splits, their sizes, each pane's tabs and active tab, and the focused pane — is restored.

---

### Edge Cases

- Dragging a folder from the sidebar into a pane: not a document, so no drop is offered.
- Dragging a multi-selection of files from the sidebar into a pane: all selected files open
  in the resulting pane, the first as its active tab.
- Dropping a file into a pane that already has that file open: the existing tab is focused
  rather than duplicated; dropping it on an _edge_ still creates a split showing that file,
  since a deliberate side-by-side of the same document is a legitimate ask.
- A pane too small to have distinct edge and centre regions: edge regions never consume more
  than a fixed fraction of the pane, so a centre target always remains reachable.
- Splitting past the point where panes are readable: a split is refused when either resulting
  pane would fall below the minimum readable size, and no drop target is offered there.
- A pane's only tab dragged onto that same pane's own edge: no drop target is offered there,
  so no overlay appears and releasing changes nothing — splitting would immediately collapse
  the emptied source half.
- A dragged tab's file is deleted or renamed on disk mid-drag: the drag ends with no change,
  and the existing file-removed handling applies.
- Escape pressed mid-drag, or the pointer capture lost: the drag cancels with no layout
  change.
- Restoring a session whose saved layout references files that no longer exist: those tabs
  are dropped as they are today; a pane left with no tabs is removed from the restored
  layout.
- Restoring a session saved by an older version, which has a flat tab list and no layout:
  it restores as a single pane containing those tabs.

## Requirements _(mandatory)_

### Functional Requirements

**Layout model**

- **FR-001**: A window's editor area MUST be a tree of panes joined by vertical and
  horizontal splits, with a single pane as the default and simplest case.
- **FR-002**: Each pane MUST own an ordered list of tabs, one active tab, and its own tab
  strip; every tab MUST belong to exactly one pane.
- **FR-003**: Exactly one pane MUST be the focused pane at any time, and the focused pane
  MUST be visually distinguishable from the others.
- **FR-004**: A tab's navigation history (back and forward) MUST travel with the tab when it
  moves between panes.
- **FR-005**: A document opened in more than one pane MUST be backed by a single shared
  buffer, so content, dirty state, save results, and disk-reload notices are identical in
  every pane showing it.
- **FR-006**: Per-view state — scroll offset and cursor position — MUST belong to the tab
  rather than to the document, so two panes showing the same file scroll and place their
  cursors independently while sharing one buffer.
- **FR-007**: When a pane's last tab is closed or moved away, the pane MUST be removed and
  its space redistributed to its sibling; when the last pane empties, the window MUST fall
  back to its existing empty state.
- **FR-008**: Splits MUST be resizable by dragging the divider between panes, and MUST
  enforce a minimum pane size below which no pane may be shrunk or created.

**Drag sources and drop targets**

- **FR-009**: A file row in the sidebar file tree MUST be draggable into the editor area, in
  addition to its existing drag-to-move-on-disk behaviour within the tree.
- **FR-010**: The drop behaviour of a sidebar drag MUST be decided by where it is released:
  released inside the sidebar tree it moves the file on disk as it does today; released in
  the editor area it opens the file, and MUST never do both.
- **FR-011**: A tab in any tab strip MUST be draggable, and MUST be droppable onto a tab
  strip (to move or reorder), onto a pane edge (to split), or onto a pane centre (to move
  into that pane).
- **FR-012**: Each pane MUST expose four edge drop regions and one centre drop region;
  releasing on the left or right edge MUST produce a vertical split, on the top or bottom
  edge a horizontal split, and in the centre MUST add the document to that pane's tabs.
- **FR-013**: A new pane created by a split MUST start at an equal share of the split
  document space and MUST become the focused pane.
- **FR-014**: Dropping a tab back where it came from, or releasing outside every valid drop
  target, MUST leave the layout unchanged.
- **FR-015**: A drag that starts on the tab strip MUST NOT move the OS window, even though
  the strip is otherwise a window-drag surface.
- **FR-016**: A drag MUST be cancellable with Escape and MUST clean up fully if the pointer
  interaction is interrupted.

**Drop preview**

- **FR-017**: While a drag is over a valid drop target, the system MUST fill exactly the
  region the document would occupy with a translucent orange overlay — the affected half of
  a pane for a split, the whole pane body for a tab drop, the insertion gap for a tab-strip
  drop.
- **FR-018**: The overlay MUST update as the pointer crosses region boundaries, MUST be
  absent whenever there is no valid target, and MUST be removed when the drag ends by any
  means.
- **FR-019**: The overlay MUST remain legible in both light and dark themes and MUST NOT
  obscure the text underneath it.

**Routing and persistence**

- **FR-020**: Opening a file by any existing route that does not name a pane — sidebar click,
  command palette, recents, wiki link, search result, drawing embed — MUST open it in the
  focused pane under the existing rules for replacing versus adding a tab.
- **FR-021**: The pane layout — split structure, split sizes, each pane's tabs and active
  tab, and the focused pane — MUST be saved with the session and restored on relaunch.
- **FR-022**: A session saved before this feature, holding a flat tab list, MUST restore as a
  single pane containing those tabs with the previously active tab selected.
- **FR-023**: Each OS window MUST have its own independent pane layout, and no drag may cross
  between OS windows.
- **FR-024**: A drag released outside the Writer window MUST cancel with no change — no new
  OS window is created and the tab stays where it was.

### Key Entities

- **Pane**: One editor viewport. Holds an ordered list of tabs, which of them is active, and
  its own tab strip. Is a leaf of the layout tree.
- **Split**: A join of two or more child nodes — panes or further splits — with an
  orientation (side by side, or stacked) and a relative size for each child.
- **Layout**: The root of the pane tree for one window, plus which pane has focus.
- **Tab**: An open document view within a pane: its location, its active/inactive state, and
  its back/forward history. Already exists; gains a pane it belongs to.
- **Drop target**: A resolved intent for the current pointer position during a drag — a pane
  plus a region (one of four edges, or the centre), or a tab strip plus an insertion index —
  which determines both the preview overlay and the action taken on release.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A user can go from one document open to two documents side by side in a single
  uninterrupted drag gesture, with no menu, dialog, or keyboard step.
- **SC-002**: The highlighted preview region matches the resulting layout in 100% of drops —
  no drop produces a layout other than the one previewed.
- **SC-003**: Moving a tab between panes preserves its unsaved content, cursor position, and
  navigation history in 100% of cases, and never triggers a save or a disk reload.
- **SC-004**: Typing stays responsive with four panes open on documents of typical size —
  no perceptible added input lag versus a single pane today.
- **SC-005**: A tiled layout survives quit and relaunch intact — same splits, same sizes,
  same tabs, same active tab per pane — for every layout the user can build.
- **SC-006**: Existing single-pane use is unchanged: with one pane open, every current tab,
  sidebar, and file-open behaviour works exactly as before, including the sidebar's
  drag-to-move-file gesture.

## Assumptions

- "Multiple windows opened in one Writer" means multiple editor panes inside one OS window.
  Separate OS windows already exist; tearing a tab off into a new OS window is out of scope
  here and remains the future work recorded in `SPECs/multi-window-spec.md`.
- Splits nest arbitrarily (a pane can be split again), but there is no need for a saved
  named-layout or preset-layout feature.
- Panes within a window share one workspace; opening a different workspace still opens a new
  OS window as it does today.
- The sidebar's `Pinned` and `Recents` rows are not drag sources today; that stays true, so
  only `Everything`-tree file rows can be dragged into a pane.
- Keyboard shortcuts for splitting and for moving focus between panes are not part of this
  feature; they are an obvious follow-up once the layout model exists.
- The initial split ratio is even; remembering a user's preferred ratio per split beyond the
  session is not required.

## Dependencies and Inherited Constraints

These are facts about the platform and the shipped code that this feature must live with.
They are recorded so the planning phase neither re-derives them nor quietly works around
them; none of them is a design choice made by this spec.

- Drag must use pointer events rather than HTML5 drag-and-drop. OS drag-drop is enabled on
  the Tauri window for the Finder-drop-to-open feature, and while it is enabled the webview
  suppresses HTML5 drag events. The shipped sidebar drag already works this way; see
  `SPECs/sidebar-drag-and-drop-move-spec.md`.
- The drop overlay reuses Writer's existing accent colour at low opacity — the orange
  Obsidian-style fill the user described — rather than introducing a new colour token.
- Session state is written to a JSON file in app data shared by every window, and concurrent
  writes from two windows already race at the filesystem layer
  (`SPECs/multi-window-spec.md`). The layout persistence in FR-021 inherits that race.
  Fixing it is out of scope here.

## Non-Goals

- Tearing a tab off into a new OS window, and dragging between two OS windows.
- Saved or preset layouts, and a layout picker.
- Keyboard shortcuts for creating splits or navigating between panes.
- Stacked/grouped tabs, pinned tabs, or tab overflow menus beyond what exists today.
- Linked scrolling or any other synchronisation between two panes showing the same document.
