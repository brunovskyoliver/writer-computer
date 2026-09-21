// Carries a landing target across the gap between `navigateToFile` (which
// triggers an async load + an editor swap) and the editor's first render
// of the new document. Keyed by the navigating tab and the absolute file
// path: two panes can show the same file, and only the tab that followed the
// link should scroll to the heading. Consumed exactly once.
//
// `anchor` is the original heading-link payload. `line` is the content-search
// payload (SPECs/global-content-search/contracts/line-target.md): the consume
// site re-finds `needle` on the line rather than trusting `offset` blindly,
// because the file may have changed since the scan.

export type PendingTarget =
  | { kind: "anchor"; slug: string }
  | { kind: "line"; line: number; offset: number; length: number; needle: string };

const pending = new Map<string, PendingTarget>();

function key(tabId: string, path: string) {
  return `${tabId}\n${path}`;
}

export function setPendingTarget(tabId: string, path: string, target: PendingTarget): void {
  pending.set(key(tabId, path), target);
}

export function setPendingAnchor(tabId: string, path: string, anchor: string): void {
  setPendingTarget(tabId, path, { kind: "anchor", slug: anchor });
}

export function setPendingLineTarget(
  tabId: string,
  path: string,
  target: { line: number; offset: number; length: number; needle: string },
): void {
  setPendingTarget(tabId, path, { kind: "line", ...target });
}

export function consumePendingAnchor(tabId: string, path: string): PendingTarget | undefined {
  const target = pending.get(key(tabId, path));
  if (target !== undefined) pending.delete(key(tabId, path));
  return target;
}
