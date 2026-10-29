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

test("preview and editable exports exclude deleted geometry without changing the live scene", async () => {
  const visible = Object.freeze({ id: "visible", type: "rectangle", isDeleted: false });
  const deleted = Object.freeze({ id: "deleted", type: "rectangle", isDeleted: true, x: -10000 });
  const front = Object.freeze({ id: "front", type: "text", isDeleted: false });
  const elements = Object.freeze([visible, deleted, front]);
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
    const scene = { elements, appState: {}, files: {} } as unknown as Parameters<
      typeof exportDrawing
    >[0];
    await exportDrawing(scene, { embedScene: false });
    await exportDrawing(scene);
    expect(exportToSvg).toHaveBeenCalledTimes(2);
    for (const [options] of exportToSvg.mock.calls as unknown as [{ elements: unknown[] }][]) {
      expect(options.elements).toEqual([visible, front]);
      expect(options.elements[0]).toBe(visible);
      expect(options.elements[1]).toBe(front);
    }
    expect(scene.elements).toBe(elements);
    expect(elements).toEqual([visible, deleted, front]);
  } finally {
    vi.unstubAllGlobals();
  }
});
