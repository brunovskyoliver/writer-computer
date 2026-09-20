# Feature Specification: Global Content Search

**Feature Branch**: `global-content-search`

**Created**: 2026-09-20

**Status**: Draft

**Input**: User description: "Allow me to easily search in all the files for any given string — PDFs, MD files, basically everything — and get results with a preview. Follows the same UI design and structure as Cmd+P, and on the currently hovered/highlighted entry displays a preview of the line or PDF around it, showing ~5 lines around the match. Must be able to search PDFs as well."

## Clarifications

### Session 2026-09-20

- Q: Should the content-search palette also list files whose name matches the query even when the file's content doesn't? → A: Content-only — a file appears only if its body/PDF text matches; filename matching stays with `Cmd+P`.
- Q: How should search results be ordered in the list? → A: Most recently modified file first.
- Q: Should results appear progressively as files are scanned, or only once the whole workspace scan finishes? → A: Progressive — matches render as they're found and the list grows until the scan completes.
- Q: What should `Cmd+Shift+F` do in a standalone compact window, which has no workspace index? → A: Unavailable — content search requires an open workspace; the shortcut does nothing in compact windows.
- Q: What caps should bound the result counts, and should the palette disclose when results were truncated? → A: ~20 matches per file and ~200 results total, with a "results truncated" indicator shown when a cap is hit.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Search Inside Every File (Priority: P1)

The user opens a search palette, types a string, and sees every file in the workspace whose content contains it — markdown notes, plain-text files, and PDFs alike. Each result row shows the file, the matched text, and where in the file the match lives.

**Why this priority**: This is the core capability. Today only file _names_ are searchable; a user who remembers a phrase but not which document holds it has no way to find it. This story alone is a viable MVP.

**Independent Test**: Open the palette in a workspace containing markdown, text, and PDF files; type a string known to appear in each type; confirm all three surface as results with the matched text visible.

**Acceptance Scenarios**:

1. **Given** an open workspace with a phrase inside a markdown file, **When** the user opens the search palette and types that phrase, **Then** the file appears in the results with the matched line shown and the query highlighted.
2. **Given** an open workspace with a phrase inside a PDF, **When** the user types that phrase, **Then** the PDF appears in the results with the matched text and the page it occurs on.
3. **Given** a string that exists in no file, **When** the user types it, **Then** the palette shows a clear no-results state.
4. **Given** a workspace with `.gitignore` rules, **When** the user searches, **Then** ignored and hidden files do not appear in results.
5. **Given** a query that matches a file's name but no file's content, **When** the user searches, **Then** the palette shows the no-results state (filename matching stays with `Cmd+P`).

---

### User Story 2 - Context Preview on the Highlighted Result (Priority: P2)

As the user moves through the results — by arrow keys or pointer — the palette shows a preview of the currently highlighted result: roughly five lines of surrounding context around the match, so the user can judge which hit is the right one without opening anything.

**Why this priority**: The preview is what turns a list of matched lines into a usable answer. Matched lines alone are often too short to disambiguate ("the deadline" appears in six files; the surrounding paragraph tells you which one matters). It requires story 1's results to exist but is tested independently once they do.

**Independent Test**: With search results displayed, move the highlight across rows and confirm the preview updates to show ~5 lines of context centered on the match for text files, and the corresponding excerpt for PDFs.

**Acceptance Scenarios**:

1. **Given** search results are displayed, **When** the user highlights a result from a text file, **Then** a preview shows approximately five lines of the file's content around the match, with the match visually marked.
2. **Given** search results are displayed, **When** the user highlights a result from a PDF, **Then** the preview shows the text surrounding the match on its page along with the page number.
3. **Given** the highlighted result changes (arrow key or hover), **When** the selection moves, **Then** the preview updates to the newly highlighted result without opening any file.
4. **Given** a match near the start or end of a file, **When** it is highlighted, **Then** the preview shows as much context as exists without error.

---

### User Story 3 - Jump to the Match (Priority: P3)

The user activates a result (Enter or click) and lands in the file at the exact location of the match: the line for text files, the page for PDFs.

**Why this priority**: Search without follow-through forces manual hunting after the palette closes. It is P3 only because stories 1–2 already deliver standalone value.

**Independent Test**: Activate a text-file result and a PDF result; confirm each opens the file positioned at the match.

**Acceptance Scenarios**:

1. **Given** a highlighted text-file result, **When** the user presses Enter, **Then** the file opens in a tab scrolled to the matched line, with the match briefly highlighted.
2. **Given** a highlighted PDF result, **When** the user presses Enter, **Then** the PDF opens at the page containing the match.
3. **Given** the file is already open in a tab, **When** the user activates its result, **Then** the existing tab is reused and navigated to the match rather than duplicated.

---

### Edge Cases

- Files with no searchable text (images, binaries, scanned PDFs without a text layer) are skipped rather than producing empty or garbage matches.
- Very large files and very large workspaces: results are capped per file and in total so the palette stays responsive.
- A file modified or deleted between the search and result activation: activation fails gracefully or re-resolves the location rather than jumping to a stale position.
- A match spanning a PDF page boundary: the result reports the page where the match begins.
- An empty query shows a hint state, not the entire workspace as results.
- Rapid typing or re-searching must not show stale results from a superseded query.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Users MUST be able to open a dedicated content-search palette, separate from the existing filename palette, via keyboard shortcut. The palette is workspace-scoped: in standalone compact windows with no open workspace the shortcut is unavailable.
- **FR-002**: The palette MUST follow the same UI design and structure as the existing `Cmd+P` palette: a search input with a keyboard-navigable, scrollable results list.
- **FR-003**: The system MUST search the text content of every file in the open workspace, not only markdown files.
- **FR-004**: The system MUST search the extracted text of PDF files, reporting the page each match occurs on. PDF matches MUST preview as an excerpt of the page's extracted text around the match, accompanied by the page number — a rendered page image is out of scope for v1.
- **FR-005**: Each result MUST display the file identity, the matched text with the query highlighted, and the match's location (line number for text files, page for PDFs).
- **FR-006**: For whichever result is currently highlighted (via keyboard or pointer), the palette MUST display a preview of approximately five lines of surrounding context around the match.
- **FR-007**: Activating a result MUST open the file positioned at the match — the matched line for text files, the containing page for PDFs — reusing an already-open tab when one exists.
- **FR-008**: Results MUST update as the user types, debounced, without requiring an explicit submit.
- **FR-009**: Search MUST honor the workspace's ignore rules (`.gitignore`, hidden files) identical to the existing file index.
- **FR-010**: The system MUST cap results at roughly 20 matches per file and 200 results total to keep the palette responsive on large workspaces; when a cap truncates results, the palette MUST indicate that truncation rather than silently dropping matches.
- **FR-011**: Matching MUST be literal substring matching with smart-case behavior (case-insensitive unless the query contains uppercase). Search scope is bounded to files that decode as text plus PDFs; Office documents, images, and other binaries are out of scope.
- **FR-012**: Results from a superseded query MUST NOT overwrite newer results (stale responses are discarded).
- **FR-013**: The palette MUST surface content matches only: a file whose filename matches the query but whose content does not MUST NOT appear in results. Filename matching remains the job of the `Cmd+P` palette.
- **FR-014**: Results MUST be ordered by the containing file's modification time, most recently modified first; matches within the same file MUST appear in document order.
- **FR-015**: Results MUST render incrementally as matches are found — the list MAY grow until the scan completes. A scan-in-progress state MUST be visually distinguishable from a finished scan with no results, so an empty list during scanning is not mistaken for "no matches".

### Key Entities _(include if feature involves data)_

- **Search Result**: One match occurrence — the file, its location (line number or PDF page), the matched text, and the character range of the match for highlighting.
- **Context Preview**: The excerpt shown for the highlighted result — the surrounding lines of content around the match and, for PDFs, the page reference.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Users see first search results within ~250ms of typing on workspaces of a few thousand files.
- **SC-002**: 100% of matches present in text-decodable files and text-layer PDFs are reachable through search (no searchable file type is silently excluded).
- **SC-003**: Every highlighted result — text or PDF — shows a usable context preview without the user opening the file.
- **SC-004**: Users can go from opening the palette to landing on the correct match in a single interaction sequence (type, scan preview, Enter) with no intermediate file opens.

## Assumptions

- The palette opens via `Cmd+Shift+F`, consistent with the entry point defined in the earlier content-search spec; `Cmd+P` remains filename-only.
- This feature supersedes the search surface of `SPECs/fuzzy-search-grep-spec.md` (which is unimplemented); its ranking and `/`-prefix grep mode are not carried forward unless requested.
- "~5 lines around the match" means roughly five lines of total context centered on the match, not five before plus five after.
- The preview applies to whichever result is highlighted, whether the highlight came from keyboard navigation or pointer hover.
- Binary files without extractable text (images, archives, executables) and Office documents (.docx/.xlsx/.pptx) are out of scope and skipped.
- Search runs against file contents on disk; unsaved changes in dirty editor tabs are not part of the search corpus for v1.
