import { expect, test, vi } from "vite-plus/test";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../src/lib/drawing-runtime", () => ({ loadDrawingRuntime: vi.fn() }));
import { loadDrawingRuntime } from "../src/lib/drawing-runtime";
import { exportDrawing } from "../src/lib/drawings";

test("display-only exports omit scene compression while editable exports retain it", async () => {
  const exportToSvg = vi.fn(async () => ({}));
  vi.mocked(loadDrawingRuntime).mockResolvedValue({ exportToSvg } as never);
  vi.stubGlobal(
    "XMLSerializer",
    class {
      serializeToString() {
        return "<svg/>";
      }
    },
  );
  try {
    const scene = { elements: [], appState: { exportEmbedScene: false }, files: {} };
    await exportDrawing(scene, { embedScene: false });
    await exportDrawing(scene);
    expect(exportToSvg).toHaveBeenNthCalledWith(1, {
      elements: [],
      appState: { exportEmbedScene: false, exportBackground: false },
      files: {},
    });
    expect(exportToSvg).toHaveBeenNthCalledWith(2, {
      elements: [],
      appState: { exportEmbedScene: true, exportBackground: false },
      files: {},
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
