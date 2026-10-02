# Save dirty text before closing or switching a workspace

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 1.

## Plan

Flush pending and in-flight text writes before backend closure. Abort closure on any failed save and keep input frozen until the transition finishes.

Plan review approved save ordering. Implementation review found pending native clipboard edits and an unguarded target session restore; the boundary now owns a shared input gate, drains already-started clipboard work before saving, and stays frozen through target restoration. Switch failures use one feedback hook for menu and palette entry points.

Load the owning source, tests and guideline docs. Add a regression check for the reported case and the adjacent success/failure boundary, then make the smallest coherent fix. Review the plan and implementation per docs/workflows/agent-review.md.

## Report

Workspace close drains pending clipboard edits and saves every open text buffer before closing the backend or resetting editor state. Switching holds the shared input gate through target session restoration. Menu and palette failures report the error. Native context-menu paste, image paste and Vim system-register paste participate in the drain; Vim retains the dependency's count and visual paste continuation.

Verified with `vp check` (0 errors, 10 existing warnings) and all 1,394 frontend tests. Regressions cover buffered/throttled edits, older writes in flight, multi-file save failure, backend failure, target restoration and delayed clipboard work. Browser checks against real DOM and CodeMirror/Vim confirmed the input gate, pending drain and counted system-register paste.

State, Startup/Workspace, Systems and QA reviews identified clipboard and restoration races, which were fixed. Editor review identified the separate Vim async path, now covered through the installed Vim core. Native Close/Quit needs the separate queued review-21 task. Native WebKit allocation profiling remains outside these frontend checks.

Final Editor review found no defects in the Vim adapter; dependency probes also checked visual, linewise and disposed-view paste. QA verified that immediate-drain mutations fail the strengthened regressions.
