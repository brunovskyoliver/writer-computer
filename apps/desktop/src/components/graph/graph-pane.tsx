import { lazy, Suspense, useMemo } from "react";
import * as editorApi from "@/hooks/editor-api";
import { useBooleanSetting } from "@/hooks/use-settings";
import { useGraphData, type GraphLinkDatum, type GraphNodeDatum } from "./use-graph-data";

// Lazy so the force-graph chunk (d3-force, canvas) only ships when the tab is
// actually opened — AI is opt-in and most sessions never render this.
const ForceGraph2D = lazy(() => import("react-force-graph-2d"));

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

/**
 * The note-relation graph (SPECs/ai-note-graph): every indexed markdown note
 * is a node; solid subtle edges are `[[wikilinks]]`, dashed accent edges are
 * embedding similarity, and solid accent edges are shared formulas
 * (line-relations-spec). Clicking a node opens the note in the editor.
 *
 * The pane renders while `ai.enabled` is off too — a hint instead of an
 * error, since the tab can outlive the toggle (open graph → disable AI).
 */
export function GraphPane() {
  const enabled = useBooleanSetting("ai.enabled", false);
  const graphData = useGraphData(enabled);

  const colors = useMemo(
    () => ({
      node: cssVar("--accent", "#ff6a00"),
      label: cssVar("--text-muted", "#888888"),
      link: cssVar("--line-subtle", "#555555"),
      similar: cssVar("--accent", "#ff6a00"),
    }),
    // Recomputed when the component re-renders (theme switch repaints via the
    // next `ai:graph-changed`; reading vars in render keeps this simple).
    [graphData],
  );

  if (!enabled) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        AI indexing is off — enable it in Settings → AI.
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-sm text-muted">
          Loading graph…
        </div>
      }
    >
      <ForceGraph2D
        graphData={graphData}
        nodeId="id"
        backgroundColor="rgba(0,0,0,0)"
        warmupTicks={60}
        cooldownTicks={120}
        nodeLabel={(node) => (node as GraphNodeDatum).name}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const datum = node as GraphNodeDatum;
          const radius = 3.5;
          ctx.beginPath();
          ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, 2 * Math.PI);
          ctx.fillStyle = colors.node;
          ctx.fill();
          const fontSize = 10 / globalScale;
          ctx.font = `${fontSize}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = colors.label;
          ctx.fillText(datum.name, node.x ?? 0, (node.y ?? 0) + radius + fontSize * 0.4);
        }}
        linkColor={(link) =>
          (link as GraphLinkDatum).kind === "link" ? colors.link : colors.similar
        }
        linkLineDash={(link) => ((link as GraphLinkDatum).kind === "similar" ? [4, 3] : null)}
        linkWidth={(link) => {
          const kind = (link as GraphLinkDatum).kind;
          return kind === "formula" ? 2 : kind === "link" ? 1.5 : 1;
        }}
        onNodeClick={(node) => {
          void editorApi.openFile((node as GraphNodeDatum).path);
        }}
      />
    </Suspense>
  );
}
