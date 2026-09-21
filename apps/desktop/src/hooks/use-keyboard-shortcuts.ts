import { saveDrawingSessions, reportDrawingSaveError } from "@/lib/drawing-sessions";
import { useEffect } from "react";
import { useUIStore } from "@/stores/ui-store";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { toggleSidebar } from "@/hooks/use-sidebar";
import { getWorkspaceChromeMode } from "@/lib/compact-mode";
import { findPane } from "@/lib/editor-layout";

function isEditableTargetFocused(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return true;
  if ((active as HTMLElement).isContentEditable) return true;
  // CodeMirror editors render a contenteditable inside .cm-editor
  return active.closest(".cm-editor") !== null;
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      // Read current state at event time
      const { openCommandPalette } = useUIStore.getState();
      const { root, chromeMode } = useWorkspaceStore.getState();
      const {
        layout,
        activeTabId,
        setActiveTab,
        openNewTab,
        closeActiveTab,
        navigateBack,
        navigateForward,
      } = useEditorStore.getState();
      // Tab cycling and Cmd+N address the focused pane's strip, the one the
      // user is looking at, not the window-wide tab list.
      const tabs = findPane(layout, layout.focusedPaneId)?.tabIds ?? [];
      const isCompactFileMode = getWorkspaceChromeMode(root, chromeMode) === "compact-file";

      // Alt+Arrow: history navigation when no editable target is focused;
      // inside the editor, let CodeMirror handle word-wise cursor motion.
      if (e.altKey && !e.shiftKey && e.key === "ArrowLeft" && !isEditableTargetFocused()) {
        e.preventDefault();
        void navigateBack();
        return;
      }

      if (e.altKey && !e.shiftKey && e.key === "ArrowRight" && !isEditableTargetFocused()) {
        e.preventDefault();
        void navigateForward();
        return;
      }

      // Plain Cmd+<key> only: Alt is not part of these shortcuts, and without
      // the guard Cmd+Alt+O would fire "go to file" over the editor's own
      // Mod-Alt chords (brace annotations, headings 1–6).
      const plainMod = mod && !e.altKey;

      // Cmd+P / Cmd+Shift+P — unified search (files + commands)
      if (plainMod && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        if (e.shiftKey || root) openCommandPalette("search");
        return;
      }

      // Cmd+Shift+F — search inside files (content search palette)
      if (plainMod && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        if (isCompactFileMode) return;
        if (root) openCommandPalette("content-search");
        return;
      }

      // Cmd+Shift+M — insert a math symbol (symbol palette intent)
      if (plainMod && e.shiftKey && (e.key === "m" || e.key === "M")) {
        e.preventDefault();
        if (activeTabId) openCommandPalette("insert-symbol");
        return;
      }

      // Cmd+W — close current tab
      if (plainMod && e.key === "w") {
        if (isCompactFileMode) return;
        e.preventDefault();
        if (activeTabId) closeActiveTab();
        return;
      }

      // Cmd+\ — toggle sidebar
      if (plainMod && e.key === "\\") {
        e.preventDefault();
        if (isCompactFileMode) return;
        toggleSidebar();
        return;
      }

      // Cmd+N — create new note
      if (plainMod && e.key === "n") {
        e.preventDefault();
        if (root) openCommandPalette("create-file");
        return;
      }

      // Cmd+O — go to file
      if (plainMod && e.key === "o") {
        e.preventDefault();
        if (root) openCommandPalette("search");
        return;
      }

      // Cmd+T — new tab
      if (plainMod && e.key === "t") {
        e.preventDefault();
        if (isCompactFileMode) return;
        if (root) openNewTab();
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        if (isCompactFileMode) return;
        if (tabs.length === 0 || !activeTabId) return;
        const idx = tabs.indexOf(activeTabId);
        if (idx === -1) return;
        const next = e.shiftKey ? (idx - 1 + tabs.length) % tabs.length : (idx + 1) % tabs.length;
        setActiveTab(tabs[next]!);
        return;
      }

      // Cmd+1 through Cmd+9 — jump to Nth tab
      if (plainMod && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        if (isCompactFileMode) return;
        const n = parseInt(e.key) - 1;
        if (n < tabs.length) {
          setActiveTab(tabs[n]!);
        }
        return;
      }
    }
    function captureDrawingKey(e: KeyboardEvent) {
      if (document.body.inert) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if ((e.target as Element | null)?.closest?.('[role="dialog"], dialog')) return;
      const mod = e.metaKey || e.ctrlKey;
      const { tabs, activeTabId } = useEditorStore.getState();
      if (mod && e.key.toLowerCase() === "s") {
        const tab = tabs.find((candidate) => candidate.id === activeTabId);
        if (tab?.location.kind === "drawing") {
          e.preventDefault();
          e.stopImmediatePropagation();
          void saveDrawingSessions(tab.location.path).catch(reportDrawingSaveError);
          return;
        }
      }
    }
    window.addEventListener("keydown", captureDrawingKey, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", captureDrawingKey, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
}
