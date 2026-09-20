import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

import {
  bumpDrawingRevision,
  getDrawingRevision,
  getVersionedImageSrc,
  notifyDrawingSaved,
  refreshDrawingEmbeds,
  resetDrawingRevisions,
  type ImageElementLike,
} from "../src/lib/drawing-embed-sync";

describe("drawing embed sync", () => {
  beforeEach(() => {
    resetDrawingRevisions();
  });

  test("versioned image src uses base url initially and query parameter after bump", () => {
    const path = "/workspace/diagram.excalidraw.svg";
    expect(getDrawingRevision(path)).toBeUndefined();
    expect(getVersionedImageSrc(path)).toBe(
      "asset://localhost/%2Fworkspace%2Fdiagram.excalidraw.svg",
    );

    const revision = bumpDrawingRevision(path);
    expect(getDrawingRevision(path)).toBe(revision);
    expect(getVersionedImageSrc(path)).toBe(
      `asset://localhost/%2Fworkspace%2Fdiagram.excalidraw.svg?v=${revision}`,
    );
  });

  test("refreshDrawingEmbeds updates matching img src with new revision", () => {
    const path = "/workspace/sketch.excalidraw.svg";
    const img: ImageElementLike = {
      dataset: { canonicalPath: path },
      src: "asset://localhost/%2Fworkspace%2Fsketch.excalidraw.svg",
    };
    const mockRoot = {
      querySelectorAll: () => [img],
    };

    refreshDrawingEmbeds(path, mockRoot);
    expect(img.src).toContain(`?v=`);
    expect(img.src).toContain(`sketch.excalidraw.svg`);
  });

  test("refreshDrawingEmbeds ignores non-drawing images when target is specified", () => {
    const targetPath = "/workspace/sketch.excalidraw.svg";
    const otherImg: ImageElementLike = {
      dataset: { canonicalPath: "/workspace/photo.png" },
      src: "asset://localhost/%2Fworkspace%2Fphoto.png",
    };
    const mockRoot = {
      querySelectorAll: () => [otherImg],
    };

    refreshDrawingEmbeds(targetPath, mockRoot);
    expect(otherImg.src).toBe("asset://localhost/%2Fworkspace%2Fphoto.png");
  });

  test("notifyDrawingSaved bumps revision", () => {
    const path = "/workspace/arch.excalidraw.svg";
    notifyDrawingSaved(path);
    const rev = getDrawingRevision(path);
    expect(rev).toBeDefined();
    expect(typeof rev).toBe("number");
  });
});
