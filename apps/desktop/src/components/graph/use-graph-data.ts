import { useEffect, useMemo, useState } from "react";
import { aiGraph, type AiGraph } from "@/lib/ai";
import { useGraphVersion } from "@/hooks/use-ai";

export interface GraphNodeDatum {
  id: string;
  path: string;
  name: string;
  suggestedTags: string[];
}

export interface GraphLinkDatum {
  source: string;
  target: string;
  kind: "link" | "similar";
  score: number | null;
}

export interface GraphData {
  nodes: GraphNodeDatum[];
  links: GraphLinkDatum[];
}

/**
 * Fetch the AI graph for the current workspace and re-fetch on every
 * `ai:graph-changed` (the `graphVersion` bump). Disabled → empty data, no IPC.
 */
export function useGraphData(enabled: boolean): GraphData {
  const graphVersion = useGraphVersion();
  const [graph, setGraph] = useState<AiGraph>({ nodes: [], edges: [] });

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    aiGraph()
      .then((next) => {
        if (live) setGraph(next);
      })
      .catch((error) => console.error("[ai] ai_graph failed", error));
    return () => {
      live = false;
    };
  }, [enabled, graphVersion]);

  return useMemo(
    () => ({
      nodes: graph.nodes.map((node) => ({
        id: node.path,
        path: node.path,
        name: node.name,
        suggestedTags: node.suggested_tags,
      })),
      links: graph.edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        score: edge.score,
      })),
    }),
    [graph],
  );
}
