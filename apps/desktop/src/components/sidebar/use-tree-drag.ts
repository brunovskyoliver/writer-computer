import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { DirEntry } from "@/types/fs";
import { editorDrag, type DragAdapter } from "@/hooks/use-editor-drag";
import type { FlatTreeItem } from "./flatten-tree";
import { canMoveInto, resolveDropDir, resolveDropRange } from "./tree-move";
import type { MoveOutcome } from "./use-move-entry";

export interface DropHighlight {
  top: number;
  height: number;
}

export interface DragGhostState {
  /** The grabbed entry — the ghost renders its icon and label like the row. */
  entry: DirEntry;
  count: number;
  /** Row geometry captured at grab time so the ghost matches its size/indent. */
  width: number;
  paddingLeft: string;
  /** Folder expansion, so the ghost's folder glyph matches the row. */
  isExpanded: boolean;
}

// How close to the scroll container's edge the pointer must be to auto-scroll,
// and how fast to scroll per animation frame.
const AUTO_SCROLL_EDGE_PX = 28;
const AUTO_SCROLL_SPEED_PX = 8;

interface UseTreeDragArgs {
  rootPath: string;
  flatItems: FlatTreeItem[];
  entryByPath: Map<string, DirEntry>;
  expandedDirs: Set<string>;
  moveEntry: (entry: DirEntry, destDir: string) => Promise<MoveOutcome>;
  toggleDirectory: (path: string) => Promise<void>;
  /** Clears the tree selection after a completed multi-item move. */
  clearSelection: () => void;
}

interface PendingDrag {
  /** Pointer offset within the grabbed row at press time, so the ghost lifts
   *  off exactly over the item and keeps the cursor at that same spot. */
  grabOffsetX: number;
  grabOffsetY: number;
  /** Grabbed row geometry, so the ghost matches its width and indent. */
  rowWidth: number;
  rowPaddingLeft: string;
  /** The grabbed row — drives the ghost's icon and name. */
  primary: DirEntry;
  entries: DirEntry[];
}

/** Nearest scrollable ancestor, used to auto-scroll the tree during a drag. */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (/(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * `data-tree-path` of the row whose vertical band contains `y` (1px gaps attach
 * to the row above), or null when `y` is above the first row. Rows are ordered
 * top-to-bottom, so iteration stops once a row begins below `y`. Used instead of
 * `elementFromPoint` because rows are non-hit-testable during a drag.
 */
function rowPathAtY(container: HTMLElement, y: number): string | null {
  const rows = container.querySelectorAll<HTMLElement>("[data-tree-path]");
  let above: string | null = null;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (y < rect.top) break;
    if (y <= rect.bottom) return row.getAttribute("data-tree-path");
    above = row.getAttribute("data-tree-path");
  }
  return above;
}

/**
 * Drag-and-drop for the file tree, as an adapter on the window's one pointer
 * coordinator (`editorDrag`). The coordinator owns the pointer: threshold,
 * capture, the per-frame pass, and every way the gesture ends. This hook
 * owns what only the tree knows — the ghost, autoscroll inside the tree,
 * which folder is under the pointer, and the move on disk.
 *
 * A release over the editor area is committed by the coordinator and never
 * reaches this hook, so a drag can open a file or move it, never both.
 *
 * Raw pointer events, not the HTML5 `draggable` API: the Tauri window has OS
 * drag-drop enabled for Finder-drop-to-open, which suppresses HTML5 DnD
 * events inside the webview.
 */
export function useTreeDrag({
  rootPath,
  flatItems,
  entryByPath,
  expandedDirs,
  moveEntry,
  toggleDirectory,
  clearSelection,
}: UseTreeDragArgs) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);

  // React state drives rendering. It changes infrequently (drag start/end, and
  // when the highlighted target folder changes) — the ghost *position* is moved
  // imperatively to avoid a re-render on every pointer move.
  const [draggingPaths, setDraggingPaths] = useState<Set<string> | null>(null);
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);
  const [dropHighlight, setDropHighlight] = useState<DropHighlight | null>(null);
  const [dragGhost, setDragGhost] = useState<DragGhostState | null>(null);

  // Latest-ref pattern: window listeners are registered once per drag, so they
  // read live props/state through this ref instead of capturing stale values.
  const latest = useRef({
    rootPath,
    entryByPath,
    expandedDirs,
    moveEntry,
    toggleDirectory,
    clearSelection,
  });
  latest.current = {
    rootPath,
    entryByPath,
    expandedDirs,
    moveEntry,
    toggleDirectory,
    clearSelection,
  };

  const pendingRef = useRef<PendingDrag | null>(null);
  const pointerPosRef = useRef({ x: 0, y: 0 });
  const dropTargetRef = useRef<string | null>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);

  const positionGhost = useCallback(() => {
    const ghost = ghostRef.current;
    const pending = pendingRef.current;
    if (!ghost || !pending) return;
    const { x, y } = pointerPosRef.current;
    // Anchor by the grab offset so the ghost starts exactly over the dragged
    // row and the cursor stays at the same spot within it.
    ghost.style.transform = `translate(${x - pending.grabOffsetX}px, ${y - pending.grabOffsetY}px)`;
    ghost.style.opacity = "1";
  }, []);

  // Resolve the folder under the pointer and, if at least one dragged item can
  // legally move there, highlight it as the drop target. While the editor has
  // claimed the pointer there is no tree target, whatever the geometry says.
  const updateDropTarget = useCallback((overEditor: boolean) => {
    const pending = pendingRef.current;
    if (!pending) return;
    const { x, y } = pointerPosRef.current;
    const { rootPath: root, entryByPath: entries } = latest.current;
    const container = containerRef.current;

    // Hit-test by geometry rather than `elementFromPoint`: rows are made
    // non-hit-testable during a drag (to avoid stuck `:hover`), so they wouldn't
    // be returned by `elementFromPoint` anyway.
    let dest: string | null = null;
    if (container && !overEditor) {
      const rect = container.getBoundingClientRect();
      const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      if (inside) {
        const path = rowPathAtY(container, y);
        const target = path ? (entries.get(path) ?? null) : null;
        dest = resolveDropDir(target, root);
      }
    }

    const valid =
      dest !== null && pending.entries.some((en) => canMoveInto(en.path, en.is_dir, dest!));
    const next = valid ? dest : null;
    if (dropTargetRef.current !== next) {
      dropTargetRef.current = next;
      setDropTargetDir(next);
    }
  }, []);

  // Auto-scroll the tree while the pointer sits near its top or bottom edge —
  // and only while it is inside the tree. A pointer parked over the editor
  // area at the same height must not scroll the sidebar.
  const autoScroll = useCallback(() => {
    const scroller = scrollParentRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const { x, y } = pointerPosRef.current;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
    if (y < rect.top + AUTO_SCROLL_EDGE_PX) {
      scroller.scrollTop -= AUTO_SCROLL_SPEED_PX;
    } else if (y > rect.bottom - AUTO_SCROLL_EDGE_PX) {
      scroller.scrollTop += AUTO_SCROLL_SPEED_PX;
    }
  }, []);

  const endDrag = useCallback(() => {
    document.body.classList.remove("tree-dragging");
    scrollParentRef.current = null;
    pendingRef.current = null;
    dropTargetRef.current = null;
    setDraggingPaths(null);
    setDropTargetDir(null);
    setDragGhost(null);
  }, []);

  const performDrop = useCallback(async (entries: DirEntry[], dest: string) => {
    const {
      moveEntry: move,
      toggleDirectory: toggle,
      expandedDirs: expanded,
      rootPath: root,
      clearSelection: clear,
    } = latest.current;

    const outcomes = await Promise.all(entries.map((entry) => move(entry, dest)));
    clear();

    // Reveal the destination so the moved items are visible.
    if (dest !== root && !expanded.has(dest)) {
      void toggle(dest);
    }

    const failures: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === "exists") {
        failures.push(`• "${outcome.entry.name}" — an item with that name already exists`);
      } else if (outcome.status === "error") {
        const message =
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        failures.push(`• "${outcome.entry.name}" — ${message}`);
      }
    }
    if (failures.length > 0) {
      window.alert(
        `Couldn't move ${failures.length} item${failures.length > 1 ? "s" : ""}:\n${failures.join("\n")}`,
      );
    }
  }, []);

  // Arm a drag for an already-decided set of rows. The caller (the tree's
  // pointer-down handler) owns selection and passes what should move, so drag
  // and selection are settled together at press time.
  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, entries: DirEntry[], primary: DirEntry) => {
      const rowRect = event.currentTarget.getBoundingClientRect();
      const rowPaddingLeft = getComputedStyle(event.currentTarget).paddingLeft;

      const pending: PendingDrag = {
        grabOffsetX: event.clientX - rowRect.left,
        grabOffsetY: event.clientY - rowRect.top,
        rowWidth: rowRect.width,
        rowPaddingLeft,
        primary,
        entries,
      };
      pendingRef.current = pending;
      pointerPosRef.current = { x: event.clientX, y: event.clientY };

      const adapter: DragAdapter = {
        onActivate: () => {
          setDraggingPaths(new Set(entries.map((entry) => entry.path)));
          setDragGhost({
            entry: primary,
            count: entries.length,
            width: pending.rowWidth,
            paddingLeft: pending.rowPaddingLeft,
            isExpanded: primary.is_dir && latest.current.expandedDirs.has(primary.path),
          });
          scrollParentRef.current = findScrollParent(containerRef.current);
          document.body.classList.add("tree-dragging");
        },
        onFrame: (point, overEditor) => {
          pointerPosRef.current = point;
          autoScroll();
          positionGhost();
          updateDropTarget(overEditor);
        },
        // A row renamed or deleted under the pointer — by the watcher, by a
        // second window — is no longer the thing the user picked up.
        isSourceValid: () => entries.every((entry) => latest.current.entryByPath.has(entry.path)),
        onRelease: () => {
          const dest = dropTargetRef.current;
          if (dest) void performDrop(entries, dest);
        },
        onEnd: endDrag,
      };

      // No pointer capture on the row: `.tree-dragging` makes rows
      // non-hit-testable for the drag, and WebKit stops delivering to a
      // captured element in that state (and fires `lostpointercapture`,
      // which cancels). The coordinator's window listeners track the
      // pointer on their own.
      editorDrag().arm(
        { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY },
        // A folder is not a document: the editor area offers nothing for a
        // selection that contains one, and the tree keeps its move behavior.
        {
          kind: "files",
          paths: entries.map((entry) => entry.path),
          droppable: entries.every((entry) => !entry.is_dir),
        },
        adapter,
      );
    },
    [autoScroll, endDrag, performDrop, positionGhost, updateDropTarget],
  );

  // Tear down a drag in progress if the tree unmounts mid-gesture.
  useEffect(
    () => () => {
      editorDrag().cancel();
    },
    [],
  );

  // Measure the destination "container" — the drop-target folder row plus its
  // visible descendants — into a single rectangle so it can be highlighted as
  // one block rather than per-row. Recomputed when the target or tree changes.
  // The setDropHighlight calls are mutually-exclusive early-return branches writing one state atom; at most one runs per pass, so there is no multi-render cascade.
  // eslint-disable-next-line react-doctor/no-cascading-set-state
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || dropTargetDir === null) {
      setDropHighlight(null);
      return;
    }
    const range = resolveDropRange(
      flatItems.map((item) => ({ path: item.entry.path, depth: item.depth })),
      dropTargetDir,
      rootPath,
    );
    const startEl =
      range &&
      container.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(range.startPath)}"]`);
    const endEl =
      range &&
      container.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(range.endPath)}"]`);
    if (!startEl || !endEl) {
      setDropHighlight(null);
      return;
    }
    const top = startEl.offsetTop;
    setDropHighlight({ top, height: endEl.offsetTop + endEl.offsetHeight - top });
  }, [dropTargetDir, flatItems, rootPath]);

  return { containerRef, ghostRef, draggingPaths, dropHighlight, dragGhost, beginDrag };
}
