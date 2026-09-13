// Carries a heading slug across the gap between `navigateToFile` (which
// triggers an async load + an editor swap) and the editor's first render
// of the new document. Keyed by the navigating tab and the absolute file
// path: two panes can show the same file, and only the tab that followed the
// link should scroll to the heading. Consumed exactly once.

const pending = new Map<string, string>();

function key(tabId: string, path: string) {
  return `${tabId}\n${path}`;
}

export function setPendingAnchor(tabId: string, path: string, anchor: string): void {
  pending.set(key(tabId, path), anchor);
}

export function consumePendingAnchor(tabId: string, path: string): string | undefined {
  const anchor = pending.get(key(tabId, path));
  if (anchor !== undefined) pending.delete(key(tabId, path));
  return anchor;
}
