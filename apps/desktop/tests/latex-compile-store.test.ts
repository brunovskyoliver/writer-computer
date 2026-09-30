import { afterEach, describe, expect, test, vi } from "vite-plus/test";

const { compileLatex } = vi.hoisted(() => ({ compileLatex: vi.fn() }));

vi.mock("@/lib/tauri", () => ({ compileLatex, latexRoot: vi.fn(), fileExists: vi.fn() }));
vi.mock("@/lib/save", () => ({ onFileSaved: vi.fn(), saveNow: vi.fn() }));
vi.mock("@/stores/editor-store", () => ({ useEditorStore: { getState: () => ({ tabs: [] }) } }));
vi.mock("@/components/editor-area/editor-notice-store", () => ({ showEditorNotice: vi.fn() }));

import { compileLatexSource, useLatexCompileStore } from "../src/stores/latex-compile-store";
import { usePdfRevisionStore } from "../src/stores/pdf-revision-store";

type Deferred = { resolve: (value: unknown) => void };

function okResult(root: string) {
  return {
    status: "ok",
    root,
    pdf_path: root.replace(/\.tex$/, ".pdf"),
    diagnostics: [],
    duration_ms: 1200,
    log: "",
  };
}

afterEach(() => {
  compileLatex.mockReset();
  useLatexCompileStore.setState({ builds: {}, roots: {} });
});

describe("compileLatexSource", () => {
  test("one compile per root; requests during it queue exactly one rerun", async () => {
    const pending: Deferred[] = [];
    compileLatex.mockImplementation(() => new Promise((resolve) => pending.push({ resolve })));

    const first = compileLatexSource("/w/main.tex");
    void compileLatexSource("/w/main.tex");
    void compileLatexSource("/w/main.tex");
    expect(compileLatex).toHaveBeenCalledTimes(1);
    expect(useLatexCompileStore.getState().builds["/w/main.tex"]?.state).toBe("compiling");

    pending[0]!.resolve(okResult("/w/main.tex"));
    await first;
    await vi.waitFor(() => expect(compileLatex).toHaveBeenCalledTimes(2));
    pending[1]!.resolve(okResult("/w/main.tex"));
    await vi.waitFor(() =>
      expect(useLatexCompileStore.getState().builds["/w/main.tex"]?.state).toBe("ok"),
    );
    expect(compileLatex).toHaveBeenCalledTimes(2);
  });

  test("a successful compile bumps the PDF's revision and shares the build with the root", async () => {
    compileLatex.mockResolvedValue(okResult("/w/main.tex"));
    const before = usePdfRevisionStore.getState().revisions["/w/main.pdf"] ?? 0;
    await compileLatexSource("/w/chap.tex");
    expect(usePdfRevisionStore.getState().revisions["/w/main.pdf"]).toBe(before + 1);
    const state = useLatexCompileStore.getState();
    expect(state.roots["/w/chap.tex"]).toBe("/w/main.tex");
    expect(state.builds["/w/main.tex"]?.state).toBe("ok");
  });

  test("a failed compile keeps pointing at the last good PDF", async () => {
    compileLatex.mockResolvedValueOnce(okResult("/w/main.tex"));
    await compileLatexSource("/w/main.tex");
    compileLatex.mockResolvedValueOnce({
      status: "failed",
      root: "/w/main.tex",
      pdf_path: null,
      diagnostics: [
        { file: "/w/main.tex", line: 5, message: "Undefined control sequence", severity: "error" },
      ],
      duration_ms: 80,
      log: "",
    });
    await compileLatexSource("/w/main.tex");
    const build = useLatexCompileStore.getState().builds["/w/main.tex"]!;
    expect(build.state).toBe("failed");
    expect(build.pdfPath).toBe("/w/main.pdf");
    expect(build.diagnostics[0]?.line).toBe(5);
  });
});
