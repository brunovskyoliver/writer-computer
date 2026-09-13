import { drawingName } from "@/lib/drawings";
import { definePageKind } from "./types";

export type DrawingLocation = { kind: "drawing"; path: string };

// Behavior only — the view (the lazy Excalidraw host) is registered in
// `./views` so the data layer never imports the editor UI.
//
// `primaryPath` deliberately stays at the default `null`: a drawing is not an
// open *file*. It never enters `openFiles`, `drawing-pane` owns its own I/O,
// and publishing the path as `activeFilePath` would hand it to the markdown
// editor mount, the save scheduler and the statusbar as if it were a note.
// `paths` still reports it so rename/delete rewriting and session restore see
// the file.
export const drawingKind = definePageKind<"drawing", DrawingLocation>({
  kind: "drawing",
  title: (l) => drawingName(l.path),
  description: "Open drawing",
  keepAlive: true,
  fromPayload: (data) =>
    typeof data.path === "string" ? { kind: "drawing", path: data.path } : null,
  paths: (l) => [l.path],
  rewritePath: (l, from, to) => (l.path === from ? { ...l, path: to } : l),
  removePath: (l, path) => (l.path === path ? null : l),
  serialize: (l) => ({ path: l.path }),
});
