import { describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { isDrawingPath } from "../src/lib/drawings";

describe("isDrawingPath", () => {
  const cases: [path: string, expected: boolean][] = [
    ["/vault/notes/sketch.excalidraw.svg", true],
    ["sketch.excalidraw.svg", true],
    ["/vault/Sketch.EXCALIDRAW.SVG", true],
    ["/vault/notes/diagram.excalidraw.Svg", true],
    // A plain SVG is an image, not a drawing.
    ["/vault/notes/logo.svg", false],
    // Branch B's format was not taken.
    ["/vault/notes/sketch.excalidraw", false],
    ["/vault/notes/photo.png", false],
    ["/vault/notes/note.md", false],
    ["/vault/notes/README", false],
    // No stem: the whole name is the extension.
    ["/vault/notes/.excalidraw.svg", false],
    // The extension must be the suffix, not somewhere in the middle.
    ["/vault/notes/sketch.excalidraw.svg.bak", false],
    // A directory named like a drawing does not make its children drawings.
    ["/vault/sketch.excalidraw.svg/notes.md", false],
  ];

  for (const [path, expected] of cases) {
    test(`${path} → ${expected}`, () => {
      expect(isDrawingPath(path)).toBe(expected);
    });
  }
});
