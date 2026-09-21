import { describe, expect, test } from "vite-plus/test";
import {
  anchorContentPoint,
  capturePointAnchor,
  pageAt,
  scrollForAnchor,
  wheelZoomFactor,
  type ZoomGeometry,
} from "../src/components/editor-area/pdf-zoom";

/** Two 600×800 pages at scale 1 with a 16px gap — the same shape
 *  `pageOffsets` produces in the pane. */
function geometry(scale: number, viewportWidth = 400): ZoomGeometry {
  const sizes = [
    { width: 600, height: 800 },
    { width: 600, height: 800 },
  ];
  const offsets = [0];
  let y = 0;
  for (const size of sizes) {
    y += size.height * scale + 16;
    offsets.push(Math.round(y));
  }
  return {
    offsets,
    sizes,
    scale,
    contentWidth: Math.max(viewportWidth, 600 * scale),
    pageCount: 2,
  };
}

describe("pageAt", () => {
  test("returns the last page starting at or above y", () => {
    const offsets = [0, 816, 1632];
    expect(pageAt(offsets, 0)).toBe(0);
    expect(pageAt(offsets, 815)).toBe(0);
    expect(pageAt(offsets, 816)).toBe(1);
    expect(pageAt(offsets, 5000)).toBe(1);
  });
});

describe("wheelZoomFactor", () => {
  test("pinch (ctrlKey) zooms in on negative deltaY and out on positive", () => {
    const pinch = { deltaMode: 0, ctrlKey: true, metaKey: false };
    expect(wheelZoomFactor({ ...pinch, deltaY: -10 })).toBeGreaterThan(1);
    expect(wheelZoomFactor({ ...pinch, deltaY: 10 })).toBeLessThan(1);
  });

  test("cmd-scroll also zooms, but much less per pixel than a pinch", () => {
    const pinch = wheelZoomFactor({ deltaY: -10, deltaMode: 0, ctrlKey: true, metaKey: false });
    const wheel = wheelZoomFactor({ deltaY: -10, deltaMode: 0, ctrlKey: false, metaKey: true });
    expect(wheel).toBeGreaterThan(1);
    expect(pinch).toBeGreaterThan(wheel);
  });

  test("line-mode deltas are coarsened to pixels instead of exploding", () => {
    const pixel = wheelZoomFactor({ deltaY: 5, deltaMode: 0, ctrlKey: true, metaKey: false });
    const line = wheelZoomFactor({ deltaY: 5, deltaMode: 1, ctrlKey: true, metaKey: false });
    expect(line).toBeLessThan(1);
    expect(line).not.toBe(pixel);
  });
});

describe("point anchors", () => {
  test("the captured point stays under the cursor through a zoom", () => {
    // Scroll 500 into the document, cursor at viewport position (200, 100).
    const before = geometry(1);
    const anchor = capturePointAnchor({
      clientX: 210,
      clientY: 150,
      containerLeft: 10,
      containerTop: 50,
      scrollLeft: 0,
      scrollTop: 500,
      geometry: before,
    });
    expect(anchor.kind).toBe("point");
    if (anchor.kind !== "point") return;
    // content point (200, 600) sits 75% down page 1, a third across it.
    expect(anchor.page).toBe(1);
    expect(anchor.fracY).toBeCloseTo(0.75);
    expect(anchor.fracX).toBeCloseTo(1 / 3);

    const after = geometry(2);
    const scroll = scrollForAnchor(anchor, after);
    const point = anchorContentPoint(anchor, after);
    // Whatever the scale, scroll + the viewport offset lands back on the point.
    expect(point.y - scroll.top).toBeCloseTo(anchor.relY);
    expect(point.x - scroll.left!).toBeCloseTo(anchor.relX);
  });

  test("a cursor in the page gap clamps to the page above's bottom edge", () => {
    const anchor = capturePointAnchor({
      clientX: 200,
      clientY: 810,
      containerLeft: 0,
      containerTop: 0,
      scrollLeft: 0,
      scrollTop: 0,
      geometry: geometry(1),
    });
    expect(anchor.kind).toBe("point");
    if (anchor.kind !== "point") return;
    expect(anchor.page).toBe(1);
    expect(anchor.fracY).toBe(1);
  });

  test("a cursor beside the page clamps horizontally", () => {
    // Viewport wider than the page: page centres, cursor lands in the margin.
    const anchor = capturePointAnchor({
      clientX: 50,
      clientY: 100,
      containerLeft: 0,
      containerTop: 0,
      scrollLeft: 0,
      scrollTop: 0,
      geometry: geometry(1, 900),
    });
    expect(anchor.kind).toBe("point");
    if (anchor.kind !== "point") return;
    expect(anchor.fracX).toBe(0);
  });
});

describe("scrollForAnchor", () => {
  test("a page-top anchor keeps that page's top at the viewport top", () => {
    // Scale 2: page 1 is 1600 tall, the gap stays 16 — page 2 starts at 1616.
    const scroll = scrollForAnchor({ kind: "page-top", page: 2 }, geometry(2));
    expect(scroll.top).toBe(1616);
    expect(scroll.left).toBeNull();
  });

  test("a page number past the end clamps to the last page", () => {
    const scroll = scrollForAnchor({ kind: "page-top", page: 99 }, geometry(1));
    expect(scroll.top).toBe(816);
  });
});
