# Feature Specification: PDF Viewing, Highlighting and Quote Links

**Feature Branch**: `pdf-quote-links`

**Created**: 2026-09-14

**Status**: Draft

**Input**: User description: "lets add pdf viewing and highlighting and quoting into writer.. the goal is that i can have PDF opened in split view with a md file, can drag over some text and next to the highlighted text i can press a button to refer to it on md opened.. so i can like link pdf notes with corresponding md file and its location inside it.. when clicking the quote in md file it should open the split view with a pdf and its correspoding location to the pdf section highlighed.. i can do the same with a natural selection of pdf section where no text is ... also you need to allow PDF in sidebar as a filetype.. please make sure to not cause any bottlenecks by this.. the open view on clicking quote of md file should auto detect if the PDF is already opened, in that case just find and show the user corresponding section of the pdf... make sure its not disturbing and adjust the control and theme based on the current implementation of the app"

## Summary

A PDF becomes a first-class thing you can open in Writer: it shows in the sidebar, opens in
its own tab, and sits beside a note in a split pane. Selecting text in the PDF — or dragging
a rectangle over a figure, a table, or a scanned page with no text layer — raises a small
button next to the selection that inserts a quote into the note you are reading. The quote is
plain Markdown: a blockquote of the selected text (or a short caption for a region), followed
by a link that names the PDF and the exact place inside it. Clicking that link brings the PDF
into view at that place with the region highlighted. If the PDF is already open somewhere in
the window, it is reused rather than opened again.

The whole thing is offline and file-based. The original PDF is never modified.

## Goals

- PDFs appear in the sidebar and open in a tab like any other document.
- A PDF and a note can sit side by side using the existing split-pane layout.
- Selecting PDF text, or dragging a region over it, offers a one-click "quote into note" action.
- The inserted quote is readable Markdown that means something without Writer running.
- Clicking a quote reveals the PDF at the quoted place, highlighted, reusing an already-open view.
- Opening or scrolling a large PDF never blocks typing in the note beside it.

## Non-Goals

- Writing annotations back into the PDF file. The PDF on disk is read-only to Writer.
- Indexing PDF text for workspace search or quick-open. Search stays Markdown-only.
- Editing, form filling, signing, page reordering, or exporting PDFs.
- Rendering a PDF inline inside a note. A PDF opens in a tab; notes hold links to it, not embeds.
- Cross-window resolution. A quote resolves against panes in the current window only.
- OCR of scanned pages. A page with no text layer supports region quotes, not text quotes.
- A citation manager, bibliography, or metadata extraction.
- **Showing every prior highlight when a PDF is reopened.** A note is the only place a quote is
  recorded, so painting all marks on a page would mean either a second store that can drift from
  the notes, or scanning the workspace for links on every open. Neither is worth it: highlights
  appear when you arrive from a quote, and that is the whole contract. Recorded here so it is not
  filed as a bug.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Read a PDF beside a note (Priority: P1)

A user reading a paper wants it open next to the note they are taking. They find the PDF in the
sidebar, open it, and drag it (or its tab) to the side so the note and the paper share the window.

**Why this priority**: Nothing else in this feature is reachable until a PDF can be seen at all.
On its own it already delivers value — a PDF reader that respects the app's theme and layout.

**Independent Test**: Put a PDF in the workspace, open it from the sidebar, split it beside a
note, scroll both. No quoting involved.

**Acceptance Scenarios**:

1. **Given** a workspace containing a PDF, **When** the user views the sidebar tree, **Then** the PDF is listed alongside notes and drawings.
2. **Given** a PDF in the sidebar, **When** the user opens it, **Then** it opens in its own tab showing the first page, without replacing the note that was focused.
3. **Given** an open PDF tab, **When** the user drags it to the edge of the pane holding a note, **Then** the window splits and both are visible at once.
4. **Given** a PDF open in a split beside a note, **When** the user types in the note, **Then** typing is not delayed by the PDF pane.
5. **Given** an open PDF, **When** the app theme is light or dark, **Then** the viewer chrome (toolbar, page background framing, scrollbars) follows the app's theme rather than introducing its own.
6. **Given** a PDF tab is open, **When** the user quits and relaunches, **Then** the tab is restored at the page it was left on.

---

### User Story 2 - Quote a text selection into the note (Priority: P1)

The user drags across a sentence in the PDF. A small button appears next to the selection. Pressing
it inserts a blockquote of that sentence into the note, followed by a link back to the exact spot.

**Why this priority**: This is the feature the user asked for. With Story 1 it is a complete
workflow: read, select, capture.

**Independent Test**: Open a text-layer PDF beside a note, select a sentence, press the button,
confirm the note gained a quote containing that sentence and a link naming the PDF and page.

**Acceptance Scenarios**:

1. **Given** a PDF and a note side by side, **When** the user selects text in the PDF, **Then** a quote button appears adjacent to the selection and nothing else about the layout moves.
2. **Given** a text selection with the button showing, **When** the user presses it, **Then** the selected text is inserted into the note as a blockquote followed by a link identifying the PDF, the page, and the selected range.
3. **Given** a selection spanning a page boundary, **When** the user quotes it, **Then** one quote is inserted anchored at the page where the selection starts, carrying the full selected text.
4. **Given** a note with a cursor position, **When** a quote is inserted, **Then** it lands at that cursor position and the note's undo history treats the insertion as one step.
5. **Given** no note is visible in the window, **When** the user selects PDF text, **Then** the button states that there is no note to quote into rather than inserting silently or failing without explanation.
6. **Given** the user dismisses the selection (clicks elsewhere or presses Escape), **When** the selection clears, **Then** the button disappears.

---

### User Story 3 - Jump from a quote back to the PDF (Priority: P1)

Weeks later the user reads their note, sees a quote, and clicks it. The PDF appears at that
passage with the quoted region highlighted.

**Why this priority**: A capture feature with no return trip is a one-way dump. The round trip is
what makes the note a usable index of the PDF.

**Independent Test**: Click a quote link in a note and confirm the PDF ends up visible, scrolled
to the right page, with the quoted region marked.

**Acceptance Scenarios**:

1. **Given** a note containing a quote link and that PDF is not open, **When** the user clicks the link, **Then** the PDF opens in a split beside the note and scrolls to the anchored place with the region highlighted.
2. **Given** the PDF is already open and visible in another pane of the same window, **When** the user clicks the link, **Then** that pane is reused — no new tab, no new split — and it scrolls to the anchored place.
3. **Given** the PDF is open in a background tab of some pane, **When** the user clicks the link, **Then** that tab is brought to the front of its pane and scrolled to the anchored place.
4. **Given** the PDF is already showing the anchored place, **When** the user clicks the link, **Then** the highlight is re-emphasised so the user can see where it landed, and the view does not jump.
5. **Given** the highlight has been shown, **When** a few seconds pass or the user scrolls, **Then** the emphasis fades and the page is left readable.
6. **Given** a quote link whose PDF no longer exists at that path, **When** the user clicks it, **Then** the app says the PDF could not be found and names the path. It does not open a blank viewer.

---

### User Story 4 - Quote a region where there is no text (Priority: P2)

The user wants to reference a figure, an equation image, or a page of a scanned document. They
hold a modifier (or switch to a region tool) and drag a rectangle over the area, then press the
same button.

**Why this priority**: Explicitly asked for, and it is the only way to reference scanned PDFs at
all. It is P2 only because text quoting covers the common case and can ship first.

**Independent Test**: Open a scanned PDF with no text layer, drag a rectangle, quote it, click the
resulting link, confirm the same rectangle is highlighted.

**Acceptance Scenarios**:

1. **Given** an open PDF, **When** the user drags a rectangle using the region gesture, **Then** the drawn rectangle is shown and the quote button appears next to it.
2. **Given** a drawn region, **When** the user presses the quote button, **Then** a quote is inserted into the note carrying a caption the user can edit and a link anchored to that page and rectangle.
3. **Given** a region quote link, **When** the user clicks it, **Then** the PDF scrolls to that page and the same rectangle is outlined, at any zoom level.
4. **Given** a page with no text layer at all, **When** the user drags across it, **Then** the region gesture is what happens — the user is not left with a dead text-selection gesture and no feedback.
5. **Given** a region selection, **When** the user changes the viewer's zoom, **Then** a later jump to that quote highlights the same part of the page, not a rectangle scaled to the wrong place.

### Edge Cases

- **The PDF changed since the quote was made** (new edition, re-download, re-paginated). The anchor carries the quoted text, so the app looks for that text near the recorded page and highlights it if found. If it cannot be found, the app goes to the recorded page and tells the user the passage could not be located rather than highlighting the wrong thing.
- **A region anchor in a changed PDF.** There is no text to re-match. The recorded page and rectangle are used as-is, with no claim of correctness.
- **Anchored page no longer exists** (the PDF got shorter). The user is told, and the viewer opens at the last page.
- **A very large PDF** (thousands of pages, or hundreds of megabytes). Opening shows the first page promptly; the rest render as they are scrolled to. The sidebar listing and workspace indexing are not slowed by the file's size.
- **An encrypted or password-protected PDF.** The app reports that it cannot open it. It does not prompt in a loop or show a partially rendered document.
- **A corrupt or truncated PDF.** Opening fails with a message naming the file. The tab does not hang.
- **The PDF is renamed or moved inside the workspace.** Existing quote links follow, the same way existing links to notes and drawings do.
- **The PDF is renamed outside the app.** Links break and report the missing path.
- **Two notes quote the same passage.** Both work independently; neither owns the anchor.
- **The user edits the quoted text in the note.** The note is the user's text; editing it does not break the link, and jumping still lands on the recorded anchor.
- **A quote link is clicked while the window holds only one pane.** The window splits; the note stays where it is and the PDF takes the new pane.
- **A quote link is clicked from a PDF pane** (a note is not focused). The link resolution still targets a visible note pane if one exists.
- **Selection is made in a PDF but the note pane is closed before the button is pressed.** The action reports that there is no target note.
- **Zero-width or accidental selections** (a stray click-drag of a few pixels). No button appears.

## Requirements _(mandatory)_

### Functional Requirements

**Sidebar and opening**

- **FR-001**: The sidebar MUST list `.pdf` files in the workspace tree alongside notes and drawings.
- **FR-002**: A PDF listed in the sidebar MUST NOT be treated as prose: no title extraction from its contents, and no note-only context-menu actions offered on it.
- **FR-003**: Opening a PDF MUST open it in its own tab rather than replacing the note it was opened from.
- **FR-004**: A PDF tab MUST participate in the existing split-pane layout — it can be split, moved between panes, and reordered like any other tab.
- **FR-005**: A PDF tab MUST survive session restore, reopening at the page it was last showing.
- **FR-006**: PDFs MUST NOT be added to workspace full-text search or quick-open results.

**Viewing**

- **FR-007**: The viewer MUST show continuous scrolling pages with, at minimum, page navigation and zoom.
- **FR-008**: The viewer's controls and surfaces MUST use the app's existing theme tokens and control styling, and MUST follow light/dark theme changes without a reopen.
- **FR-009**: The viewer MUST render only the pages needed for the current view, so memory and work do not scale with document length.
- **FR-010**: Rendering MUST NOT block the note editor: typing, scrolling, and saving in an adjacent note MUST remain responsive while a PDF renders.
- **FR-011**: The viewer MUST NOT modify the PDF file on disk under any circumstance.
- **FR-012**: A PDF that cannot be opened (corrupt, encrypted, unreadable) MUST show an explicit error naming the file, not an empty or partial view.

**Selecting and quoting**

- **FR-013**: Users MUST be able to select text on a PDF page where a text layer exists.
- **FR-014**: Users MUST be able to draw a rectangular region on any page, including pages with no text layer.
- **FR-015**: When a selection or region exists, a quote action MUST appear adjacent to it, positioned so it does not cover the selection, and MUST disappear when the selection is cleared.
- **FR-016**: The quote action MUST insert, at the cursor of the target note, a Markdown blockquote of the selected text (or an editable caption for a region) followed by a link that identifies the PDF and the anchored location.
- **FR-017**: The inserted text MUST be plain Markdown, meaningful when read outside Writer, and MUST be inserted as a single undoable edit.
- **FR-018**: The target note MUST be the visible note pane; when none is visible, the action MUST say so instead of inserting anywhere or failing silently.
- **FR-019**: The quoted text MUST be stored in the anchor as well as the note body, so the passage can be re-found if the PDF's pagination changes.
- **FR-020**: Region anchors MUST record page-relative coordinates that are independent of zoom level and display resolution.

**Resolving a quote**

- **FR-021**: Clicking a quote link MUST resolve the target view in this order: (a) a pane in the current window already showing that PDF — reuse it; (b) a background tab in some pane holding that PDF — bring it forward; (c) not open — open it in a split beside the note.
- **FR-022**: On resolution the viewer MUST scroll to the anchored page and visibly highlight the anchored text range or region.
- **FR-023**: The highlight MUST be temporary emphasis that fades, leaving the page readable.
- **FR-024**: When the anchor already fills the view, resolution MUST re-emphasise without scrolling the page.
- **FR-025**: When the anchored text cannot be found (PDF changed), the viewer MUST navigate to the recorded page and report that the exact passage was not located, rather than highlighting an arbitrary region.
- **FR-026**: When the PDF path does not exist, the app MUST report the missing path and MUST NOT open an empty viewer.
- **FR-027**: Renaming or moving a PDF inside the workspace MUST rewrite existing quote links, matching how the app already handles renames of linked files.
- **FR-028**: Resolution MUST be scoped to the current window.

### Key Entities

- **PDF Document**: A `.pdf` file in the workspace. Read-only to Writer. Identified by its workspace path. Has a page count and, per page, an optional text layer.
- **PDF Anchor**: A location inside a PDF Document, in one of two shapes.
  - _Text anchor_: page number, the range within that page's text, and a copy of the quoted text used to re-find the passage if the document shifts.
  - _Region anchor_: page number and a rectangle expressed in page-relative terms, independent of zoom and resolution.
- **Quote**: The user-visible result in a note — the quoted text or caption, plus a link carrying the PDF path and the Anchor. It lives in the Markdown file; the note is its home.
- **PDF View**: An open PDF in a pane. Knows which document it shows, the current page, and the zoom. Resolution targets a View, not a file.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A PDF of any supported size shows its first page within 1 second of opening on a typical workspace file.
- **SC-002**: While a 500-page PDF is open and being scrolled in a split beside a note, typing in the note shows no perceptible delay.
- **SC-003**: Memory used by an open PDF does not grow with the number of pages scrolled past — scrolling a 500-page document end to end and back leaves usage comparable to the start.
- **SC-004**: Adding PDFs to a workspace does not measurably slow sidebar listing, workspace indexing, or search compared to the same workspace without them.
- **SC-005**: Capturing a quote takes at most two actions after reading the passage: select, then press the button.
- **SC-006**: Clicking a quote whose PDF is already visible reveals the passage in under 300 ms with no new tab created.
- **SC-007**: A note containing quotes, opened in any other Markdown editor, still shows the quoted text and the name of the source PDF as readable text.
- **SC-008**: 100% of quote links whose PDF is unchanged land on the exact quoted passage.
- **SC-009**: Every failure case (missing file, corrupt file, moved passage, no target note) produces a message naming the cause. None fail silently.

## Assumptions

- Specs in this repo live under `SPECs/<name>/`, unnumbered, matching `excalidraw-embed`, `latex-suite`, and `tab-tiling-splits`.
- A PDF is a new page kind in the existing registry, the way drawings are — so it is not an "open file" in the Markdown sense and does not enter the note save path. This mirrors the drawing precedent rather than inventing a second pattern.
- Quote links use the app's existing `[[...]]` wiki-link syntax with a location suffix, so the existing link click, render, and rename-rewrite paths carry them. A separate link syntax is not introduced.
- The quote is a Markdown blockquote because that is what a quote already is in Markdown. No custom block, no HTML.
- PDFs are opened from the local filesystem only. No remote URLs, no download.
- Resolution is same-window. Multi-window exists in the app, but a link that yanks focus to another OS window is more disruptive than opening a second view.
- The region gesture is a modifier-held drag rather than a persistent mode toggle, except on pages with no text layer where dragging is a region by default.
- The viewer keeps its own page rendering but takes its chrome from the app's theme, the same accommodation made for the Excalidraw editor.
- "Not disturbing" means the quote button follows the app's existing floating-control conventions and does not shift layout; this is a convention to follow, not a threshold to measure.
- Existing PDF viewing conventions (scroll to navigate, standard zoom controls) are assumed familiar and are not re-specified.
