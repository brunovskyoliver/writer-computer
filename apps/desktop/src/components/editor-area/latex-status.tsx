import { firstError } from "@/lib/latex-document";
import { useLatexBuild } from "@/stores/latex-compile-store";
import { revealDiagnostic } from "./latex-commands";

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The compile state of a LaTeX source, in its footer (SPECs/latex-documents
 *  US4). A failure names the first error; clicking it goes to that line. */
export function LatexStatus({ filePath, tabId }: { filePath: string; tabId: string }) {
  const build = useLatexBuild(filePath);

  if (!build) {
    return <span data-latex-status="idle">⌘⌥P preview · ⌘↩ compile</span>;
  }

  const errors = build.diagnostics.filter((d) => d.severity === "error");
  const warnings = build.diagnostics.length - errors.length;

  switch (build.state) {
    case "compiling":
      return <span data-latex-status="compiling">Compiling…</span>;
    case "engine-missing":
      return (
        <span data-latex-status="engine-missing" className="text-[var(--danger,#cf222e)]">
          Tectonic not installed · brew install tectonic
        </span>
      );
    case "no-root":
      return <span data-latex-status="no-root">No main document · add % !TEX root = main.tex</span>;
    case "ok": {
      const seconds =
        build.durationMs !== null ? ` · ${(build.durationMs / 1000).toFixed(1)} s` : "";
      return (
        <span data-latex-status="ok">
          PDF updated{seconds}
          {warnings > 0 ? ` · ${plural(warnings, "warning")}` : ""}
        </span>
      );
    }
    case "failed": {
      const error = firstError(build.diagnostics);
      const where = error?.line != null ? `line ${error.line}: ` : "";
      return (
        <button
          type="button"
          data-latex-status="failed"
          className="min-w-0 truncate text-left text-[var(--danger,#cf222e)] hover:underline"
          title={error?.message}
          // Keep focus in the editor: the jump focuses it, and a button that
          // took focus on press would take it straight back.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (error) void revealDiagnostic(error, filePath, tabId);
          }}
        >
          {plural(errors.length, "error")}
          {error ? ` · ${where}${error.message}` : ""}
        </button>
      );
    }
  }
}
