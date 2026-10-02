import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import { foldExtension } from "../src/lib/prosemark-core/main";
import {
  __testImage,
  imageExtension,
  attachStableImageHeight,
} from "../src/lib/prosemark-core/fold/image";
import type { EditorView } from "@codemirror/view";

function makeState(anchor = 0, url = "assets/diagram.png"): EditorState {
  const doc = `before\n\n![diagram](${url})\n\nafter`;
  let state = EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM] }), imageExtension],
    selection: EditorSelection.single(anchor),
  });
  ensureSyntaxTree(state, doc.length, 1000);
  state = state.update({ selection: state.selection }).state;
  return state;
}

function measuredImage(url: string, height: number) {
  const handlers = new Map<string, () => void>();
  const image = {
    style: { height: "" },
    addEventListener: (name: string, handler: () => void) => handlers.set(name, handler),
  };
  const measure = vi.fn();
  attachStableImageHeight(
    image as unknown as HTMLImageElement,
    { getBoundingClientRect: () => ({ height }) } as HTMLElement,
    url,
    { requestMeasure: measure } as unknown as EditorView,
  );
  return {
    image,
    measure,
    load: () => handlers.get("load")!(),
    error: () => handlers.get("error")!(),
  };
}

function findImageWidget(state: EditorState): { estimatedHeight: number } {
  let found: { estimatedHeight: number } | undefined;
  state.field(foldExtension).between(0, state.doc.length, (_from, _to, decoration) => {
    const widget = (decoration.spec as { widget?: { estimatedHeight?: number } }).widget;
    if (typeof widget?.estimatedHeight === "number") {
      found = widget as { estimatedHeight: number };
    }
  });
  if (!found) throw new Error("Expected a folded image widget");
  return found;
}

describe("imageExtension height stability", () => {
  beforeEach(() => {
    __testImage.imageHeightCache.clear();
  });

  test("unmeasured images report unknown height (-1)", () => {
    const widget = findImageWidget(makeState());
    expect(widget.estimatedHeight).toBe(-1);
  });

  test("widgets rebuilt after a measurement reuse the cached height", () => {
    __testImage.imageHeightCache.set("assets/diagram.png", 240);
    const widget = findImageWidget(makeState());
    expect(widget.estimatedHeight).toBe(240);
  });

  test("only 256 recent heights survive, with reads and overwrites refreshing recency", () => {
    for (let i = 0; i < 256; i++) measuredImage(`assets/${i}.png`, i + 1).load();
    expect(findImageWidget(makeState(0, "assets/0.png")).estimatedHeight).toBe(1);
    measuredImage("assets/256.png", 257).load();
    expect(__testImage.imageHeightCache.size).toBe(256);
    expect(__testImage.imageHeightCache.has("assets/1.png")).toBe(false);
    expect(findImageWidget(makeState(0, "assets/1.png")).estimatedHeight).toBe(-1);
    measuredImage("assets/2.png", 300).load();
    measuredImage("assets/257.png", 258).load();
    expect(__testImage.imageHeightCache.has("assets/3.png")).toBe(false);
    expect(findImageWidget(makeState(0, "assets/2.png")).estimatedHeight).toBe(300);
    measuredImage("assets/4.png", 0);
    measuredImage("assets/258.png", 259).load();
    expect(__testImage.imageHeightCache.has("assets/4.png")).toBe(true);
    expect(__testImage.imageHeightCache.has("assets/5.png")).toBe(false);
  });

  test("embedded image bytes and long destinations are not retained in cache keys", () => {
    const data = `data:image/png;base64,${"A".repeat(4096)}`;
    const long = `assets/${"b".repeat(4096)}.png`;
    measuredImage(data, 120).load();
    measuredImage(long, 240).load();
    expect(__testImage.imageHeightCache.has(data)).toBe(false);
    expect(__testImage.imageHeightCache.has(long)).toBe(false);
    expect([...__testImage.imageHeightCache.keys()].every((key) => key.length <= 512)).toBe(true);
    expect(findImageWidget(makeState(0, data)).estimatedHeight).toBe(120);
    expect(findImageWidget(makeState(0, long)).estimatedHeight).toBe(240);
    const short = "data:image/png;base64,AA";
    measuredImage(short, 60).load();
    expect(__testImage.imageHeightCache.has(short)).toBe(false);
    expect(findImageWidget(makeState(0, short)).estimatedHeight).toBe(60);
    const cutoff = "c".repeat(512);
    measuredImage(cutoff, 30).load();
    measuredImage(`${cutoff}d`, 40).load();
    expect(__testImage.imageHeightCache.has(cutoff)).toBe(true);
    expect(__testImage.imageHeightCache.has(`${cutoff}d`)).toBe(false);
    expect(findImageWidget(makeState(0, `${cutoff}d`)).estimatedHeight).toBe(40);
  });

  test("decode corrects a cached estimate and errors clear reserved height", () => {
    measuredImage("assets/shared.png", 120).load();
    const current = measuredImage("assets/shared.png", 180);
    expect(current.image.style.height).toBe("120px");
    current.load();
    expect(current.image.style.height).toBe("");
    expect(current.measure).toHaveBeenCalledOnce();
    const failed = measuredImage("assets/shared.png", 0);
    expect(failed.image.style.height).toBe("180px");
    failed.error();
    expect(failed.image.style.height).toBe("");
    expect(failed.measure).toHaveBeenCalledOnce();
    failed.load();
    expect(findImageWidget(makeState(0, "assets/shared.png")).estimatedHeight).toBe(180);
    expect(failed.measure).toHaveBeenCalledTimes(2);
  });
});
