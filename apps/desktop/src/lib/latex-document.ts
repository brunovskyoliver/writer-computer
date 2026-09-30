/**
 * LaTeX source files (`.tex`, `.bib`) and their compile results — the frontend
 * half of `src-tauri/src/commands/latex_compile.rs`.
 *
 * Rules: SPECs/latex-documents/spec.md.
 */

export type LatexDiagnostic = {
  /** Absolute path of the file the message is about, when the log names one. */
  file: string | null;
  /** 1-based line, when the log gives one. */
  line: number | null;
  message: string;
  severity: "error" | "warning";
};

export type LatexCompileStatus = "ok" | "failed" | "engine-missing" | "no-root";

export type LatexCompileResult = {
  status: LatexCompileStatus;
  root: string | null;
  pdf_path: string | null;
  diagnostics: LatexDiagnostic[];
  duration_ms: number;
  log: string;
};

const LATEX_SOURCE = /[^/\\]\.(tex|bib)$/i;

export function isLatexSourcePath(path: string): boolean {
  return LATEX_SOURCE.test(path);
}

/** `report.tex` → `report.pdf`: Tectonic writes the PDF beside its root. */
export function pdfPathForRoot(root: string): string {
  return root.replace(/\.tex$/i, ".pdf");
}

/** The first error, for one-line status text. */
export function firstError(diagnostics: LatexDiagnostic[]): LatexDiagnostic | null {
  return diagnostics.find((d) => d.severity === "error") ?? null;
}
