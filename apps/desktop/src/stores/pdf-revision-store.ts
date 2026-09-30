import { create } from "zustand";

/**
 * A counter per PDF path, bumped when something rewrote the file in place —
 * a LaTeX recompile (SPECs/latex-documents FR-4). A `PdfPane` showing the path
 * loads the new revision beside the old one and swaps when it is ready, so a
 * recompile never blanks the preview. Paths never bumped read as revision 0.
 */
interface PdfRevisionState {
  revisions: Record<string, number>;
  bumpPdfRevision: (path: string) => void;
}

export const usePdfRevisionStore = create<PdfRevisionState>((set) => ({
  revisions: {},
  bumpPdfRevision: (path) => {
    set((state) => ({
      revisions: { ...state.revisions, [path]: (state.revisions[path] ?? 0) + 1 },
    }));
  },
}));

export function usePdfRevision(path: string): number {
  return usePdfRevisionStore((state) => state.revisions[path] ?? 0);
}
