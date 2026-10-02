# Refresh roots when choosing LaTeX previews

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 8.

## Plan

Re-read root metadata after source saves and open the PDF returned by a successful build.

Investigated latex-compile-store, its compile/reset tests, the LaTeX document spec and state guidelines. Preview resolves a cached root before saving, then ignores result.pdf_path and result.root. Auto-compile also reads the association cache and can run after the matching preview closes.

Save successfully before preview lookup or toggling any PDF. Remove root-association cache reads from resolveRoot: foreground requests resolve freshly, while background saves wait for pending lookups without consuming their possibly pre-save result, then read the root again. Associations remain status data. Preserve generation/token guards and explicit lookup diagnostics.

Open result.pdf_path on success; a failed build may open only the PDF belonging to result.root after fileExists confirms it. Missing/unknown actual roots have no fallback. Normalize a success lacking root or PDF path into a failed result with an explicit diagnostic so the footer cannot keep reporting success. If any result disagrees with this source's current association, check again after fileExists awaits and immediately before opening, then report that the root changed and ask the user to retry instead of opening an unrelated PDF.

Auto requests check the freshly resolved root's open PDF before launching. Carry a preview-only flag through coalesced reruns so closing/changing the preview during the debounce or an active build cannot start an unwanted rerun. Explicit requests retain authority to compile if the preview closes, attached to their requesting source. A later auto request cannot replace an explicit queued source; select the latest explicit request, or the latest auto request when there is no explicit one. Keep debounce keyed by root.

Regression coverage: edited magic comment selects/closes only the new root PDF; actual native migration opens the returned PDF; failed migration checks only its own PDF; no-root cannot reopen an old PDF; auto-save with changed/closed preview starts no engine; explicit reruns still run after closure; reset/save-failure cases still pass. Also test a pre-save pending lookup followed by a changed-root save, explicit-then-auto coalescing across chapters with a later migration, and a newer association arriving during an older build or fallback existence check. State plan findings are incorporated. Update LaTeX spec and changelog. State and UX plan reviews approved; verify a real source-tab split/focus in the browser. Request fresh QA plan review and State, UX and QA implementation reviews.

### Final ownership corrections

QA reproduced a same-path lookup refresh being overwritten by an older native migration, and an older lookup scheduling work after a newer rerun starts. Path equality and comparing only the waiting slot do not establish ownership.

Track association authority in a transient Set of per-attempt contexts, registered before lookup and removed in finally after its shared/native promise settles. Fresh lookups invalidate other active contexts for the same source, even when the returned path is unchanged. The initiating native call may migrate its source association only while its context remains current. Queued metadata stays separate from attempt identity, so an older completion cannot remove a new rerun's context. Clear contexts on reset. This retains only active requests, with no completed-path history.

Enrich the existing running-root entries with their requesting source, authority and issuance order. Admit requests newer than the active request, or explicit requests joining an auto build. This rejects stale discovery while still allowing a later save during an explicit build to queue one rerun. Select the waiting request by explicit authority first, then issuance order. Retain the root entry as a reservation while its selected rerun waits for fresh discovery, preventing a late older lookup from taking that slot during preparation. The reservation carries the previous native promise for coalesced callers; its owner skips joining itself. A shared finish helper advances/cleans entries by identity, including canceled/no-root reruns and migration to another freshly discovered root. Other roots remain independent. Reuse the current maps; no priority history survives an idle root. Install the native job's lane before publishing compiling state and check generation/ownership afterward, before IPC. Recheck generation after association/build publication so synchronous reset subscribers cannot restore stale records or revisions.

Add regressions for same-path refresh during a migrated build, older completion during a newer native rerun, and older completion while that rerun's lookup is pending. Review this correction plan with State and Systems before implementation.

Systems plan review found that explicit priority could revive an old lookup after a newer explicit build hands off to auto work. Carry the highest started explicit request order in that live root entry through reservations/reruns. Explicit candidates at or below that cutoff join without queuing; later explicit requests may still supersede auto work. Drop the cutoff when the lane becomes idle. Add the explicit-to-auto handoff regression. This is active-lane metadata, with no completed-root registry.

## Report

Implemented save-first fresh-root selection, actual result PDF selection, current-association checks before and after fallback probes, and explicit failed diagnostics for malformed successes. Auto compiles resolve again after pending foreground work and check the matching preview before running. Explicit source authority and request issuance order are preserved across reruns.

State implementation review reproduced two remaining queue races: auto debounce could supersede an explicit lookup, and reverse lookup completion could replace a newer queued source. Both now have failing-before regression tests and corrections using pending-lookup waiting and the existing scalar request order; no additional path registry. A third review reproduction showed that an older explicit rerun could cancel a newer preview lookup. Queued reruns now use the same waiting path; a temporary diagnostic confirmed four lookups instead of three before the correction and was removed after the regression passed.

QA's same-path authority and queue-drain reproductions now pass. Transient attempts retain lookup ownership through native completion; live root jobs reserve rerun discovery, reject stale issuance, and carry started-explicit order across auto handoff. Systems plan review caught that handoff gap before implementation. Reset-subscriber regressions cover native startup, association/result publication, and lookup-failure association removal. State review found the last failure-publication gap, now guarded after root removal and before preview notices.

Browser check used the actual stores/save pipeline with mocked native IPC. A final walk with an old PDF in the source pane exposed active-tab loss during splitting. The same case failed in a permanent store regression; refocusing now restores the source tab as well as its pane. The repeated browser check passed: the changed root saved before discovery, the previous PDF remained open, the returned PDF opened in a separate pane, and the source stayed active and focused.

Plan reviews approved by State, UX, QA and Systems. Final Systems and QA implementation reviews approved; State's failure-publication finding is covered by passing regressions, and the earlier UX review approved the flow. All 75 focused LaTeX cases and the full 1,481-test frontend suite pass. vp check reports zero errors with ten existing warnings; git diff --check passes. No Rust code changed in this ticket. Full native PDF rendering/scroll, two-window validation and allocation profiling remain untested.
