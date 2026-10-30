# AUD-11: large drawing export responsiveness

## Scope

Follow-up to `96e835d`, Obsidian drawing previews and editable copies. Reduce
measured main-thread rendering stalls without changing drawing appearance, losing
scene data, or making ordinary small previews slower. Preserve all existing copy,
save, cache, cancellation and source-preservation behavior. Full Writer audit stays
active. Original SDU files and existing math/Mermaid/dependency work remain untouched.

## Evidence

Read the final report in `worksheet-audit-obsidian-drawings.md` first. Evidence is
under `/Users/oliver/agent-runs/2026-10-29-writer-audit/`.

- Synthetic source: 1,399,841 bytes, 430 freehand strokes with 220 points each.
- Before metadata optimization: first display 332ms, maximum frame gap 220ms,
  maximum scheduled insertion delay 189ms, all 30 synthetic insertions completed.
- Browser-only stage instrumentation found about 55ms for editable metadata and
  100ms for stroke SVG construction. Decode runs in a worker.
- Preview metadata was removed in AUD-03; copy/save exports retain it. No cached
  duplicate SVG string remains after blob URL creation.
- Post-change diagnostic: display 246ms, max frame gap 143ms, max scheduled
  insertion delay 105ms. It used 1494×1651 CSS pixels versus 1200×800 baseline.
  Matched-viewport attempts lost foreground visibility and were excluded. No
  controlled speedup is established; no hardware typing-latency claim is made.

## Investigation

Current `exportDrawing` calls the installed public Excalidraw `exportToSvg`, then
serializes its DOM tree. `obsidianDrawings` restores the worker-decoded scene and
calls this shared export without editable metadata. Two source jobs can run at a
time. The public package exports getCommonBounds and exportToCanvas/exportToSvg;
that alone does not prove safe incremental rendering or worker compatibility.

Inspect the installed implementation before choosing an approach. Determine which
work is pure geometry, which needs DOM/font state, and whether a public API supports
yielding. Any batching must preserve ordering, bound text, arrows, frames, clipping,
links, transforms, image assets, fonts and exact overall bounds. Avoid a partial
renderer or silent loss of unsupported elements. Scheduling one long export during
idle time does not resolve its maximum blocking interval.

## Next steps

1. Inspect export internals and evaluate maintainable approaches with a fresh
   research subagent using gpt-6.1-sol, high reasoning.
2. Write a concrete implementation plan and meaningful fidelity/performance tests;
   obtain the relevant fresh persona plan reviews before code changes.
3. Implement, build and compare native rendering/typing at controlled geometry and
   visible foreground state. Discard interrupted measurements.
4. Review, update owning docs, record remaining limits and commit this task alone.

Status: investigation started. No performance implementation changes yet.

## Controlled native baseline

The interrupted measurements were caused by the audit window becoming occluded
when T3 Code regained focus. A visibility/frontmost trace records the transition;
keeping the audit window tiled beside T3 makes it stay visible. No app or desktop
configuration change is needed. Preserve the tiled geometry for the comparison.
An uninterrupted tool call alone did not solve occlusion.

Three current-build runs in the same 1494×1651 CSS viewport remained visible for
the entire trial (visibilitychange listeners assert this). Each baseline and load
trial completed all 30 synthetic CodeMirror insertions and preserved the large
source hash. Median across runs: 233ms to display, 127ms maximum frame gap, 92ms
maximum scheduled insertion delay during loading. Idle baseline medians: 20ms
maximum frame gap and 4ms maximum scheduled delay. These measure synthetic input
scheduling, not hardware keyboard latency. Evidence: drawing-performance-before-
{1,2,3}.json and drawing-performance-baseline-summary.json. The shared benchmark
script is drawing-performance-benchmark.py in the evidence directory.

Fidelity checks must include pressure-sensitive and simulated-pressure freehand,
rotated/transparent strokes, overlapping element order, arrows with bound text,
frames with clipping, embedded raster images, links and multiple fonts. Compare
rendered output and retained editable scene; merely counting SVG nodes is not
sufficient. Test empty/small scenes and cancellation as well as the large fixture.

## Fidelity fixture finding

A 21-element mixed synthetic scene exposed deleted geometry affecting export
bounds: a deleted rectangle at (-10000,-10000) inflated the SVG viewBox above
10,000px. AUD-12 handles the narrow shared-export correction before performance
implementation. The export architecture research remains useful and continues;
no AUD-11 application changes have started. Resume after the AUD-12 commit.

## Research result and review pause

Research completed with gpt-6.1-sol/high. The full report is
`/Users/oliver/agent-runs/2026-10-29-writer-audit/aud11-export-research.md`.
It recommends a version-pinned, upstreamable change to the complete SVG exporter:
yield between complete container/bound-text render units while retaining the full
scene map, definitions, ordering and final iframe pass. The public API has no
scheduler/cancellation hook. Freehand export also computes the same path twice;
any fix must preserve canvas export's separate Path2D requirement. Separate
per-chunk SVG exports are unsafe. This is research, not an accepted implementation
plan; dependency strategy, plan reviews, fidelity checks and native measurements
remain required. No dependency or performance code changed.

The mixed fixture now has corrected bounds through AUD-12. Its degenerate zero-area
single-point stroke is normalized away by the existing restore path, and its frame
clipping needs closer inspection before treating that output as a fidelity oracle.
Oliver requested a pause after AUD-12. Resume only when requested.

## 2026-10-30: fixed with a dependency patch

`patches/@excalidraw__excalidraw@0.18.1.patch` makes `renderSceneToSvg` async. It renders the
same elements in the same order with the same renderer, and yields through a MessageChannel
once a slice passes 8ms. The drawing cache now lets one drawing exceed the byte budget when
nothing else is open; before, the 3.8MB fixture failed with a false "Too many large drawings".

Native e2e release builds, cold open, window in the background, 4ms interval gap monitor.
One run per build and drawing:

| Drawing                                     | Max gap before | Max gap after | Display before | Display after |
| ------------------------------------------- | -------------- | ------------- | -------------- | ------------- |
| Largest real SDU drawing (394KB compressed) | 53ms           | 38ms          | 660ms          | 571ms         |
| Big430 (1.37MB scene)                       | 545ms          | 63ms          | 1128ms         | 1238ms        |
| Huge1200 (3.8MB scene)                      | 1359ms         | 142ms         | 2075ms         | 2225ms        |

An earlier pair of runs agreed: Big430 442 to 55ms, Huge1200 1188 to 130ms. Display time rises
on the largest fixtures because the export now yields. SDU's own drawings never stalled badly,
so this protects larger drawings more than it changes SDU.

Fidelity: exported SVG is byte-identical between the two builds for a mixed fixture (frame,
bound text, arrow, link, freedraw, deleted element), the real drawing, Big430 and Huge1200.
Switching drawings during a Big430 export shows the second one without error. Create editable
copy still writes an `.excalidraw.svg` with its embedded scene. 1,838 frontend tests pass, and
`vp check` reports 0 errors.

Limits: while a drawing over budget stays open in any tab, every other drawing is refused with
an accurate message, and needs Retry after closing it. Cancellation doesn't stop a running
export; its result is discarded. One huge stroke and XML serialization still block. The patch
is tied to 0.18.1 and must be redone on upgrade. Not measured with the window in front. Saving
an existing `.excalidraw.svg` was not run natively, though it uses the same `exportToSvg` call
as the copy.
