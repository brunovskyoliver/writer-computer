# Data model

## Runtime entities

| Entity              | Fields and ownership                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Layout              | `root: LayoutNode`, `focusedPaneId`, monotonic `revision`; owned by editor store in each window                                                      |
| Pane                | `kind: pane`, stable `id`, ordered `tabIds`, `activeTabId`; leaf of the layout                                                                       |
| Split               | `kind: split`, stable `id`, `axis: x                                                                                                                 | y`, exactly two child nodes, `ratio` for first child in (0, 1) |
| Tab                 | Existing `id`, `location`, `back`, `forward`; view state keyed by tab and location; navigation generation stays keyed by tab                         |
| View state          | Selection ranges, scroll anchor/offset; drawing viewport/selection for drawing tabs. Runtime only; owned by tab, retained through moves              |
| Document            | Existing canonical path, content/frontmatter, disk content, dirty/loading/error state, reload revision, derived stats/title; no cursor/scroll fields |
| Drawing session     | Path, scene elements/assets, content revision, saved revision, queued/in-flight export, error, attached view IDs; one writer per path                |
| Editor registration | Tab ID, current document path, editor instance, mount generation; path indexes derive from registrations                                             |
| Drag session        | Pointer ID, source tab or selected file snapshot, workspace generation, initial source identities, current candidate; transient only                 |
| Drop candidate      | Target pane/strip, region or insertion index, expected layout revision, validated resulting layout and focus, final preview rectangle                |

An empty window still has one focused root pane containing the existing launcher tab. Transient launcher entries do not persist. Settings and drawing tabs use the page-kind registry; layout code does not switch on their kinds.

## Invariants

- Node IDs and tab IDs are unique. Every tab occurs in exactly one pane; every referenced tab exists.
- Every nonempty pane has one active member. Exactly one existing pane is focused.
- Empty non-root panes collapse immediately. Splits always have two nonempty descendants after normalization.
- A document may have several tab views, including intentional duplicates within one pane from the existing Open in new tab action or legacy restore. Preserve their separate histories. Deduplication is an operation policy for ordinary opens and drops, not a global layout invariant. Navigation history may reference a document multiple times.
- A source tab moved to a pane already showing its document survives with its ID/history/view state. If several destination tabs match, choose the active match or otherwise the first in strip order. Remove that destination tab atomically, without closing/saving the shared document. Sidebar centre drops instead focus the existing destination tab.
- Ratios are finite and positive; measured allocations satisfy subtree minima. A split is offered only if its entire final candidate fits.
- Editing changes document revision, not layout revision. Cursor/scroll updates do not serialize layout or clone the shared document map.
- Closing a view releases document resources only when no current tab or retained history needs them; dirty/in-flight saves must complete through the document owner before eviction. A tab move/deduplication must bypass existing close/navigation save boundaries: it changes view ownership only, while true close, location replacement, and shutdown keep their save boundaries.

## Transitions

**Open:** Capture focused pane and initiating tab before any await. Explicit pane routes override focus. Reuse existing replace/new-tab policies within that pane, including drawings opening in their own tab. Validate workspace/navigation generation on completion; never use whichever pane happens to be focused later.

**Move/reorder:** Validate source, remove it from its pane, resolve same-document destination collision, insert at the normalized index, collapse empty source ancestors, select the moved tab and focus destination, then publish one state update. Within-strip insertion adjusts for source removal. Dropping back at the same position is a no-op.

**Split:** Reject a sole tab dropped on its own pane edge. Derive the final tree with source removal/collapse and a new equal split, retaining the destination pane ID and source tab ID. Recompute all bounds and enforce minima. For sidebar drops, preflight/load all files under one workspace generation; on any failure report it and leave layout unchanged. Open the selection in order and select its first file. If loading is asynchronous, consume/revalidate the captured target rather than current focus; cancel if the saved candidate is no longer valid.

**Close/delete:** Remove the affected tabs/history references using existing location behavior. Collapse empty panes and select a surviving neighbor in strip/tree order. Closing the last tab restores launcher. File rename rewrites all path references and document/view indexes atomically; rename/delete invalidates an affected live drag.

**Resize:** Library owns the live gesture. Commit normalized final ratios through the editor layout action. Cancellation restores the starting ratios. Resize changes invalidate stale drop candidates.

**Focus:** Pointer/focus capture in pane chrome or body focuses that pane before child commands run. Visible tabs in other panes remain mounted and editable; only the focused tab receives global commands and automatic keyboard focus.

**Edit/save/reload:** Publish a document revision once, synchronize sibling content without broadcasting selection, schedule one save. An older save/export completion may update the saved revision but cannot mark newer content clean. External reload/conflict decisions apply once to the shared document and every attached view. Losing one view must not cancel another view's save.

**Restore/reset:** Validate and migrate session, deserialize via page registry, prune missing files and invalid history, normalize tree/focus, and publish through the same owner as runtime layout changes. Guard all async reads against workspace replacement. New-workspace/compact transitions cancel drags and pending layout persistence before resetting state.
