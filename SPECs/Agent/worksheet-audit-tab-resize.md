# AUD-04: keep the active tab visible when its pane shrinks

## Reproduction and acceptance

Native audit app, three tabs, active last tab. At a 1200 CSS-pixel window width,
the active tab spans x=690..874. Shrinking to the supported 800-pixel width leaves
the tab at x=690..874 while its scroll strip ends at x=748, scrollLeft=0. Its title
and close control are clipped. Switching tabs corrects the scroll position.

Evidence: `~/agent-runs/2026-10-29-writer-audit/baseline-resize-active-tab.png`.
WebDriver's native size uses physical pixels on this Retina screen; dimensions
above were verified through `innerWidth`, not inferred from requested bounds.
An earlier offscreen Settings-tab capture was caused by background animation
throttling; that is not the reproduced resize defect.

The active tab must remain visible when the window or pane shrinks, including
sidebar expansion. Keep manual horizontal scrolling possible between resizes.
Preserve current styling, tab animations and pane-owned scrolling.

## Plan

`useScrollActiveTabIntoView` already owns revealing the active tab after activation
and tab animation. Observe that strip's size there and reuse the same visibility
check and nearest scrolling. Disconnect the observer on cleanup and retain the
existing delayed animation-settle check. Do not add global resize state or
duplicate scrolling in tab components. A ResizeObserver covers split panes and
sidebar changes as well as the window.

Verify the real hook's observer lifecycle and resize behavior with a mocked DOM
and React effect seam, then reproduce the native width transition after rebuilding.
Check overflow tabs, sidebar expansion, user scrolling, and absence of whole-page
scroll. Run frontend gates. UI refinement preserves existing design tokens.

## Status

Implemented in the existing hook. Frontend, UX and QA reviewers approved both
plan and implementation. Three of four new regression checks failed before the
fix; all four pass after it. Full frontend suite: 1,696 tests pass. `vp check`:
zero errors, ten existing warnings. Impeccable source detector: no findings.

Native release-app verification (`tab-native.json`): 1200 -> 800 CSS pixels now
moves strip scrollLeft from 0 to 126 and keeps the whole active tab inside the
strip (x=564..748). Manual scrolling back to 0 remains there. Sidebar collapse
and expansion preserve the reveal behavior. Window/root scroll stays at zero.

Split verification (`tab-native-split.json`): resizing a pane from 647 to 443
pixels scrolls its active tab into view; the neighboring strip keeps scrollLeft=0,
and all document scrollers and window scroll stay unchanged. W3C pointer actions
delivered no pointer events in this plugin version, so the split was created
through synthesized pointer events in the real WebKit DOM and resized through
synthesized separator key events. This verifies app integration, not native mouse
event delivery. A strip narrower than one tab can only show part of that tab;
that existing minimum-pane layout issue remains in the audit.

Before/after screenshots and native diagnostics are in the evidence directory.
No tokens or visual styling changed. The app rebuild includes the starting dirty
frontend work, which is excluded from this commit. No SDU note edits.

This task follows `3aef86f` (atomic save fix). Dirty external reload remains open.
