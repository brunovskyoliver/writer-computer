import { pdfName } from "@/lib/pdf";
import { definePageKind } from "./types";

export type PdfLocation = { kind: "pdf"; path: string; page: number };

/** Restoring a tab at a bad page number is better than losing the tab: the
 *  page is clamped against the real page count at open anyway. */
function restorePage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

// Behavior only — the view (`PdfPane`) is registered in `./views` so the data
// layer never imports the editor UI.
//
// `primaryPath` deliberately stays at the default `null`, exactly as `drawing`
// does: a PDF is not an open *file*. Publishing the path as `activeFilePath`
// would hand it to the markdown editor mount, the save scheduler and the
// statusbar as if it were a note. `paths` still reports it so rename/delete
// rewriting and session restore see the file.
//
// `page` is the only mutable field on any location in this registry. Its
// write-back has two rules (see SPECs/pdf-quote-links/data-model.md): it is
// never a navigation, and it is coalesced on settle rather than written per
// scroll event. Both live at the write site in `stores/editor-store.ts`.
export const pdfKind = definePageKind<"pdf", PdfLocation>({
  kind: "pdf",
  title: (l) => pdfName(l.path),
  description: "Open PDF",
  keepAlive: true,
  fromPayload: (data) =>
    typeof data.path === "string"
      ? { kind: "pdf", path: data.path, page: restorePage(data.page) }
      : null,
  paths: (l) => [l.path],
  rewritePath: (l, from, to) => (l.path === from ? { ...l, path: to } : l),
  removePath: (l, path) => (l.path === path ? null : l),
  serialize: (l) => ({ path: l.path, page: l.page }),
});
