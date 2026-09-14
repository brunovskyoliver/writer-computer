import { describe, expect, it } from "vite-plus/test";
import { reconcilePresentedTabs } from "../src/components/editor-area/use-tab-strip-presentation";
import type { Tab } from "../src/hooks/use-tabs";

const tab = (id: string): Tab => ({ id, location: { kind: "launcher" }, back: [], forward: [] });
const live = (ids: string[]) =>
  ids.map((id) => ({ tab: tab(id), exiting: false, exitLeft: false }));

describe("tab strip presentation", () => {
  it("keeps a removed middle tab before its surviving right neighbor", () => {
    const result = reconcilePresentedTabs(live(["a", "b", "c"]), [tab("a"), tab("c")]);
    expect(result.map((item) => item.tab.id)).toEqual(["a", "b", "c"]);
    expect(result[1]).toMatchObject({ exiting: true, exitLeft: false });
  });

  it("uses the left neighbor when closing the rightmost tab", () => {
    expect(reconcilePresentedTabs(live(["a", "b"]), [tab("a")])[1]).toMatchObject({
      exiting: true,
      exitLeft: true,
    });
  });

  it("revives a tab removed and restored during its exit without duplicating it", () => {
    const exiting = reconcilePresentedTabs(live(["a", "b"]), [tab("a")]);
    const restored = reconcilePresentedTabs(exiting, [tab("b"), tab("a")]);
    expect(restored.map((item) => [item.tab.id, item.exiting])).toEqual([
      ["b", false],
      ["a", false],
    ]);
  });

  it("retains multiple exits while respecting reordered live tabs and new tabs", () => {
    const result = reconcilePresentedTabs(live(["a", "b", "c", "d"]), [
      tab("c"),
      tab("a"),
      tab("e"),
    ]);
    expect(result.filter((item) => !item.exiting).map((item) => item.tab.id)).toEqual([
      "c",
      "a",
      "e",
    ]);
    expect(result.filter((item) => item.exiting).map((item) => item.tab.id)).toEqual(["b", "d"]);
  });
});
