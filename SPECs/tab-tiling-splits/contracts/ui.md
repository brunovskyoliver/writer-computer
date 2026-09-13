# UI and action contract

## Gesture resolution

| Source / target                         | Result                                                               |
| --------------------------------------- | -------------------------------------------------------------------- |
| Everything file selection / tree        | Existing move-on-disk operation, once                                |
| Everything file selection / pane centre | Open as tabs in target; reuse duplicates, first selected file active |
| Everything file selection / pane edge   | New focused pane with selected files, equal split                    |
| Tab / strip gap                         | Move or reorder, preserving source tab identity and history          |
| Tab / pane centre                       | Move to destination, source tab survives a duplicate collision       |
| Tab / pane edge                         | Split with moved tab, unless sole tab on its own edge                |
| Folder-containing selection / editor    | Invalid target; no overlay or file operation                         |
| Any / outside valid targets or window   | Cancel; unchanged tabs/layout/files                                  |

All sources use pointer events. Keep the shipped sidebar activation threshold. Tabs exclude OS window dragging at pointerdown; empty strip/titlebar space retains existing window behavior. After activation suppress the synthesized click so it cannot reopen/select after a drag. One coordinator owns release, Escape, pointercancel, lost capture, blur, and cleanup. Sidebar autoscroll runs only inside tree bounds; tab strips may scroll only while hovered.

## Target regions and orange preview

Use a single edge-definition table for axis, placement, hit-test, and preview. Edge bands are 30% of the pane body along each axis with no pixel cap, so the centre is the middle 40% (revised from 25%/80 px after hand testing: a capped band made splits on a wide pane need a long drag). At corners choose the nearest normalized edge, breaking ties left, right, top, bottom. Remaining area is centre. Tab strip insertion takes precedence over body regions. Invalid edge targets are absent, not silently converted to centre actions.

For a split, simulate the final layout including source collapse and draw the new pane's final allocation. For centre drops fill the final destination body; for insertion draw the final gap. Use the existing accent color at 18% opacity with `pointer-events: none`, clipped to editor bounds. Remove immediately on cancellation or completion. Preview and commit consume the same candidate; if its revision or geometry changes, recompute and repaint before accepting release, otherwise cancel that release.

Minimum pane size is 240 by 160 CSS px including its strip/footer; separators occupy 4 CSS px. Every split checks recursive minima. Newly split child allocations are equal after separator space. The resize adapter enforces the same minima. A shrunken window keeps all panes within a scrollable layout whose minimum dimensions fit the tree.

## Focus and existing commands

The focused pane gets a subtle accent border. Pane chrome/body pointerdown and keyboard focus set focus before actions. Only empty strip space is a window-drag surface. Close, back/forward, formatting, find, status metrics, title, and programmatic insertion resolve the focused tab or an explicit originating tab. Context menus capture their tab ID when opened.

Keep one find overlay associated with the focused editor; changing focused panes closes the old search as existing tab switches do. Display it in that pane's body. Document save/reload errors are shared by all views of the path; transient paste/link notices target their originating tab. Distinguish `isVisible` (pane-active tab) from `isFocused` (global keyboard target) in page view context. Nonfocused visible editors must not call automatic focus effects.

Sidebar, palette, recents, search, wiki links, drawing embeds, Finder-open and pending-open routes capture a pane before async work. Existing file-kind construction and open/replace policy remain centralized. No new split or pane-focus shortcut is introduced; library separator keyboard resizing remains available.

## Required evidence

The implementation must demonstrate one gesture to split, preview/result agreement after source collapse, no disk move on editor drop, cancellation with no mutations, preserved moved editor instance and history, independent cursors and shared edits, and correct focused-pane routing for delayed opens. See [quickstart.md](../quickstart.md).
