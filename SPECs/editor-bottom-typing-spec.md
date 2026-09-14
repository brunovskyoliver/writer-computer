# Bottom-of-note typing comfort

Typing at the end of a note must keep the caret clear of the pane fade and blur. Enter, wrapped text, and cursor movement should scroll only when needed. Manual scrolling must remain free. The final line needs enough trailing space to reach the clear area. Apply this to Markdown and code tabs, including short split panes.

## Implementation

Use one outer-scroller handler for cursor tracking and search. Prefer caret coordinates for wrapped lines, falling back to the layout model for virtualized positions. Share the safe margin with trailing padding and bound fades on tall panes. Clamp the scrolling inset for short panes. Leave explicit non-nearest scroll requests to CodeMirror.

## Validation

Browser reproduction mounts the real scroll container, editor CSS, base setup and search extensions. Before the fix, five inserted lines leave the caret only 17px above the bottom (required: 140px). Check repeated Enter, wrapped paragraphs, short panes, offscreen navigation and manual scrolling. Run frontend checks and tests.

## Results

- `vp check` passed with six existing warnings in unrelated files.
- `vp test` from `apps/desktop` passed all 965 tests across 68 files.
- The browser fixture passed all 27 geometry assertions. Run `vp dev` from `apps/desktop`, open `/tests/browser/editor-scroll.html`, and await `window.scrollChecks` through browser automation. This fixture is separate from the node-only `vp test` suite.
- A real browser Enter key added line 1501 and left 140.19px below the caret.
- Editor, UX and QA reviews found no blocking issues.

The fixture uses the shared base editor setup, not Markdown widgets. Native macOS WebKit rendering was not verified. No Rust code changed.
