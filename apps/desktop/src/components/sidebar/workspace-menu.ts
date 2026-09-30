import type { MenuItemSpec } from "@/components/editor-area/editor-context-menu";

/**
 * The sidebar switcher's menu (SPECs/workspace-switching-spec.md): every known
 * workspace, the current one checked; picking another shows it in this window
 * — or brings forward the window that already has it. "Open in New Window"
 * gives a workspace its own window, sidebar and tabs. Pure so the rules are
 * tested without the native menu.
 */

export interface WorkspaceMenuActions {
  switchTo: (path: string) => void;
  openInNewWindow: (path: string) => void;
  openFolder: () => void;
  openFolderInNewWindow: () => void;
  closeWorkspace: () => void;
  forget: (path: string) => void;
}

function folderName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function parentName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 2] ?? "/";
}

/** Folder names, with the parent folder added where two share a name. */
export function workspaceLabels(paths: string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const path of paths) counts.set(folderName(path), (counts.get(folderName(path)) ?? 0) + 1);
  return new Map(
    paths.map((path) => {
      const name = folderName(path);
      return [path, counts.get(name)! > 1 ? `${name} (${parentName(path)})` : name];
    }),
  );
}

export function workspaceMenuSpec(input: {
  root: string | null;
  recents: string[];
  /** Workspaces open in *other* windows. */
  openElsewhere: string[];
  actions: WorkspaceMenuActions;
}): MenuItemSpec[] {
  const { root, recents, openElsewhere, actions } = input;
  const elsewhere = new Set(openElsewhere);
  // Current first, then the ones with a window, then the rest by recency.
  const workspaces = [...new Set([...(root ? [root] : []), ...openElsewhere, ...recents])];
  const labels = workspaceLabels(workspaces);
  const others = workspaces.filter((path) => path !== root);
  const items: MenuItemSpec[] = [];

  for (const path of workspaces) {
    const current = path === root;
    items.push({
      kind: "check",
      id: `switch:${path}`,
      text: elsewhere.has(path) ? `${labels.get(path)} — other window` : labels.get(path)!,
      checked: current,
      action: () => {
        if (!current) actions.switchTo(path);
      },
    });
  }
  if (workspaces.length > 0) items.push({ kind: "separator" });

  items.push({
    kind: "submenu",
    text: "Open in New Window",
    items: [
      ...others.map(
        (path): MenuItemSpec => ({
          kind: "item",
          id: `window:${path}`,
          text: labels.get(path)!,
          action: () => actions.openInNewWindow(path),
        }),
      ),
      ...(others.length > 0 ? [{ kind: "separator" } as const] : []),
      {
        kind: "item",
        id: "window:folder",
        text: "Other Folder…",
        action: actions.openFolderInNewWindow,
      },
    ],
  });
  items.push({ kind: "item", id: "open-folder", text: "Open Folder…", action: actions.openFolder });

  const forgettable = recents.filter((path) => path !== root && !elsewhere.has(path));
  if (root || forgettable.length > 0) items.push({ kind: "separator" });
  if (root) {
    items.push({
      kind: "item",
      id: "close-workspace",
      text: "Close Workspace",
      action: actions.closeWorkspace,
    });
  }
  if (forgettable.length > 0) {
    items.push({
      kind: "submenu",
      text: "Remove from List",
      items: forgettable.map((path) => ({
        kind: "item",
        id: `forget:${path}`,
        text: labels.get(path)!,
        action: () => actions.forget(path),
      })),
    });
  }
  return items;
}
