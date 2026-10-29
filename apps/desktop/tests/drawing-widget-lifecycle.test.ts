import { expect, test, vi } from "vite-plus/test";
import type { EditorView } from "@codemirror/view";
const mocks = vi.hoisted(() => ({ release: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../src/lib/tauri", () => ({ fileExists: async () => true }));
vi.mock("../src/lib/obsidian-drawings", () => ({
  obsidianDrawings: {
    acquire: () => ({ result: Promise.resolve({ url: "blob:preview" }), release: mocks.release }),
    subscribe: () => mocks.unsubscribe,
  },
}));
import { __test } from "../src/components/editor-area/wiki-link-extension";

/** Only DOM operations used by widget construction; no layout or CM simulation. */
class ElementStub extends EventTarget {
  className = "";
  style = {};
  dataset = {};
  classList = { add() {}, remove() {} };
  children: ElementStub[] = [];
  appendChild(child: ElementStub) {
    this.children.push(child);
  }
  replaceChildren(...children: ElementStub[]) {
    this.children = children;
  }
}

test("an equal replacement widget releases resources attached to reused DOM", async () => {
  vi.stubGlobal("document", { createElement: () => new ElementStub() });
  try {
    const make = () =>
      new __test.ImageEmbedWidget(
        "![[a.excalidraw]]",
        "a.excalidraw.md",
        "/vault",
        "/vault/note.md",
      );
    const old = make();
    const replacement = make();
    expect(replacement.eq(old)).toBe(true);
    const dom = old.toDOM({ requestMeasure() {} } as unknown as EditorView);
    await vi.waitFor(() =>
      expect((dom as unknown as ElementStub).children[0]).toHaveProperty("src", "blob:preview"),
    );
    // CodeMirror transfers equal DOM to a new WidgetTile carrying this instance.
    replacement.destroy(dom);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    old.destroy(dom);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
