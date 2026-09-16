# Feature Specification: Color Highlights in Formulas and Prose

**Feature Branch**: `formula-highlight-colors`

**Created**: 2026-09-16

**Status**: Draft

**Input**: User description: "allow me to highlight text in md file — in these formulas a couple of things which correspond to the next line's formula, so I can separate and visualise the results of parts of the formulas and what is happening to them during the calculation. There should be a tooltip when I highlight text, to choose the colour the text underscores itself with. It should be parsed into the rendered LaTeX result. Make it work on non-LaTeX md files also."

## Context

The user works through multi-step derivations written as consecutive `$$…$$` blocks. To follow a term across steps — `\cos(4*1.190)` on line one becoming part of `41 - 840j` on line two — they want to paint matching fragments in the same colour, in the source **and** in the rendered formula above it. The same gesture must work in ordinary prose, where no math is involved.

The colour is the only link between two fragments: two things painted the same colour are "the same thing" to the reader. Nothing in the document records that relationship beyond the shared colour.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Colour a fragment of a formula (Priority: P1)

The user places the cursor inside a math block so the source unfolds, selects part of the formula, and a small colour bar appears beside the selection. Picking a colour writes the colour into the document and the rendered formula above immediately shows that fragment in that colour.

**Why this priority**: This is the feature. Everything else is a refinement of it.

**Independent Test**: Open a note with `$$(2+5j)^4=(\sqrt{24})^4(\cos(4*1.190)+\sin(4*1.190)j)$$`, select `\cos(4*1.190)`, pick amber, and confirm the rendered output shows that sub-expression in amber while the rest is unchanged.

**Acceptance Scenarios**:

1. **Given** the caret is inside a `$$…$$` block and a fragment of the formula is selected, **When** the user picks a colour from the bar, **Then** the document text is rewritten so the fragment carries that colour, and the rendered formula repaints with only that fragment coloured.
2. **Given** a fragment was coloured on line one, **When** the user colours a fragment of the next formula with the same colour, **Then** both render in that colour and the correspondence is visible by colour alone.
3. **Given** a selection with unmatched _parentheses_ — `\cos(4*1.190` inside `(\sqrt{ 24 })^4(\cos(4*1.190)+…)` — **When** the user picks a colour, **Then** exactly that range is coloured with no expansion, because parentheses are ordinary characters and the formula still renders.
4. **Given** a selection crossing a _brace_ boundary — starting inside `\sqrt{ 24 }` and ending after its `}` — **When** the user picks a colour, **Then** the written range is expanded outward to the nearest boundary that leaves the formula parseable, the expanded range is visible to the user, and the formula still renders (it never falls back to an error or raw source).
5. **Given** a selection whose enclosing group cannot be safely expanded inside the math block, **When** the user picks a colour, **Then** the document is left unchanged and a notice explains that the selection is not a colourable fragment.
6. **Given** an inline `$…$` formula, **When** a fragment is selected and coloured, **Then** it behaves exactly as the display-block case.

---

### User Story 2 - Colour plain prose (Priority: P1)

The same selection bar appears for a selection in ordinary Markdown text, and picking a colour highlights that run of text in both the editor and any other Markdown reader.

**Why this priority**: The user asked for it explicitly, and it is the same gesture with a different emitter — shipping only the math half would leave the second half to be bolted on later.

**Independent Test**: Select a sentence in a note with no math, pick green, and confirm the text shows in green in the editor and still reads as highlighted when the file is opened in another Markdown tool.

**Acceptance Scenarios**:

1. **Given** a selection in prose, **When** the user picks a colour, **Then** the selected text takes that colour in the editor.
2. **Given** a selection that spans a Markdown construct boundary (part of a link, part of a bold span), **When** the user picks a colour, **Then** the surrounding construct still renders correctly.
3. **Given** a coloured run of prose, **When** the file is opened in another Markdown reader, **Then** the text is still visible in its colour rather than showing as stray syntax.

---

### User Story 3 - Recolour and remove (Priority: P2)

A colour is a decision the user revises while working through a derivation.

**Why this priority**: Without removal the feature is one-way and the user has to hand-edit the source to undo a mistake — but the feature delivers value before this lands.

**Independent Test**: Colour a fragment, select it again, pick a different colour, then remove it entirely, and confirm the source returns to exactly its original text.

**Acceptance Scenarios**:

1. **Given** the selection covers an existing highlight, **When** the bar appears, **Then** the currently applied colour is shown as active and a remove action is offered.
2. **Given** an existing highlight, **When** the user picks a different colour, **Then** the highlight changes colour without nesting a second highlight inside the first.
3. **Given** an existing highlight, **When** the user removes it, **Then** the text is restored byte-for-byte to what it was before the highlight was applied.
4. **Given** any colour, recolour or remove action, **When** the user presses undo once, **Then** the whole action is reverted in a single step.

---

### User Story 4 - Keyboard and palette access (Priority: P3)

The colours are reachable without the mouse.

**Why this priority**: A nicety that makes repeated use fast; the feature is complete without it.

**Independent Test**: With a selection active, apply the default colour from the keyboard and confirm the same result as clicking it in the bar.

**Acceptance Scenarios**:

1. **Given** a selection, **When** the user invokes the highlight command from the command palette, **Then** the colour bar opens focused, navigable by arrow keys, and applies on Enter.
2. **Given** the colour bar is open, **When** the user presses Escape, **Then** it closes and the document is unchanged.

---

### Edge Cases

- An empty selection (caret only): no bar appears.
- A selection that spans out of a math block into surrounding prose: treated as prose, and the math delimiters are not swallowed into the highlight.
- A selection inside a fenced code block or inline code: no bar appears — code is literal text and must not gain markup.
- A selection already entirely inside another highlight: recolours that highlight rather than nesting.
- A selection partially overlapping an existing highlight: the resulting text has one highlight per region and no unbalanced or orphaned markup.
- A multi-line selection inside one math block: allowed, since math blocks wrap freely.
- A multi-paragraph selection in prose: each paragraph is highlighted separately so no block boundary is crossed by a single span.
- A highlight colour that a malformed or hand-edited document contains but the palette does not: rendered as written, and the bar shows no active colour rather than silently rewriting it.
- A document edited externally while the bar is open: the bar closes rather than writing to a stale position.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The editor MUST show a colour bar anchored beside a non-empty text selection, offering the palette colours and a remove action.
- **FR-002**: The bar MUST NOT appear for an empty selection, for a selection inside code (fenced or inline), or in a read-only surface.
- **FR-003**: Choosing a colour MUST write the highlight into the Markdown file itself. No highlight may live in a database, sidecar file, or app-private store.
- **FR-004**: A highlight MUST colour the text itself — the glyphs — in both contexts. It MUST NOT paint a background box in one context and coloured glyphs in the other.
- **FR-005**: In math context the highlight MUST be written as a LaTeX colour command that keeps its content in math mode, so the rendered formula is identical to the uncoloured one except for the colour of the chosen fragment.
- **FR-006**: In prose context the highlight MUST be written as inline HTML carrying the same colour as a text colour, so other Markdown readers still show the text and its colour.
- **FR-007**: The context (math vs prose) MUST be decided from the selection's position in the document, and the two emitters MUST be the only difference between the two cases — one highlight concept, one command, one palette, one place to add a colour.
- **FR-008**: Before writing in math context, the system MUST expand the selection outward to the nearest boundary at which the enclosing expression stays balanced and parseable. Unmatched parentheses are not a reason to expand. The expansion MUST stop at the enclosing group, and when the applied range differs from what the user selected, the user MUST be able to see the range that was actually coloured.
- **FR-009**: If no such expansion exists inside the enclosing math block, the system MUST leave the document unchanged and surface a notice. It MUST NOT write text that makes the formula fail to render.
- **FR-010**: The rendered math output MUST show the highlight colour without enabling any renderer capability that would let document text emit arbitrary markup or links.
- **FR-011**: Colouring, recolouring and removing MUST each be a single undo step.
- **FR-012**: Removing a highlight MUST restore the exact text that was there before the highlight was applied.
- **FR-013**: Applying a colour to a selection that already carries one MUST replace that colour rather than nest a second highlight.
- **FR-014**: The palette MUST be a fixed set of colours defined in exactly one place, each chosen to remain legible against both the light and dark editor backgrounds.
- **FR-015**: The editor MUST display existing highlights in the unfolded source as well, so a fragment's colour is visible while editing it.
- **FR-016**: When the caret is outside a highlight, the editor MUST conceal the highlight's markup and show only the coloured text, the same way the editor already conceals other inline markup; the markup MUST reappear when the caret enters it.
- **FR-017**: The bar MUST resolve its target position at the moment the colour is picked, not when the selection was made, and MUST close without writing if that position is no longer valid.
- **FR-018**: A highlight command MUST be reachable from the command palette; if a keyboard shortcut is added, `docs/keyboard-shortcuts.md` is updated in the same change.

### Key Entities

- **Highlight**: a contiguous run of document text plus one palette colour. Has no identity, no name, and no stored relationship to any other highlight — sameness of colour is the only link the reader gets.
- **Palette colour**: one entry in the fixed set. Has a stable display name (shown in the bar), a literal colour value (written into the document), and is legible on both themes.
- **Highlight context**: math or prose, derived from where the selection sits. Selects which text form is written and which safety rule applies before writing.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A user can colour a fragment of a formula in under 3 seconds from having the text selected: select, pick, done — no dialog, no menu drill-down.
- **SC-002**: 100% of colour applications either render correctly or leave the document untouched with an explanation. No application produces a formula that fails to render.
- **SC-003**: Every coloured fragment appears in its colour in the rendered formula within the same frame budget as an ordinary edit — no visible flash of uncoloured or unrendered output.
- **SC-004**: A file with highlights, opened in another Markdown application, shows 100% of the coloured text as readable content; none of it shows as raw syntax or disappears.
- **SC-005**: Removing every highlight from a document returns the file byte-for-byte to its pre-highlight state.
- **SC-006**: All palette colours pass a legibility check against both the light and dark editor backgrounds.

## Assumptions

- Highlights are applied to **unfolded source** with the caret inside the block — the gesture shown in the user's screenshot. Selecting text in the rendered formula and mapping it back to source is a different and much harder problem; see Out of Scope.
- The colour is written as a literal value rather than a theme-aware name, because the file must render the same way in Obsidian, on GitHub, and in any other Markdown reader (Constitution I). The palette is therefore chosen for cross-theme legibility rather than for maximum contrast in either theme alone.
- Prose highlights use inline HTML because the common `==text==` convention carries no colour and multi-colour prose highlighting is the requested behaviour. It is verbose in source, which is why FR-016 conceals it.
- Colour is applied to the glyphs rather than as a background box. A background in math would force the fragment to be re-entered as standalone math, which many partial selections (a lone exponent, half a fraction) cannot satisfy — the refusal path would become the common case instead of the exception.
- The existing selection-anchored control in the PDF viewer is the precedent for the bar's placement and its resolve-target-at-press-time rule; this feature does not invent a second popover pattern.
- The existing LaTeX source parser already used for math token highlighting is the basis for the balanced-expansion rule in FR-008; no new parser is introduced.
- Six palette colours are enough for the derivation-tracking use case. This is a starting number, not a constraint on the design.

## Out of Scope

- Selecting text in the rendered KaTeX output and colouring it from there.
- Any engine that links two fragments by identity, cross-references them, or navigates between them. Same colour is the whole mechanism.
- Custom / arbitrary colours via a colour picker.
- A panel listing all highlights in a document, or search by highlight colour.
- Nested or overlapping highlights rendering as blended colours.
- Background/marker-pen style highlighting. The colour is on the text.
- Highlighting inside code blocks.
- Any per-document or app-private store of highlight data.
