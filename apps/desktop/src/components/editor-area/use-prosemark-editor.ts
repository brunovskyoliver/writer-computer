import { useRef, useCallback, useEffect } from "react";
import { EditorView } from "@codemirror/view";
import { Compartment, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { history } from "@codemirror/commands";
import { closeEditorSearch } from "./editor-search-store";
import { findOuterScroller, scrollPosToSafeTop } from "./editor-scroll";
import { createEditorExtensions } from "./editor-extensions";
import { findHeadingBySlug } from "./link-navigation";
import { applyLineTarget } from "./line-target";
import { advanceViewportParse } from "./viewport-parse";
import { clampSelectionToHeadings } from "./heading-decorations";
import * as editorApi from "@/hooks/editor-api";
import { useReloadVersion } from "@/hooks/use-tabs";
import { getFileName } from "@/lib/paths";
import { editorFlavorForPath } from "@/lib/editor-flavor";
import { consumePendingAnchor, type PendingTarget } from "@/lib/pending-anchor";
import { logTimeline, mark } from "@/lib/startup-metrics";
import { showEditorNotice } from "./editor-notice-store";

function resolveScrollContainer(root: HTMLElement, getScrollContainer?: () => HTMLElement | null) {
  return getScrollContainer?.() ?? findOuterScroller(root);
}

function restoreCursorPosition(view: EditorView, cursorPos: number) {
  // Always dispatch a selection — even a no-op anchor: 0 — so the
  // `headingSelectionGuard` transactionFilter sees the initial selection and
  // clamps it out of any no-go zone (e.g., a doc that starts with a heading
  // would otherwise render the caret at lineFrom, which is the start of the
  // hash chars). `EditorState.create`'s default selection is at position 0
  // and isn't a transaction, so the filter never fires for it.
  let pos: number;
  if (cursorPos > 0) {
    pos = Math.min(cursorPos, view.state.doc.length);
  } else if (view.state.doc.toString() === "# ") {
    // New-file template from create_file_impl is "# "; land caret after it so the user can type the title immediately.
    pos = 2;
  } else {
    pos = 0;
  }
  view.dispatch({ selection: { anchor: pos } });
}

function restoreScrollPosition(
  scrollContainer: HTMLElement,
  scrollPos: number,
  isDisposed: () => boolean,
) {
  requestAnimationFrame(() => {
    if (isDisposed()) return;

    // Always apply the initial scroll so a new file can reset a reused container back to the top.
    scrollContainer.scrollTo(0, Math.max(0, scrollPos));
    if (scrollPos <= 0) return;

    // A fresh mount hasn't measured the whole document yet: the scroller's
    // scrollHeight keeps growing as CodeMirror lays out blocks, and a
    // scrollTo issued early gets clamped to whatever fits at that moment.
    // Re-apply the target on height changes and clamped shortfalls for a
    // bounded window — layout can grow in bursts separated by several idle
    // frames, so a short "stable" streak isn't proof of completion.
    let lastHeight = scrollContainer.scrollHeight;
    let frames = 0;
    const retry = () => {
      if (isDisposed() || ++frames > 90) return;
      const height = scrollContainer.scrollHeight;
      const max = Math.max(0, height - scrollContainer.clientHeight);
      const current = scrollContainer.scrollTop;
      if (Math.abs(current - scrollPos) <= 4) return; // landed
      if (current > scrollPos + 4) return; // user scrolled past — stop
      const grew = height !== lastHeight;
      lastHeight = height;
      if (grew || current >= max - 4) {
        scrollContainer.scrollTo(0, Math.min(scrollPos, max));
      }
      requestAnimationFrame(retry);
    };
    requestAnimationFrame(retry);
  });
}

/** Apply a consumed landing handoff — a heading anchor from a link, or a
 *  content-search line target. Shared by the swap effect and a fresh mount:
 *  a tab that had no editor (launcher, settings) mounts one when it resolves
 *  to a file, and its pending target must land there too. */
function applyPendingTarget(
  view: EditorView,
  scrollContainer: HTMLElement,
  target: PendingTarget,
  content: string,
  filePath: string,
  tabId: string,
  isDisposed: () => boolean,
) {
  if (target.kind === "anchor") {
    const heading = findHeadingBySlug(content, target.slug);
    if (heading) {
      requestAnimationFrame(() => {
        if (isDisposed()) return;
        scrollPosToSafeTop(view, scrollContainer, heading.pos, "auto");
      });
    } else {
      scrollContainer.scrollTo({ top: 0, behavior: "auto" });
      showEditorNotice(`Heading "#${target.slug}" not found in ${getFileName(filePath)}`, tabId);
    }
    return;
  }
  requestAnimationFrame(() => {
    if (isDisposed()) return;
    applyLineTarget(view, scrollContainer, target);
  });
}

export function useProsemarkEditor(
  tabId: string,
  filePath: string,
  getScrollContainer?: () => HTMLElement | null,
  autoFocus = false,
  onViewChange?: (view: EditorView | null) => void,
) {
  const viewRef = useRef<EditorView | null>(null);
  const tabIdRef = useRef(tabId);
  // Generation of this view's registration, so the cleanup cannot delete a
  // replacement view that React already mounted.
  const registrationRef = useRef(0);
  const scrollCleanupRef = useRef<(() => void) | null>(null);
  const disposedRef = useRef(false);
  const filePathRef = useRef(filePath);
  // getScrollContainer is captured into a ref only to resolve a DOM scroll container, not invoked as a callback from an effect.
  // eslint-disable-next-line react-doctor/no-event-handler
  const getScrollContainerRef = useRef(getScrollContainer);
  const autoFocusRef = useRef(autoFocus);
  const onViewChangeRef = useRef(onViewChange);
  const prevPathRef = useRef<string | null>(null);
  const prevReloadVersionRef = useRef<number>(0);
  const historyCompartmentRef = useRef<Compartment | null>(null);
  if (!historyCompartmentRef.current) historyCompartmentRef.current = new Compartment();

  const reloadVersion = useReloadVersion(filePath);

  // Keep refs in sync for use by closures and the swap effect.
  tabIdRef.current = tabId;
  filePathRef.current = filePath;
  getScrollContainerRef.current = getScrollContainer;
  autoFocusRef.current = autoFocus;
  onViewChangeRef.current = onViewChange;

  // Stable ref callback — only handles mount/unmount.
  const mountRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) {
      disposedRef.current = true;
      scrollCleanupRef.current?.();
      scrollCleanupRef.current = null;
      const view = viewRef.current;
      if (view) {
        closeEditorSearch({ view });
        editorApi.unregisterEditorView(tabIdRef.current, registrationRef.current);
        view.destroy();
      }
      viewRef.current = null;
      onViewChangeRef.current?.(null);
      return;
    }

    if (viewRef.current) return;

    disposedRef.current = false;

    const currentPath = filePathRef.current;
    const currentTabId = tabIdRef.current;
    // `content` is a debounced mirror — a mount must open at the live text,
    // not the last flush's, or the view would clobber unflushed keystrokes.
    editorApi.flushPendingEdit(currentPath);
    const file = editorApi.getOpenFile(currentPath);
    const initialContent = file?.content ?? "";
    const viewState = editorApi.getTabViewState(currentTabId, currentPath);

    const view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: initialContent,
        extensions: createEditorExtensions(
          () => filePathRef.current,
          () => tabIdRef.current,
          () => disposedRef.current,
          historyCompartmentRef.current!,
          // The flavor is fixed for the life of the view: `editor-pane` keys
          // the component by flavor, so a swap to a different one remounts
          // instead of reusing this view.
          editorFlavorForPath(currentPath),
        ),
      }),
    });

    viewRef.current = view;
    registrationRef.current = editorApi.registerEditorView(currentTabId, currentPath, view);
    prevPathRef.current = currentPath;
    prevReloadVersionRef.current = file?.reloadVersion ?? 0;
    onViewChangeRef.current?.(view);

    mark("editor-ready");
    logTimeline();

    advanceViewportParse(view, () => disposedRef.current);

    restoreCursorPosition(view, viewState.cursor);
    clampSelectionToHeadings(view);

    const scrollContainer = resolveScrollContainer(el, getScrollContainerRef.current);
    if (scrollContainer) {
      // A landing handoff queued before this mount (e.g. a search match
      // activated over a launcher tab) wins over the saved position.
      const pendingTarget = consumePendingAnchor(currentTabId, currentPath);
      if (pendingTarget !== undefined) {
        applyPendingTarget(
          view,
          scrollContainer,
          pendingTarget,
          initialContent,
          currentPath,
          currentTabId,
          () => disposedRef.current,
        );
      } else {
        restoreScrollPosition(scrollContainer, viewState.scroll, () => disposedRef.current);
      }

      const handleScroll = () => {
        editorApi.setTabScroll(tabIdRef.current, filePathRef.current, scrollContainer.scrollTop);
      };
      scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
      scrollCleanupRef.current = () => scrollContainer.removeEventListener("scroll", handleScroll);
    }

    if (autoFocusRef.current) view.focus();
  }, []);

  // Detect path or reload-version changes and swap the document in place.
  // Syncs the external CodeMirror EditorView to filePath/reloadVersion changes (tab switch / external reload); there is no DOM handler to host it.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || disposedRef.current) return;

    // eslint-disable-next-line react-doctor/no-event-handler
    const pathChanged = filePath !== prevPathRef.current;
    const reloaded = !pathChanged && reloadVersion !== prevReloadVersionRef.current;

    if (!pathChanged && !reloaded) return;

    prevPathRef.current = filePath;
    prevReloadVersionRef.current = reloadVersion;
    // The view is reused across a tab switch, so re-key it or an insert aimed
    // at this file would land in the note it used to show.
    if (pathChanged) editorApi.retargetEditorView(tabId, filePath);

    // A swap writes this text into the view — flush the pending mirror so
    // unflushed keystrokes survive the transition instead of being reverted.
    editorApi.flushPendingEdit(filePath);
    const file = editorApi.getOpenFile(filePath);
    const content = file?.content ?? "";

    const cursorPos = pathChanged
      ? Math.min(editorApi.getTabViewState(tabId, filePath).cursor, content.length)
      : Math.min(view.state.selection.main.head, content.length);

    if (pathChanged) {
      // Reset undo history per file. Removing the history compartment discards
      // its state field; re-adding initializes it fresh. Only history is in the
      // compartment, so the language state and every decoration field survive
      // and the swap doesn't flash raw markdown the way a full view.setState
      // would.
      const historyCompartment = historyCompartmentRef.current!;
      view.dispatch({ effects: historyCompartment.reconfigure([]) });
      view.dispatch({ effects: historyCompartment.reconfigure(history()) });
    }

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection: EditorSelection.cursor(cursorPos),
      annotations: Transaction.addToHistory.of(false),
      userEvent: pathChanged ? "writer.swap" : "writer.reload",
      scrollIntoView: false,
    });

    if (pathChanged) {
      const scrollContainer = resolveScrollContainer(
        view.dom.parentElement!,
        getScrollContainerRef.current,
      );
      if (scrollContainer) {
        const pendingTarget = consumePendingAnchor(tabId, filePath);
        if (pendingTarget !== undefined) {
          applyPendingTarget(
            view,
            scrollContainer,
            pendingTarget,
            content,
            filePath,
            tabId,
            () => disposedRef.current,
          );
        } else {
          restoreScrollPosition(
            scrollContainer,
            editorApi.getTabViewState(tabId, filePath).scroll,
            () => disposedRef.current,
          );
        }
      }
    }

    advanceViewportParse(view, () => disposedRef.current);
    clampSelectionToHeadings(view);
  }, [tabId, filePath, reloadVersion]);

  return mountRef;
}
