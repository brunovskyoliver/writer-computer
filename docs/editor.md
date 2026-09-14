# Editor Notes

Patterns and gotchas for the CodeMirror editor in `apps/desktop/src/components/editor-area/`. Each rule earned its place by costing real time. Apply them when extending or reviewing editor code.

## Use the layout model, not the rendered DOM, for positions

Prefer:

- `view.lineBlockAt(pos)` → `BlockInfo` with `top`/`bottom`/`height` in document coordinates.
- `view.documentTop` → screen y of the first line.

Over:

- `view.coordsAtPos(pos)` → can return `null` for positions outside the rendered viewport. CodeMirror only measures lines that are currently virtualized into the DOM; matches further down the document have no `Rect` until they scroll into view.
- `view.contentDOM.getBoundingClientRect()` → affected by virtualization padding and async layout.

Match screen position, valid for any document position:

```ts
const block = view.lineBlockAt(pos);
const matchScreenY = view.documentTop + block.top;
```

`coordsAtPos` returning `null` is a silent failure: a `scrollHandler` that returns `false` falls back to CodeMirror's default scroll, which doesn't know about app-level fades, masks, or other ancestor overlays. If you only test in-viewport cases, the bug ships.

## Choose the right scroll API for who owns the scroll container

CodeMirror's built-in scroll APIs assume the editor owns its scroll container (`view.scrollDOM`, by default `.cm-scroller`):

- `search()` config's `scrollToMatch` — customize the scroll effect for findNext/findPrevious.
- `EditorView.scrollMargins` facet — declare top/bottom/left/right regions of the scroll container that should be treated as off-screen (e.g. for a fixed gutter or fade).

These are correct when `view.scrollDOM` is the actual scrolling element.

In Writer's editor, `.cm-scroller` has `overflow: visible !important` (see `prosemark-theme.css`) and the surrounding `EditorScrollContainer` is the real scroller. CodeMirror's default scroll walks up to scroll ancestors generically, but `scrollMargins` only applies to `view.scrollDOM`'s computation — so the match can still land under the outer container's fade.

When the scrollable element is an ancestor:

- Use `EditorView.scrollHandler.of(...)` to take over scrolling.
- Find the ancestor scroller by walking `view.dom.parentElement` for the first element with `overflowY: auto | scroll`.
- Scroll it yourself with `scroller.scrollTo({ top, behavior: "auto" })`. `behavior: "smooth"` is async and gets interrupted by rapid keystrokes (e.g. Cmd+G held down).
- Account for `clientTop` if the ancestor has a border (Writer's container has a 12px transparent border-top to give the mask gradient room).

Reference: `editorScrollHandler` in `apps/desktop/src/components/editor-area/editor-scroll.ts`. It handles nearest-scroll requests for typing, cursor movement and search. Wheel scrolling does not request caret tracking.

The handler runs during a CodeMirror update, so `coordsAtPos` must be deferred to a `requestMeasure` read. For a wrapped paragraph, use those caret coordinates to track the actual visual line, with `lineBlockAt` as the fallback for virtualized positions. Remeasure after scrolling because newly rendered lines can replace estimated heights. The scroll inset is capped at one third of the pane height for short splits. `EditorScrollContainer` also supplies trailing editor padding from the safe margin and caps the fade length, so the final caret can reach the clear area.

The same rule covers libraries that scroll on their own: `@replit/codemirror-vim`'s CM5 adapter reads and writes `view.scrollDOM` for `Ctrl+D/U/F/B/E/Y`, `zz`/`zt`/`zb` and `H`/`M`/`L`. `vim-scroll.ts` replaces the adapter's `getScrollInfo` / `scrollTo` / `findPosV("page")` on the instance so they measure and move the ancestor scroller instead (inset by `EDITOR_SAFE_SCROLL_MARGIN`, like search navigation).

## Block widgets: pick the decoration shape

Common shapes for widgets that own a block region:

- **Replace-only.** Always `Decoration.replace`. Use when the widget doesn't need to expose source for editing and interaction lives inside the widget itself. Canonical example: `mermaid-decorations.ts` — the fence is always replaced by the canvas, and editing happens in the canvas's nested editor, which writes the whole fence back via `writeFenceText`.
- **Conditional replace ↔ widget.** `Decoration.replace` over `[node.from, node.to]` when the selection doesn't overlap the node; `Decoration.widget(...).range(node.to)` (anchored at the end) when it does, so the source becomes editable next to the rendered widget. Canonical example: `fold/image.ts`. Driven by `selectionTouchesRange`, the third arg passed to `foldableSyntaxFacet`'s `buildDecorations`.
- **Conditional replace ↔ source-line styling.** `Decoration.replace` when the selection is outside the block; line decorations when selection touches the block and the source should stay editable in the main editor. Canonical example: `table-decorations.ts`, which renders a folded table preview with safe inline markdown inside cells, then unfolds a touched table into codeblock-styled markdown source lines rather than a nested editor.

Don't invent a parallel "edit mode" flag that isn't wired through `selectionTouchesRange`. The fold extension already manages that state — duplicating it produces drift between the two sources of truth.

## Enter edit mode by range-selecting the fence, not by placing a caret

`selectionTouchesRange` from `@prosemark/core` is overlap-based with inclusive bounds (`a.from <= b.to && b.from <= a.to`, see `node_modules/@prosemark/core/dist/main.js:30`). A range selection covering the whole fence reliably flips it true regardless of where the head lands.

```ts
view.dispatch({
  selection: EditorSelection.single(fenceTo, fenceFrom), // reverse-anchor convention
  effects: view.scrollSnapshot(),
});
```

Caret-placement at a single point inside the fence is fragile: empty fences, boundary positions, multi-line content, and stale offsets all break it. Mirror what `selectAllDecorationsOnSelectExtension` (`@prosemark/core`) does — it's the canonical pattern.

## Don't store document positions on widget instances

Widget identity is its visual state — `source`, `editMode`, etc. — never positions. Positions are derived state owned by the syntax tree.

- Don't capture `node.from`/`node.to` on the widget at construction. Above-fence edits shift them and the widget lives across rebuilds.
- Don't try to keep them current via an `eq()` side-effect (mutating the kept instance from `other`). It looks like it works in isolation and silently fails across multi-fence diffs and decoration-shape transitions.
- Look up positions live at click time:

```ts
const pos = view.posAtDOM(host);
const tree = syntaxTree(view.state);
let node = tree.resolveInner(pos, side);
while (node.name !== "FencedCode" && node.parent) node = node.parent;
```

`eq()` should compare only the visual identity. Let CM rebuild when that changes; don't mutate kept instances to compensate.

## `posAtDOM` boundaries: try `resolveInner` with both sides

A `Decoration.widget(...).range(node.to)` returns `posAtDOM(host) === node.to`. `resolveInner(node.to, 1)` resolves to the node _starting_ at `node.to` — the next sibling, not the FencedCode that ends there. The walk up never finds the fence.

For widgets anchored at boundary positions, try `side = -1` first (prefers the node ending at the boundary), fall back to `side = 1`:

```ts
for (const side of [-1, 1] as const) {
  let node = tree.resolveInner(pos, side);
  while (node.name !== target && node.parent) node = node.parent;
  if (node.name === target) return node;
}
return null;
```

## Buttons inside widgets: `mousedown.preventDefault()`

A button inside the widget that dispatches a transaction will race the editor's focus state. Default browser behavior on mousedown:

1. Browser focuses the button → editor blurs.
2. Click handler runs → `view.dispatch(...)`.
3. Decoration rebuilds → button DOM destroyed → focus reverts to body.
4. Our `view.contentDOM.focus({preventScroll: true})` runs.

Steps 1–4 race with CM's own focus tracking; the visible result is the caret landing at click coordinates instead of the dispatched selection, or focus landing nowhere useful.

Add to every in-widget button:

```ts
b.addEventListener("mousedown", (e) => {
  e.preventDefault(); // keep the editor focused
  e.stopPropagation(); // keep CM's pointerdown handlers from competing
});
```

Combine with `ignoreEvent: true` on the widget so CM skips its own pointer/click handling for events inside the widget DOM.

**Gotcha: `mousedown.stopPropagation` does not stop `pointerdown`.** They're separate event types — the browser dispatches both for a click, and stopping one doesn't filter the other. If you wire an editor-level handler on `pointerdown` (e.g., a drag-selection gate that listens on `view.contentDOM`), the in-widget button's `mousedown` stop won't suppress it. Filter inside the editor-level handler instead — typically `event.target instanceof Element && event.target.closest('.cm-your-widget')`. See `mermaid-decorations.ts`'s `shouldStartDragGate` for the canonical filter.

## Heightmap-shifting transitions: include `view.scrollSnapshot()`

Any decoration switch that changes block heights (replace ↔ widget, fold/unfold, widget appearing/disappearing) shifts the heightmap. Without compensation the viewport jumps.

```ts
view.dispatch({
  selection: ...,
  effects: view.scrollSnapshot(),
});
```

`scrollSnapshot` captures the viewport-top doc anchor and its screen offset; CM applies the resulting `StateEffect` after the heightmap rebuild and re-scrolls so the same anchor lands at the same screen Y. Don't roll your own `coordsAtPos`-delta scroll math — it depends on layout being flushed and is brittle.

**Caveat: `scrollSnapshot` only affects `view.scrollDOM`, not ancestor scrollers** (per CM's own doc comment; both capture and apply use `scrollDOM.scrollTop`). In Writer, `.cm-scroller` doesn't scroll — the outer `EditorScrollContainer` does — so the snapshot is close to a no-op here. What actually keeps the viewport stable across height changes is CM's measure-loop scroll anchoring, which does adjust the discovered ancestor scroller — but only while the editor has focus or a wheel/touch event happened in the last 100ms. Corollary: widgets whose DOM changes height after insertion (async image decode, deferred renders) must keep `estimatedHeight` truthful and call `view.requestMeasure()` when their height settles, so the anchoring runs while the user is still interacting. `fold/image.ts` does this with a module-level measured-height cache keyed by image URL, reserving the cached height on the `<img>` until it (re)loads.

## Tree-derived StateFields go stale in unparsed regions

`syntaxTree(state)` returns a frozen snapshot committed at the last `LanguageState` flip — not the live parse context. `ensureSyntaxTree` advances the live context and returns the fresh tree, but `syntaxTree(state)` keeps returning the old one until some later transaction commits a new `LanguageState` (`forceParsing` = `ensureSyntaxTree` + that dispatch). Lezer's background worker fills the tree in `requestIdleCallback` slices, which starve during continuous scrolling and are budget-capped on long documents.

Consequence: any `StateField` that builds decorations by iterating `syntaxTree(state)` (list geometry, hide, fold) renders nothing for regions the committed tree hasn't reached — scrolled-into list items lose their hanging indent, markers show raw, etc. The fields' `syntaxTree(startState) !== syntaxTree(state)` rebuild guards only fire once a parse-commit transaction lands.

`viewportParsePlugin` in `use-prosemark-editor.ts` closes the gap: on `viewportChanged` into a region where `syntaxTreeAvailable` is false, it defers a `forceParsing(view, viewport.to + overshoot)` (dispatching inside an update cycle is illegal, hence the `setTimeout`). Mount and tab-swap paths call `advanceViewportParse` for the same reason. Don't add per-field force-parses.

The parse-commit transaction that `forceParsing` dispatches changes neither the doc nor the viewport. So every tree-derived decoration source, StateField **and** ViewPlugin, must rebuild on the tree itself changing. Use `treeChanged(update)` from `prosemark-core/utils.ts`:

```ts
update(update: ViewUpdate) {
  if (update.docChanged || update.viewportChanged || treeChanged(update)) rebuild();
}
```

The StateFields (`hideExtension`, `foldExtension`, `listDecorationsField`) and the ViewPlugins (`headingPlugin`, `codeBlockDecorationsExtension`, `blockQuoteExtension`) all carry it. Without it a region jumped into (Cmd+G, section rail, anchor) keeps stale decorations until the next scroll. Don't add a "tree sync" plugin that re-dispatches a selection to nudge a rebuild; that was the old workaround and it tripled the rebuild cost per parse commit.

## A nested parser replaces the node it mounts on

`parseMixed` does not add a child — it substitutes the mounted tree's root for
the node. After `latexMathNesting` mounts the LaTeX tokenizer on `MathFormula`,
a `Math` node's children are `MathMark`, `Document` (the mounted root),
`MathMark`, and `math.getChild("MathFormula")` returns `null`. That silently
broke math folding (`mathFormulaRange` returned `null`, so no widget) and sent
`mathContext` down its fallback branch.

Read a span from the nodes the mount cannot touch. `mathFormulaSpan(math)` in
`prosemark-core/markdown/mathMarkdown.ts` reads between the two `MathMark`
delimiters and is the single source for the formula range; `math-decorations.ts`
and `latex-snippets/math-context.ts` both call it. `resolveInner` does cross the
mount boundary upward, so ancestor walks looking for `Math` still work.

Overlay mounts (code fences) behave differently again: they are invisible to
`Tree.iterate` but visible to `resolveInner` and `highlightTree`. Assert nested
fence tokens through `highlightTree`, not a tree walk.

Any test that parses Markdown and asserts on math or fence structure must use
the same `markdown({ extensions })` list the app ships, `latexMathNesting`
included — otherwise it passes against a tree the editor never sees.

## Synchronous render in `toDOM` beats IntersectionObserver-deferred

If your renderer is sync and cache-backed (or cheap to call), paint in `toDOM`. The async-deferred path adds a "Loading…" gap users see, can re-fire after a toggle (producing a visible flash), and has no real benefit when the cache makes repeat renders O(map lookup). CM only calls `toDOM` for widgets in its viewport buffer anyway.

Reference: `mermaid-decorations.ts` mounts the canvas synchronously in `toDOM`; the SVG cache is bounded LRU and the output is sanitised before reaching `innerHTML`.

## Test the dispatch path, not just the helpers

Pure-helper tests (`computeToggleSelection`-style) catch math bugs but not focus races, `posAtDOM` boundary errors, or cross-widget interference. The actual contract is "click does the right thing in CM," which only an integration test can verify.

When a widget has a click → dispatch → mode-change cycle, mount a real `EditorView` with two instances and simulate clicks. Assert against `view.state.selection.main` and `view.state.field(foldExtension)`, not against helper outputs.

## Panes, tab strips, and drags

The editor area is a binary tree of panes (`lib/editor-layout.ts`, owned by `editor-store.ts`). Rules that hold in the shipped code:

- **One writable layout, one exit.** Every tab/pane mutation goes through the store's `publish`, which normalizes the tree (collapses empty panes, repairs active members and focus) and re-derives `activeTabId`/`activeFilePath` from the focused pane. `revision` moves for layout changes only, never for edits or cursor moves.
- **Tab bodies never move in the React tree.** `editor-area/index.tsx` renders every body once under a stable tab-id parent and positions it over the rectangle its pane slot measures (`pane-bounds.ts`). A moved tab keeps its editor instance, undo, cursor, and scroll; no save or reload runs on a move. Only a true close, a location replacement, or shutdown crosses a save boundary.
- **Tab chrome stays visible.** Tabs scroll horizontally when they overflow and never fold on hover. Entry and exit animate for 240ms (disabled by reduced-motion preferences); exiting chrome is inert and excluded from drag geometry, while the document closes immediately. Markdown files show a centered, extension-free workspace-relative path beneath the strip. This row is outside the document scroller and stays fixed with the pane chrome. Ordinary file tab labels omit extensions; frontmatter titles retain precedence.
- **Each pane owns its strip.** `EditorTabs` takes a `paneId`; close-others / close-all, scroll-into-view, and the back/forward enabled state are scoped to that strip. The strip floats over the top of its pane body (like the old global strip floated over the editor), so bodies keep their existing headroom. Only empty strip space carries `data-tauri-drag-region`; tabs never do, so a press on a tab never drags the OS window.
- **One pointer coordinator** (`hooks/use-editor-drag.ts`) owns every drag that can end in the editor area: threshold, pointer capture, the per-frame geometry pass, the resolved candidate, and every end path (release, Escape, `pointercancel`, `lostpointercapture`, blur, source renamed/deleted). Sources are the sidebar tree (`use-tree-drag.ts`, an adapter; its move-on-disk stays the only disk-move path) and a tab. Strips take precedence over body regions; edge bands are 30% of the body per axis (no pixel cap; the centre is the middle 40%); corner ties go left, right, top, bottom.
- **Opens are aimed before they await.** `openFile` / `navigateToFile` / `openFileInNewTab` take an `OpenTarget` (explicit tab, then explicit pane, then the focused pane) and resolve it synchronously. A route that does disk work first — a palette create (`command-palette/open-routes.ts`), a wiki link or drawing embed (`followWikiLink` / `openDrawingEmbed`), a Finder drop — captures the target before its first await and hands it in. A workspace switch or close runs `resetEditorState`, which replaces the tree, so a pane captured before the reset is never found again and the completion lands nowhere. Pending anchors are keyed by tab and path.
- **Focus, not visibility, routes commands.** `activeTabId` is the focused pane's active tab, so title, footer metrics, close, back/forward, formatting, find, and `insertAtCursor` follow focus; Ctrl+Tab and Cmd+1–9 address the focused pane's strip. Pane chrome and bodies set focus on pointer-down capture, before any child handler. Tab-scoped chrome (the find overlay, paste/link notices) renders inside a `PaneSurface` over that tab's pane. Non-focused visible editors must not run automatic focus effects (`isVisible` vs `isFocused` in the page-kind view contract).
- **Dividers are the library's; ratios are the store's.** Splits render as `react-resizable-panels` groups (`pane-layout.tsx`), keyed by the split and its two child ids, with `minSize` set to each child subtree's recursive minimum. Only a finished user drag commits `a / (a + b)` through `setSplitRatio`; mount and constraint recomputes are ignored. The editor area scrolls a sheet sized to `minimumSize(root)` when the window is smaller than the tree, so panes are never starved or dropped.
- **The session is the committed tree.** `lib/session.ts` owns the v2 wire shape and the codec both ways; Rust `session.rs` mirrors it and both run the fixtures in `SPECs/tab-tiling-splits/fixtures/sessions/`. Persistence (`workspace-store.ts`) follows layout or tab identity changes — never edits — through one debounced, ordered writer per window, cancelled on switch and flushed on close. A malformed record is reported and held on disk until a non-empty snapshot for that workspace replaces it; compact windows never persist.
- **Preview and commit share one candidate.** `buildFileDropCandidate` / `buildTabDropCandidate` return the exact post-transition layout plus its preview rectangle, computed _after_ the source pane collapses. `DropPreview` paints `candidate.previewRect` and nothing else; release re-resolves against the live layout and geometry and the store refuses a candidate whose `expectedRevision` is stale. A drop that would change nothing (same position, own centre, sole tab on its own edge, split below the 240×160 minimum) has no candidate, so no overlay and no commit.

## LaTeX settings and source boundaries

LaTeX input handlers read snippet, tab-out and auto-fraction settings at each input. Variable edits reload the compiled set; highlighting changes only reconfigure its style compartment. Neither path replaces the editor view or its selection.

The scoped LaTeX highlight style must have higher precedence than the general code palette. The off style explicitly inherits the editor colour; omitting a colour exposes the general palette underneath it. Keep both requirements when changing these styles.

Auto-fraction receives only the current line's formula content, starting at the later of the line start and `formulaFrom`. Translate its relative operand offset from that same origin. Passing the full line can consume prose or an opening `$` into the numerator.

## File map

- `mermaid-decorations.ts` — canonical replace-only block widget with in-widget editing. Reference for live position lookup (`findEnclosingFencedCode`) and writing the fence back from a nested editor.
- `fold/image.ts` — canonical conditional replace ↔ widget, plus the measured-height cache for async-loading content.
- `table-decorations.ts` — canonical conditional replace ↔ source-line styling; uses `selectAllDecorationsOnSelectExtension` for click-to-select.
- `prosemark-core/links.ts` — `linkUrlAt` / `rawUrlAt`, the one place that resolves a link destination from a document position.
- `prosemark-core/imageSrc.ts` — `imageSrcResolverFacet` / `resolveImageSrc`; widgets resolve `<img src>` in `toDOM` (Writer provides the facet from `image-src-resolver.ts`), so no DOM observer rewrites images after insertion.
- `editor-scroll.ts` — `findOuterScroller` / `scrollPosToSafeTop`, the one place that scrolls the ancestor container to a document position.
- `editor-extensions.ts` — `createEditorExtensions`, the one place the extension list is assembled. Pieces: `editor-search-extensions.ts` (hidden search panel, `EditorView.scrollHandler` for the ancestor-scroller case, Mod-f / Mod-g / Escape), `link-navigation.ts` (click-to-follow, `followLink`), `editor-clipboard.ts` (image + frontmatter paste), `editor-body-menu.ts` (right-click menu), `viewport-parse.ts`. `use-prosemark-editor.ts` only mounts, swaps, and disposes the view.
- `latex-highlighting.ts` — `latexSourceLanguage` (the stream tokenizer), `latexMathNesting` (the `MathFormula` mount), `latexAwareCodeLanguages` (`latex`/`tex` fences), and `latexHighlighting()`: the coloured/plain `HighlightStyle` compartment driven by `latex.highlight-source` plus the app's only `bracketMatching`, whose `renderMatch` returns nothing outside math and latex fences.
- `vim-mode.ts` — `vimModeExtension(getTabId)`: a compartment that holds `vim()` while `editor.vim-mode` is on and `[]` otherwise, plus the view plugin that owns the settings subscription, mirrors the library's mode/keypress/command events into `vim-store`, and moves its prompt nodes into the footer's dialog host. `vim()` must stay first in the extension list: the library declines keys it has no binding for, and every other keymap (formatting, search, list editing, completion) must sit behind it so Normal-mode keys never reach them.
- `vim-ex-commands.ts` — `registerVimExCommands(Vim, deps)`: `:w` `:q` `:q!` `:wq` `:x` on the `Vim` singleton, routed to `saveNow`, `closeTab`, and `reloadFromDisk` through injected deps; registered once per module load.
- `vim-store.ts` — per-tab `{ mode, pending, recording }` and the footer `dialogHost`; only `vim-mode.ts` writes `byTab`, only `document-footer.tsx` writes `dialogHost`. `useVimFooterModel(tabId)` is the one selector.
- `vim-clipboard.ts` / `vim-scroll.ts` — the unnamed-register ↔ system-clipboard bridge (module singleton, one per app), and the redirect of the CM5 adapter's scroll geometry to the ancestor scroller so `Ctrl+D` / `zz` / `H M L` move `EditorScrollContainer` rather than `.cm-scroller`.
- `node_modules/@prosemark/core/dist/main.js:30` — `selectionTouchesRange` semantics.

## Math editing previews

Inline and display math keep a rendered preview above its opening source line while selected, using `keepDecorationOnUnfold` and a block widget with `side: -1`. Preview widgets use a separate class from clickable folded formulas, so clicking a preview does not reset the source selection. Standalone root-level `$$` blocks parse across blank lines; nested containers retain the inline parser. An unclosed root math block stays visible as source through the end of the document.
