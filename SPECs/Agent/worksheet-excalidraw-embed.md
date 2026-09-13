# Worksheet: Excalidraw Embed + Edit

## Task

- TODO: `Excalidraw embed + edit`
- Spec: [`../excalidraw-embed/spec.md`](../excalidraw-embed/spec.md) (research status)
- Plan: [`../excalidraw-embed/plan.md`](../excalidraw-embed/plan.md)
- Tasks: [`../excalidraw-embed/tasks.md`](../excalidraw-embed/tasks.md)

## Intent

Drawings live as files beside the note, render inline in the markdown editor, and open in a
full Excalidraw editor tab on double-click. A drawing must stay editable on every revisit,
not just the first.

The storage format is decided by the Phase 2 spike, not by preference. If a scene survives
repeated export/import round-trips through `.excalidraw.svg` metadata — including the image
`files` map and text fonts — inline embeds cost zero JavaScript (Branch A). If it does not,
the format falls back to raw `.excalidraw` JSON with a lazy render widget (Branch B). Both
branches keep drawings editable; only Branch B costs a bundle load on read.

Phase 4 consolidates the path-to-tab-location construction sites in `editor-store.ts` behind
a single `locationForPath` helper before any drawing dispatch is added.

## Progress

- **Phase 1 — Setup**: done. `@excalidraw/excalidraw` 0.18.1 added to `apps/desktop`.
- **Phase 2 — Spike (blocking gate)**: not started. T009 stops for the branch decision.
- Phases 3–8: blocked on the branch decision.

## Implementation

_Pending._

## Review

_Pending._

## Validation

_Pending._
