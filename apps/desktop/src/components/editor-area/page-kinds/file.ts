import { isLatexSourcePath } from "@/lib/latex-document";
import { getFileName, getFileStem } from "@/lib/paths";
import { definePageKind } from "./types";

export type FileLocation = { kind: "file"; path: string };

// Behavior only — the view (EditorPane body + DocumentFooter chrome) is
// registered in `./views` so the data layer never imports the editor UI.
export const fileKind = definePageKind<"file", FileLocation>({
  kind: "file",
  // A LaTeX source keeps its extension, like the sidebar: `report.tex` and
  // its preview `report.pdf` are otherwise both "report".
  title: (l) => (isLatexSourcePath(l.path) ? getFileName(l.path) : getFileStem(l.path)),
  description: "Open file",
  keepAlive: true,
  supportsFileContextMenu: true,
  fromPayload: (data) => (typeof data.path === "string" ? { kind: "file", path: data.path } : null),
  paths: (l) => [l.path],
  primaryPath: (l) => l.path,
  rewritePath: (l, from, to) => (l.path === from ? { ...l, path: to } : l),
  removePath: (l, path) => (l.path === path ? null : l),
  serialize: (l) => ({ path: l.path }),
});
