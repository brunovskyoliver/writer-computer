import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const { compileLatex, latexRoot } = vi.hoisted(() => ({
  compileLatex: vi.fn(),
  latexRoot: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({ compileLatex, latexRoot, fileExists: vi.fn() }));
vi.mock("@/lib/save", () => ({ onFileSaved: vi.fn(), saveNow: vi.fn() }));
vi.mock("@/stores/editor-store", () => ({ useEditorStore: { getState: () => ({ tabs: [] }) } }));
vi.mock("@/components/editor-area/editor-notice-store", () => ({ showEditorNotice: vi.fn() }));

import { compileLatexSource, useLatexCompileStore } from "../src/stores/latex-compile-store";
import { notifyEditorReset } from "../src/lib/editor-reset";
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

beforeEach(() => {
  notifyEditorReset();
  latexRoot.mockReset();
  latexRoot.mockResolvedValue("/w/main.tex");
});

afterEach(() => {
  compileLatex.mockReset();
  useLatexCompileStore.setState({ builds: {}, roots: {} });
});

describe("compileLatexSource", () => {
  test("one compile per root; requests during it queue exactly one rerun", async () => {
    const pending: Deferred[] = [];
    compileLatex.mockImplementation(() => new Promise((resolve) => pending.push({ resolve })));

    const first = compileLatexSource("/w/main.tex");
    await vi.waitFor(() => expect(compileLatex).toHaveBeenCalledTimes(1));
    void compileLatexSource("/w/main.tex");
    void compileLatexSource("/w/main.tex");
    await vi.waitFor(() => expect(compileLatex).toHaveBeenCalledTimes(1));
    expect(useLatexCompileStore.getState().builds["/w/main.tex"]?.state).toBe("compiling");

    await vi.waitFor(() => expect(latexRoot).toHaveBeenCalledTimes(3));
    await Promise.resolve();
    await Promise.resolve();
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

test("initially unknown chapters join one resolved-root compile and one rerun", async () => {
  latexRoot.mockResolvedValue("/w/main.tex");
  let finish!: (value: unknown) => void;
  const firstRun = new Promise((resolve) => {
    finish = resolve;
  });
  compileLatex.mockReturnValue(firstRun);
  const a = compileLatexSource("/w/a.tex");
  const b = compileLatexSource("/w/b.tex");
  const another = compileLatexSource("/w/b.tex");
  try {
    await vi.waitFor(() => expect(compileLatex).toHaveBeenCalledTimes(1));
    expect(useLatexCompileStore.getState().roots).toMatchObject({
      "/w/a.tex": "/w/main.tex",
      "/w/b.tex": "/w/main.tex",
    });
    expect(Object.keys(useLatexCompileStore.getState().builds)).toEqual(["/w/main.tex"]);
  } finally {
    compileLatex.mockResolvedValue(okResult("/w/main.tex"));
    finish(okResult("/w/main.tex"));
    await Promise.all([a, b, another]);
  }
  await vi.waitFor(() => expect(compileLatex).toHaveBeenCalledTimes(2));
});

test("root lookup errors are explicit failed builds without launching an engine", async () => {
  latexRoot.mockRejectedValueOnce(new Error("lookup unavailable"));
  const result = await compileLatexSource("/w/chapter.tex");
  expect(result?.status).toBe("failed");
  expect(result?.diagnostics[0]?.message).toContain("lookup unavailable");
  expect(useLatexCompileStore.getState().builds["/w/chapter.tex"]?.state).toBe("failed");
  expect(compileLatex).not.toHaveBeenCalled();
});

test("missing roots clear an old source association and report no-root", async () => {
  useLatexCompileStore.setState({ roots: { "/w/chapter.tex": "/w/old.tex" } });
  latexRoot.mockResolvedValueOnce(null);
  const result = await compileLatexSource("/w/chapter.tex");
  expect(result?.status).toBe("no-root");
  expect(useLatexCompileStore.getState().roots["/w/chapter.tex"]).toBeUndefined();
  expect(useLatexCompileStore.getState().builds["/w/chapter.tex"]?.state).toBe("no-root");
  expect(compileLatex).not.toHaveBeenCalled();
});

test("reset during direct compile root lookup prevents launch and publication", async () => {
  let resolve!: (root: string) => void;
  latexRoot.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = compileLatexSource("/w/chapter.tex");
  notifyEditorReset();
  resolve("/w/main.tex");
  await pending;
  expect(compileLatex).not.toHaveBeenCalled();
  expect(useLatexCompileStore.getState()).toEqual({ builds: {}, roots: {} });
});

test("a newer lookup started by a roots subscriber owns the compile request", async () => {
  const source = "/w/chapter.tex";
  latexRoot.mockResolvedValueOnce("/w/old.tex").mockResolvedValueOnce("/w/new.tex");
  compileLatex.mockImplementation((path: string) =>
    okResult(useLatexCompileStore.getState().roots[path]!),
  );
  let newer: ReturnType<typeof compileLatexSource> | undefined;
  const unsubscribe = useLatexCompileStore.subscribe((state) => {
    if (!newer && state.roots[source] === "/w/old.tex") newer = compileLatexSource(source);
  });
  try {
    const old = await compileLatexSource(source);
    await newer;
    expect(old).toBeNull();
    expect(compileLatex).toHaveBeenCalledOnce();
    expect(useLatexCompileStore.getState().roots[source]).toBe("/w/new.tex");
  } finally {
    unsubscribe();
  }
});

test("a joined migrated result cannot replace the rerun's freshly resolved root", async () => {
  let finish!: (value: unknown) => void;
  compileLatex
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue(okResult("/w/main.tex"));
  const first = compileLatexSource("/w/a.tex");
  await vi.waitFor(() => expect(compileLatex).toHaveBeenCalledTimes(1));
  const joined = compileLatexSource("/w/b.tex");
  await vi.waitFor(() => expect(latexRoot).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  await Promise.resolve();
  finish(okResult("/w/other.tex"));
  await Promise.all([first, joined]);
  await vi.waitFor(() => expect(compileLatex).toHaveBeenCalledTimes(2));
  expect(useLatexCompileStore.getState().roots["/w/b.tex"]).toBe("/w/main.tex");
  expect(useLatexCompileStore.getState().builds["/w/main.tex"]?.state).toBe("ok");
});

test("a queued rerun resolves the latest requesting chapter root again", async () => {
  latexRoot
    .mockResolvedValueOnce("/w/main.tex")
    .mockResolvedValueOnce("/w/main.tex")
    .mockResolvedValue("/w/other.tex");
  let resolve!: (value: unknown) => void;
  compileLatex
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    )
    .mockResolvedValue(okResult("/w/other.tex"));
  const first = compileLatexSource("/w/a.tex");
  const joined = compileLatexSource("/w/b.tex");
  await vi.waitFor(() => expect(latexRoot).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(compileLatex).toHaveBeenCalledTimes(1));
  resolve(okResult("/w/main.tex"));
  await Promise.all([first, joined]);
  await vi.waitFor(() => expect(compileLatex).toHaveBeenCalledTimes(2));
  expect(compileLatex).toHaveBeenNthCalledWith(2, "/w/b.tex");
  expect(latexRoot).toHaveBeenCalledTimes(3);
  expect(useLatexCompileStore.getState().roots["/w/b.tex"]).toBe("/w/other.tex");
  expect(useLatexCompileStore.getState().builds["/w/other.tex"]?.state).toBe("ok");
});

test("a changed native root publishes only to its actual root and keeps that root's last PDF", async () => {
  const build = (pdfPath: string) => ({
    state: "ok" as const,
    diagnostics: [],
    durationMs: 1,
    pdfPath,
  });
  useLatexCompileStore.setState({
    builds: { "/w/main.tex": build("/w/main.pdf"), "/w/other.tex": build("/w/other.pdf") },
  });
  compileLatex.mockResolvedValueOnce({
    ...okResult("/w/other.tex"),
    status: "failed",
    pdf_path: null,
  });
  await compileLatexSource("/w/chapter.tex");
  const state = useLatexCompileStore.getState();
  expect(state.roots["/w/chapter.tex"]).toBe("/w/other.tex");
  expect(state.builds["/w/main.tex"]).toEqual(build("/w/main.pdf"));
  expect(state.builds["/w/other.tex"]?.state).toBe("failed");
  expect(state.builds["/w/other.tex"]?.pdfPath).toBe("/w/other.pdf");
});

test.each(["missing", "error", "old-root"] as const)(
  "a delayed %s root lookup cannot hide or queue over a newer build",
  async (kind) => {
    let resolve!: (value: string | null) => void;
    let reject!: (error: Error) => void;
    latexRoot.mockReturnValueOnce(
      new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      }),
    );
    const old = compileLatexSource("/w/chapter.tex");
    latexRoot.mockResolvedValue("/w/main.tex");
    compileLatex.mockResolvedValue(okResult("/w/main.tex"));
    await compileLatexSource("/w/chapter.tex");
    if (kind === "error") reject(new Error("old lookup failed"));
    else resolve(kind === "missing" ? null : "/w/old.tex");
    expect(await old).toBeNull();
    expect(compileLatex).toHaveBeenCalledTimes(1);
    expect(useLatexCompileStore.getState().roots["/w/chapter.tex"]).toBe("/w/main.tex");
    expect(useLatexCompileStore.getState().builds["/w/main.tex"]?.state).toBe("ok");
    expect(useLatexCompileStore.getState().builds["/w/chapter.tex"]).toBeUndefined();
  },
);

test.each([false, true])(
  "a migrated root result cannot overwrite an active or newer owner (finished=%s)",
  async (finished) => {
    latexRoot.mockResolvedValueOnce("/w/main.tex").mockResolvedValueOnce("/w/other.tex");
    let oldDone!: (value: unknown) => void;
    let newDone!: (value: unknown) => void;
    compileLatex
      .mockReturnValueOnce(
        new Promise((resolve) => {
          oldDone = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          newDone = resolve;
        }),
      );
    const old = compileLatexSource("/w/a.tex");
    await vi.waitFor(() => expect(compileLatex).toHaveBeenCalledTimes(1));
    const current = compileLatexSource("/w/b.tex");
    await vi.waitFor(() => expect(compileLatex).toHaveBeenCalledTimes(2));
    if (finished) {
      newDone({ ...okResult("/w/other.tex"), duration_ms: 987 });
      await current;
    }
    oldDone(okResult("/w/other.tex"));
    await old;
    const build = useLatexCompileStore.getState().builds["/w/other.tex"]!;
    expect(build.state).toBe(finished ? "ok" : "compiling");
    if (finished) expect(build.durationMs).toBe(987);
    else {
      newDone({ ...okResult("/w/other.tex"), duration_ms: 987 });
      await current;
    }
    expect(useLatexCompileStore.getState().builds["/w/other.tex"]?.durationMs).toBe(987);
  },
);
