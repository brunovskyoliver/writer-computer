import * as tauri from "@/lib/tauri";
import { useSettingsStore } from "@/stores/settings-store";
import {
  createPaneId,
  createSplitId,
  normalizeLayout,
  panes,
  removeTabs,
  validateLayout,
  type Layout,
  type LayoutNode,
} from "@/lib/editor-layout";
import {
  deserializeLocation,
  serializeLocation,
  type Location,
  type SerializedLocation,
} from "@/components/editor-area/page-kinds";

/**
 * The session wire format (SPECs/tab-tiling-splits/contracts/session.md)
 * and the one codec between it and the editor store's runtime shapes.
 *
 * The wire shape is snake_case JSON stored under the workspace root in the
 * app-data `sessions.json`. Rust reads and writes the same shape; both
 * sides validate it and both consume the fixtures under
 * `SPECs/tab-tiling-splits/fixtures/sessions/`, which is what keeps the two
 * declarations from drifting.
 *
 * Nothing here touches the store. Restore hands a decoded `{ tabs, layout }`
 * to the editor store's one restore action; persistence encodes what the
 * store already committed.
 */

// --- wire shape ---------------------------------------------------------------

export interface SessionTab {
  id: string;
  location: SerializedLocation;
  back: SerializedLocation[];
  forward: SerializedLocation[];
}

export type SessionNode =
  | { kind: "pane"; id: string; tab_ids: string[]; active_tab_id: string | null }
  | {
      kind: "split";
      id: string;
      axis: "x" | "y";
      ratio: number;
      children: [SessionNode, SessionNode];
    };

export interface SessionV2 {
  version: 2;
  tabs: SessionTab[];
  layout: { root: SessionNode; focused_pane_id: string };
}

/** What a stored record turned out to be. `missing` is normal; `malformed`
 *  is an error the user is told about and whose record is left alone. */
export type SessionRecord =
  | { status: "missing" }
  | { status: "ready"; session: SessionV2 }
  | { status: "malformed"; problems: string[] };

// --- parsing and validation ---------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLocation(value: unknown): value is SerializedLocation {
  return isObject(value) && typeof value.kind === "string";
}

function parseTab(value: unknown, index: number, problems: string[]): SessionTab | null {
  if (!isObject(value)) {
    problems.push(`tab ${index} is not an object`);
    return null;
  }
  const { id, location, back = [], forward = [] } = value;
  if (typeof id !== "string" || id.length === 0) problems.push(`tab ${index} has no id`);
  if (!isLocation(location)) problems.push(`tab ${index} has no location`);
  const history = (entries: unknown, name: string): SerializedLocation[] => {
    if (!Array.isArray(entries) || !entries.every(isLocation)) {
      problems.push(`tab ${index} has an invalid ${name} history`);
      return [];
    }
    return entries;
  };
  const backEntries = history(back, "back");
  const forwardEntries = history(forward, "forward");
  if (typeof id !== "string" || !isLocation(location)) return null;
  return { id, location, back: backEntries, forward: forwardEntries };
}

function parseNode(value: unknown, path: string, problems: string[]): SessionNode | null {
  if (!isObject(value)) {
    problems.push(`${path} is not an object`);
    return null;
  }
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : null;
  if (!id) problems.push(`${path} has no id`);

  if (value.kind === "pane") {
    const tabIds = Array.isArray(value.tab_ids) ? value.tab_ids : null;
    if (!tabIds || !tabIds.every((tabId) => typeof tabId === "string")) {
      problems.push(`${path} has invalid tab_ids`);
      return null;
    }
    const active = value.active_tab_id;
    if (active !== null && active !== undefined && typeof active !== "string") {
      problems.push(`${path} has an invalid active_tab_id`);
      return null;
    }
    if (!id) return null;
    return { kind: "pane", id, tab_ids: tabIds as string[], active_tab_id: active ?? null };
  }

  if (value.kind === "split") {
    const axis = value.axis;
    if (axis !== "x" && axis !== "y") problems.push(`${path} has an invalid axis`);
    const ratio = value.ratio;
    if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
      problems.push(`${path} ratio must be a finite number within (0, 1)`);
    }
    const children = Array.isArray(value.children) ? value.children : null;
    if (!children || children.length !== 2) {
      problems.push(`${path} must have exactly two children`);
      return null;
    }
    const first = parseNode(children[0], `${path}.children[0]`, problems);
    const second = parseNode(children[1], `${path}.children[1]`, problems);
    if (!id || !first || !second || (axis !== "x" && axis !== "y") || typeof ratio !== "number") {
      return null;
    }
    return { kind: "split", id, axis, ratio, children: [first, second] };
  }

  problems.push(`${path} has an unknown kind`);
  return null;
}

/** Structural checks the shape alone cannot express: unique ids, every tab
 *  owned by exactly one pane, active and focus members that exist. */
function validateSession(session: SessionV2, problems: string[]) {
  const tabIds = new Set<string>();
  for (const tab of session.tabs) {
    if (tabIds.has(tab.id)) problems.push(`duplicate tab id ${tab.id}`);
    tabIds.add(tab.id);
  }

  const nodeIds = new Set<string>();
  const owned = new Set<string>();
  const walk = (node: SessionNode, isRoot: boolean) => {
    if (nodeIds.has(node.id)) problems.push(`duplicate node id ${node.id}`);
    nodeIds.add(node.id);
    if (node.kind === "split") {
      for (const child of node.children) walk(child, false);
      return;
    }
    for (const tabId of node.tab_ids) {
      if (!tabIds.has(tabId)) problems.push(`pane ${node.id} references unknown tab ${tabId}`);
      if (owned.has(tabId)) problems.push(`tab ${tabId} appears in more than one pane`);
      owned.add(tabId);
    }
    if (node.tab_ids.length === 0) {
      if (!isRoot) problems.push(`empty pane ${node.id} must collapse`);
      if (node.active_tab_id !== null) problems.push(`empty pane ${node.id} has an active member`);
    } else if (node.active_tab_id === null || !node.tab_ids.includes(node.active_tab_id)) {
      problems.push(`pane ${node.id} has no active member`);
    }
  };
  walk(session.layout.root, true);

  for (const tabId of tabIds) {
    if (!owned.has(tabId)) problems.push(`tab ${tabId} is not in any pane`);
  }
  const focused = sessionPanes(session.layout.root).find(
    (pane) => pane.id === session.layout.focused_pane_id,
  );
  if (!focused) problems.push(`focused pane ${session.layout.focused_pane_id} does not exist`);
}

/** A legacy flat session: assign ids before anything is filtered so the
 *  active tab keeps its identity through pruning, then wrap in one pane. */
function migrateV1(raw: Record<string, unknown>, problems: string[]): SessionV2 | null {
  if (!Array.isArray(raw.tabs)) {
    problems.push("legacy session has no tab list");
    return null;
  }
  const tabs = raw.tabs.flatMap((entry, index) => {
    if (!isObject(entry)) {
      problems.push(`tab ${index} is not an object`);
      return [];
    }
    const parsed = parseTab({ ...entry, id: `tab-${index + 1}` }, index, problems);
    return parsed ? [parsed] : [];
  });
  const activeIndex = raw.active_index;
  const active =
    typeof activeIndex === "number"
      ? (tabs[activeIndex]?.id ?? tabs[0]?.id ?? null)
      : (tabs[0]?.id ?? null);
  return {
    version: 2,
    tabs,
    layout: {
      root: {
        kind: "pane",
        id: "pane-1",
        tab_ids: tabs.map((tab) => tab.id),
        active_tab_id: active,
      },
      focused_pane_id: "pane-1",
    },
  };
}

/**
 * Classify a stored record. An absent version and layout plus a tab list is
 * v1; anything else that is not a valid v2 is malformed, and malformed is
 * never quietly read as v1.
 */
export function parseSession(raw: unknown): SessionRecord {
  if (raw === null || raw === undefined) return { status: "missing" };
  const problems: string[] = [];
  if (!isObject(raw)) return { status: "malformed", problems: ["session record is not an object"] };

  let session: SessionV2 | null;
  if (raw.version === undefined && raw.layout === undefined) {
    session = migrateV1(raw, problems);
  } else if (raw.version !== 2) {
    return {
      status: "malformed",
      problems: [`unsupported session version ${String(raw.version)}`],
    };
  } else {
    const tabs = Array.isArray(raw.tabs)
      ? raw.tabs.flatMap((entry, index) => {
          const parsed = parseTab(entry, index, problems);
          return parsed ? [parsed] : [];
        })
      : (problems.push("session has no tab list"), []);
    const layout = isObject(raw.layout) ? raw.layout : null;
    if (!layout) problems.push("session has no layout");
    const root = layout ? parseNode(layout.root, "layout.root", problems) : null;
    const focused =
      layout && typeof layout.focused_pane_id === "string" ? layout.focused_pane_id : null;
    if (layout && !focused) problems.push("layout has no focused_pane_id");
    session =
      root && focused ? { version: 2, tabs, layout: { root, focused_pane_id: focused } } : null;
  }

  if (session && problems.length === 0) validateSession(session, problems);
  if (!session || problems.length > 0) return { status: "malformed", problems };
  return { status: "ready", session };
}

// --- pruning ------------------------------------------------------------------

function sessionPanes(node: SessionNode): Array<Extract<SessionNode, { kind: "pane" }>> {
  return node.kind === "pane" ? [node] : node.children.flatMap(sessionPanes);
}

function locationPath(location: SerializedLocation): string | null {
  return typeof location.path === "string" ? location.path : null;
}

function pruneNode(node: SessionNode, keep: Set<string>): SessionNode | null {
  if (node.kind === "split") {
    const first = pruneNode(node.children[0], keep);
    const second = pruneNode(node.children[1], keep);
    if (!first) return second;
    if (!second) return first;
    return { ...node, children: [first, second] };
  }
  const tabIds = node.tab_ids.filter((tabId) => keep.has(tabId));
  if (tabIds.length === 0) return null;
  let active = node.active_tab_id;
  if (active === null || !keep.has(active)) {
    // The tab that slides into the removed slot, else the one before it —
    // the slot counted among survivors, since earlier tabs may be gone too.
    const index = active === null ? 0 : node.tab_ids.indexOf(active);
    const slot = node.tab_ids.slice(0, index).filter((tabId) => keep.has(tabId)).length;
    active = tabIds[slot] ?? tabIds[tabIds.length - 1]!;
  }
  return { ...node, tab_ids: tabIds, active_tab_id: active };
}

/**
 * Drop tabs whose location is missing and history entries that reference a
 * missing path, collapse what that empties, and repair active and focus
 * members. Returns `null` when nothing remains — the caller restores the
 * launcher and persists an empty snapshot.
 */
export function pruneSession(
  session: SessionV2,
  isMissing: (path: string) => boolean,
): SessionV2 | null {
  const entryMissing = (location: SerializedLocation) => {
    const path = locationPath(location);
    return path !== null && isMissing(path);
  };
  const tabs = session.tabs.flatMap((tab) => {
    if (entryMissing(tab.location)) return [];
    return [
      {
        ...tab,
        back: tab.back.filter((entry) => !entryMissing(entry)),
        forward: tab.forward.filter((entry) => !entryMissing(entry)),
      },
    ];
  });
  const keep = new Set(tabs.map((tab) => tab.id));
  const root = pruneNode(session.layout.root, keep);
  if (!root) return null;
  const remaining = sessionPanes(root);
  const focused = remaining.some((pane) => pane.id === session.layout.focused_pane_id)
    ? session.layout.focused_pane_id
    : remaining[0]!.id;
  return { version: 2, tabs, layout: { root, focused_pane_id: focused } };
}

/** The path the bundled restore prefetches: the focused pane's active tab,
 *  when that is a plain file. */
export function focusedSessionFile(session: SessionV2): string | null {
  const focused = sessionPanes(session.layout.root).find(
    (pane) => pane.id === session.layout.focused_pane_id,
  );
  const tab = session.tabs.find((candidate) => candidate.id === focused?.active_tab_id);
  if (!tab || tab.location.kind !== "file") return null;
  return locationPath(tab.location);
}

// --- runtime codec --------------------------------------------------------------

export interface DecodedSession {
  tabs: Array<{ id: string; location: Location; back: Location[]; forward: Location[] }>;
  layout: Layout;
  /** Tabs dropped because their page kind is not registered here. */
  pruned: string[];
}

/**
 * Turn a validated session into runtime tabs and a layout. Locations go
 * through the page-kind registry; a kind this build does not know is pruned
 * with a diagnostic and its pane collapses. Every id is re-minted from the
 * live allocators so restored ids can never collide with ids minted since.
 */
export function decodeSession(session: SessionV2, mintTabId: () => string): DecodedSession {
  const pruned: string[] = [];
  const tabIds = new Map<string, string>();
  const tabs = session.tabs.flatMap((tab) => {
    const location = deserializeLocation(tab.location);
    if (!location) {
      pruned.push(`tab ${tab.id}: unsupported page kind ${tab.location.kind}`);
      return [];
    }
    const id = mintTabId();
    tabIds.set(tab.id, id);
    const history = (entries: SerializedLocation[]) =>
      entries.map(deserializeLocation).filter((entry): entry is Location => entry !== null);
    return [{ id, location, back: history(tab.back), forward: history(tab.forward) }];
  });

  const paneIds = new Map<string, string>();
  const toNode = (node: SessionNode): LayoutNode => {
    if (node.kind === "split") {
      return {
        kind: "split",
        id: createSplitId(),
        axis: node.axis,
        ratio: node.ratio,
        children: [toNode(node.children[0]), toNode(node.children[1])],
      };
    }
    const id = createPaneId();
    paneIds.set(node.id, id);
    const ids = node.tab_ids.flatMap((tabId) => tabIds.get(tabId) ?? []);
    const active = node.active_tab_id ? (tabIds.get(node.active_tab_id) ?? null) : null;
    return { kind: "pane", id, tabIds: ids, activeTabId: active };
  };
  const root = toNode(session.layout.root);
  const layout = normalizeLayout({
    root,
    focusedPaneId: paneIds.get(session.layout.focused_pane_id) ?? "",
    revision: 0,
  });
  return { tabs, layout, pruned };
}

/**
 * The snapshot to persist for a committed state, or `null` when nothing is
 * worth keeping. Transient launcher tabs never persist; removing them may
 * empty a pane, which collapses here exactly as it would at runtime.
 */
export function encodeSession(
  tabs: ReadonlyArray<{ id: string; location: Location; back: Location[]; forward: Location[] }>,
  layout: Layout,
): SessionV2 | null {
  const serialized = new Map<string, SessionTab>();
  for (const tab of tabs) {
    const location = serializeLocation(tab.location);
    if (!location) continue;
    const history = (entries: Location[]) =>
      entries.map(serializeLocation).filter((entry): entry is SerializedLocation => entry !== null);
    serialized.set(tab.id, {
      id: tab.id,
      location,
      back: history(tab.back),
      forward: history(tab.forward),
    });
  }
  const dropped = tabs.filter((tab) => !serialized.has(tab.id)).map((tab) => tab.id);
  const persisted = removeTabs(layout, dropped);
  if (serialized.size === 0 || validateLayout(persisted).length > 0) return null;

  const toNode = (node: LayoutNode): SessionNode =>
    node.kind === "pane"
      ? { kind: "pane", id: node.id, tab_ids: node.tabIds, active_tab_id: node.activeTabId }
      : {
          kind: "split",
          id: node.id,
          axis: node.axis,
          ratio: node.ratio,
          children: [toNode(node.children[0]), toNode(node.children[1])],
        };
  // Tab order follows the tree, so the list is deterministic for the same layout.
  const ordered = panes(persisted).flatMap((pane) =>
    pane.tabIds.flatMap((id) => serialized.get(id) ?? []),
  );
  return {
    version: 2,
    tabs: ordered,
    layout: { root: toNode(persisted.root), focused_pane_id: persisted.focusedPaneId },
  };
}

// --- persistence boundary --------------------------------------------------------

export interface SessionPersister {
  /** Queue a snapshot for `root`; the latest one wins after the debounce. */
  schedule: (root: string, snapshot: SessionV2 | null) => void;
  /** Write whatever is queued now, in order behind any write in flight. */
  flush: () => Promise<void>;
  /** Drop the queued snapshot and its timer: the workspace is going away. */
  cancel: () => void;
}

export const SESSION_SAVE_DEBOUNCE_MS = 500;

/**
 * One writer per window. Snapshots coalesce for the debounce, writes run one
 * behind another so an older snapshot can never overtake a newer one, and
 * `cancel` on reset makes a queued snapshot for a workspace that is gone
 * simply never happen.
 */
export function createSessionPersister(
  write: (root: string, snapshot: SessionV2 | null) => Promise<void>,
  delayMs = SESSION_SAVE_DEBOUNCE_MS,
): SessionPersister {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queued: { root: string; snapshot: SessionV2 | null } | null = null;
  let chain: Promise<void> = Promise.resolve();

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const job = queued;
    queued = null;
    if (!job) return chain;
    chain = chain
      .then(() => write(job.root, job.snapshot))
      .catch((error: unknown) => {
        console.error("[session] Failed to persist session", error);
      });
    return chain;
  };

  return {
    schedule: (root, snapshot) => {
      queued = { root, snapshot };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), delayMs);
    },
    flush,
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      queued = null;
    },
  };
}

// --- IPC wrappers ---------------------------------------------------------------

function restoreEnabled() {
  return Boolean(useSettingsStore.getState().settings["workspace.restore-open-files"]);
}

/** Persist a snapshot, or remove the record when `session` is null. A
 *  disabled restore setting makes this a no-op; a failed write is an error
 *  the caller sees. */
export async function saveSession(workspaceRoot: string, session: SessionV2 | null): Promise<void> {
  if (!restoreEnabled()) return;
  await tauri.saveSession(workspaceRoot, session);
}

/** Load and re-validate the workspace's record. Rust already classified it,
 *  but running the same codec here is what makes the two agree at runtime,
 *  not only in the fixture tests. */
export async function loadSession(workspaceRoot: string): Promise<SessionRecord> {
  if (!restoreEnabled()) return { status: "missing" };
  return classifyRecord(await tauri.loadSession(workspaceRoot));
}

/** A record as Rust returns it, re-checked by this side's codec. */
export function classifyRecord(record: tauri.SessionRecordData): SessionRecord {
  if (record.status === "malformed") return { status: "malformed", problems: record.problems };
  if (record.status === "missing") return { status: "missing" };
  return parseSession(record.session);
}
