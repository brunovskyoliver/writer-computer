import { describe, expect, test, vi } from "vite-plus/test";
import type { MenuItemSpec } from "../src/components/editor-area/editor-context-menu";
import { workspaceLabels, workspaceMenuSpec } from "../src/components/sidebar/workspace-menu";

function actions() {
  return {
    switchTo: vi.fn(),
    openInNewWindow: vi.fn(),
    openFolder: vi.fn(),
    openFolderInNewWindow: vi.fn(),
    closeWorkspace: vi.fn(),
    forget: vi.fn(),
  };
}

/** Menu rows as text; checked rows start with ✓, submenus list their rows. */
function outline(items: MenuItemSpec[]): unknown[] {
  return items.map((item) => {
    if (item.kind === "separator") return "---";
    if (item.kind === "submenu") return { [item.text]: outline(item.items) };
    if (item.kind === "check") return `${item.checked ? "✓ " : ""}${item.text}`;
    return item.text;
  });
}

function find(items: MenuItemSpec[], id: string): MenuItemSpec | undefined {
  for (const item of items) {
    if ((item.kind === "item" || item.kind === "check") && item.id === id) return item;
    if (item.kind === "submenu") {
      const found = find(item.items, id);
      if (found) return found;
    }
  }
  return undefined;
}

describe("workspaceMenuSpec", () => {
  test("lists every workspace, current checked, windows first, then recents", () => {
    const menu = workspaceMenuSpec({
      root: "/p/team-os",
      recents: ["/p/team-os", "/o/SDU", "/p/writer"],
      openElsewhere: ["/p/writer"],
      actions: actions(),
    });
    expect(outline(menu)).toEqual([
      "✓ team-os",
      "writer — other window",
      "SDU",
      "---",
      { "Open in New Window": ["writer", "SDU", "---", "Other Folder…"] },
      "Open Folder…",
      "---",
      "Close Workspace",
      { "Remove from List": ["SDU"] },
    ]);
  });

  test("picking another workspace switches; picking the current one does nothing", () => {
    const spy = actions();
    const menu = workspaceMenuSpec({
      root: "/p/a",
      recents: ["/p/a", "/p/b"],
      openElsewhere: [],
      actions: spy,
    });
    const pick = (id: string) => {
      const item = find(menu, id);
      if (item && (item.kind === "item" || item.kind === "check")) item.action();
    };
    pick("switch:/p/a");
    pick("switch:/p/b");
    pick("window:/p/b");
    pick("forget:/p/b");
    expect(spy.switchTo.mock.calls).toEqual([["/p/b"]]);
    expect(spy.openInNewWindow.mock.calls).toEqual([["/p/b"]]);
    expect(spy.forget.mock.calls).toEqual([["/p/b"]]);
  });

  test("with no workspace open there is nothing to close", () => {
    const menu = workspaceMenuSpec({
      root: null,
      recents: [],
      openElsewhere: [],
      actions: actions(),
    });
    expect(outline(menu)).toEqual([{ "Open in New Window": ["Other Folder…"] }, "Open Folder…"]);
  });

  test("folders sharing a name show their parent", () => {
    expect([...workspaceLabels(["/a/notes", "/b/notes", "/c/SDU"]).values()]).toEqual([
      "notes (a)",
      "notes (b)",
      "SDU",
    ]);
  });
});
