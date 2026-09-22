import { definePageKind } from "./types";

export type GraphLocation = { kind: "graph" };

// The view (GraphPane) is registered in `./views`. Stateless kind — one
// location, no payload, serialized as `{kind: "graph"}`.
export const graphKind = definePageKind<"graph", GraphLocation>({
  kind: "graph",
  title: () => "Graph",
  description: "Note relation graph",
  keepAlive: true,
});
