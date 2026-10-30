import { useEffect, useRef, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "cmdk";
import type { SearchResult } from "@/types/fs";
import {
  useCloseCommandPalette,
  useCommandPaletteIntent,
  useCommandPaletteSearch,
  useIsCommandPaletteOpen,
  useOpenCommandPalette,
  useSetCommandPaletteSearch,
} from "@/hooks/use-command-palette";
import { useSidebar } from "@/hooks/use-sidebar";
import {
  useCloseWorkspace,
  useIsCompactFileMode,
  useSwitchWorkspace,
  useWorkspace,
} from "@/hooks/use-workspace";
import { workspaceLabels } from "@/components/sidebar/workspace-menu";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { courseName, lessonsOn, localTime } from "@/lib/calendar";
import {
  useActiveFilePath,
  useActiveTabId,
  useCloseActiveTab,
  useCloseTab,
  useOpenFile,
  useOpenGraphTab,
  useOpenSettingsTab,
  useOpenTabs,
} from "@/hooks/use-tabs";
import { useTheme } from "@/hooks/use-theme";
import { useBooleanSetting, useSetSetting } from "@/hooks/use-settings";
import { useFuzzySearch } from "./use-fuzzy-search";
import { useGlobalRecentFiles } from "@/hooks/use-global-recent-files";
import { openStandaloneFile } from "@/hooks/use-open-drop";
import { settingsKind } from "@/components/editor-area/page-kinds/settings";
import { getFileExtension, getFileName, getFileStem, getParentDir } from "@/lib/paths";
import { aiRescan } from "@/lib/ai";
import { useAiPanelActions } from "@/hooks/use-ai";
import { graphKind } from "@/components/editor-area/page-kinds/graph";
import { DRAWING_EXTENSION, extractDrawingTitle, sanitizeDrawingStem } from "@/lib/drawings";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { useFocusedPaneId } from "@/hooks/use-editor-layout";
import { createAndOpenDrawing, createAndOpenFile } from "./open-routes";
import { getEditorView } from "@/lib/editor-views";
import { openAndFocusHighlightBar } from "@/components/editor-area/highlight-bar";
import {
  runEditorCommand,
  type EditorCommandId,
} from "@/components/editor-area/markdown-formatting";
import { ensureSyntaxTree } from "@codemirror/language";
import { mathContext } from "@/lib/latex-snippets/math-context";
import { isLatexSourcePath } from "@/lib/latex-document";
import { renderMath } from "@/components/editor-area/math-renderer";
import { searchSymbols, symbolInsertion, type MathSymbol } from "@/lib/math/symbols";
import * as tauri from "@/lib/tauri";
import type { RecentFile } from "@/lib/tauri";

/** Matrix re-bracketing commands the palette exposes; the registry labels
 *  carry the glyphs, so only the lookup table lives here. */
const MATRIX_PALETTE = [
  ["matrix-insert", "Matrix: Insert Matrix of Size…", "insert.matrix"],
  ["matrix-parens", "Matrix: Round Brackets", "matrix.parens"],
  ["matrix-square", "Matrix: Square Brackets", "matrix.square"],
  ["matrix-curly", "Matrix: Curly Braces", "matrix.curly"],
  ["matrix-bars", "Matrix: Single Bars", "matrix.bars"],
  ["matrix-double-bars", "Matrix: Double Bars", "matrix.doubleBars"],
  ["matrix-cases", "Matrix: Cases Brace", "matrix.cases"],
] as const satisfies ReadonlyArray<readonly [string, string, EditorCommandId]>;

/** Derivation/notation commands — same lookup-table shape as the matrix
 *  entries so both map through one row builder. */
const MATH_PALETTE = [
  ["math-tidy", "Math: Tidy Notation", "math.tidy"],
  ["math-align", "Math: Align Derivation Steps", "math.align"],
  ["math-split", "Math: Split Aligned Block Into Steps", "math.split"],
  ["math-check", "Math: Check Step Against Previous", "math.check"],
] as const satisfies ReadonlyArray<readonly [string, string, EditorCommandId]>;

/** LaTeX source commands — offered only while a `.tex`/`.bib` tab is active
 *  (SPECs/latex-documents FR-6). */
const LATEX_PALETTE = [
  ["latex-toggle-preview", "LaTeX: Toggle PDF Preview", "latex.togglePreview"],
  ["latex-compile", "LaTeX: Compile", "latex.compile"],
] as const satisfies ReadonlyArray<readonly [string, string, EditorCommandId]>;

/** The symbol's rendered glyph — KaTeX, same renderer the math widgets use. */
function SymbolGlyph({ code }: { code: string }) {
  const result = renderMath(code, false);
  if (result.error !== undefined) return <span className="w-7 shrink-0" />;
  return (
    <span
      className="w-7 shrink-0 text-center"
      // KaTeX output from renderMath — trust:false, no document text inside.
      dangerouslySetInnerHTML={{ __html: result.html }}
    />
  );
}

function toCreatePath(root: string, rawName: string) {
  const trimmed = rawName.trim();
  const fileName = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
  return `${root}/${fileName}`;
}

function matchesSearch(text: string, q: string) {
  return text.toLowerCase().includes(q.toLowerCase());
}

function HighlightedPath({ path, indices }: { path: string; indices: number[] }) {
  const set = new Set(indices);
  return (
    <span>
      {Array.from(path).map((char, i) => (
        <span key={i} className={set.has(i) ? "text-link font-semibold" : undefined}>
          {char}
        </span>
      ))}
    </span>
  );
}

export function CommandPalette() {
  const isOpen = useIsCommandPaletteOpen();
  const close = useCloseCommandPalette();
  const openCommandPalette = useOpenCommandPalette();
  const intent = useCommandPaletteIntent();
  const search = useCommandPaletteSearch();
  const setSearch = useSetCommandPaletteSearch();
  const { toggleSidebar } = useSidebar();
  const { root, isIndexing, openWorkspace, recentWorkspaces } = useWorkspace();
  const switchWorkspace = useSwitchWorkspace();
  const refreshRecentWorkspaces = useWorkspaceStore((s) => s.refreshRecentWorkspaces);
  const layouts = useWorkspaceStore((s) => s.layouts);
  const activeLayout = useWorkspaceStore((s) => s.activeLayout);
  // The recents list is shared by every window; one opened elsewhere since
  // this window loaded must still be offered as "Switch Workspace: …".
  useEffect(() => {
    if (isOpen) void refreshRecentWorkspaces();
  }, [isOpen, refreshRecentWorkspaces]);

  const calendarEvents = useCalendarStore((s) => s.events);
  const calendarConfigured = useCalendarStore((s) => s.configured);
  useEffect(() => {
    if (isOpen) useCalendarStore.getState().refreshIfStale();
  }, [isOpen]);
  const closeWorkspace = useCloseWorkspace();
  const openFile = useOpenFile();
  const closeActiveTab = useCloseActiveTab();
  const closeTab = useCloseTab();
  const activeTabId = useActiveTabId();
  const activeFilePath = useActiveFilePath();
  const focusedPaneId = useFocusedPaneId();
  const tabs = useOpenTabs();
  const { toggleTheme } = useTheme();
  const openSettingsTab = useOpenSettingsTab();
  const openGraphTab = useOpenGraphTab();
  const isCompactFileMode = useIsCompactFileMode();
  const isVimMode = useBooleanSetting("editor.vim-mode", false);
  const aiEnabled = useBooleanSetting("ai.enabled", false);
  const { openPanel } = useAiPanelActions();
  const setSetting = useSetSetting();

  const isCreateIntent = intent === "create-file";
  const isDrawingIntent = intent === "create-drawing";
  const isSymbolIntent = intent === "insert-symbol";
  const trimmedSearch = search.trim();
  const fileQuery = isCreateIntent || isDrawingIntent || isSymbolIntent ? "" : search;
  // Standalone compact windows have no workspace index — search filters the
  // global recents list client-side instead of hitting fuzzy_search.
  const results = useFuzzySearch(isCompactFileMode ? "" : fileQuery);
  const { files: globalRecents } = useGlobalRecentFiles(30, isOpen && isCompactFileMode);
  // In standalone mode new files are created next to the active file.
  const createBaseDir = root ?? (activeFilePath ? getParentDir(activeFilePath) : null);
  const createPath =
    createBaseDir && trimmedSearch ? toCreatePath(createBaseDir, trimmedSearch) : null;

  function handleSelect(path: string) {
    void (isCompactFileMode ? openStandaloneFile(path) : openFile(path));
    close();
  }

  // The pane and tab the palette was opened over. Captured at click time so
  // the create routes, which write to disk first, open into the pane the user
  // was in rather than whichever pane is focused when the write finishes.
  const origin = () => ({ paneId: focusedPaneId, tabId: activeTabId });

  function handleCreate() {
    if (!createPath) return;

    close();
    void (async () => {
      if (isCompactFileMode) {
        await tauri.createFile(createPath);
        await openStandaloneFile(createPath);
      } else {
        await createAndOpenFile(createPath, origin());
      }
    })();
  }

  // With no note in front (launcher, settings, another drawing tab)
  // `activeFilePath` is null, so the drawing lands in the workspace root and
  // nothing is inserted. Drawings go in the note's own directory: Writer has
  // no attachment-folder concept and this does not add one.
  function handleCreateDrawing() {
    const noteDir = activeFilePath ? getParentDir(activeFilePath) : root;
    if (!noteDir) return;
    close();
    void createAndOpenDrawing(noteDir, activeFilePath, trimmedSearch, origin()).catch((error) => {
      console.error("[command-palette] Failed to create drawing:", error);
      showEditorNotice(
        `Could not create drawing: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** Insert the symbol's `\code` at the editor caret — bare inside math,
   *  wrapped in `$…$` in prose. A `{}` group in the code takes the caret. */
  function handleInsertSymbol(symbol: MathSymbol) {
    const view = activeTabId ? getEditorView(activeTabId) : null;
    close();
    if (!view) {
      showEditorNotice("No editor to insert into.");
      return;
    }
    const state = view.state;
    const sel = state.selection.main;
    ensureSyntaxTree(state, state.doc.lineAt(sel.head).to, 50);
    const kind = mathContext(state, sel.head).kind;
    const inMath = kind === "inline" || kind === "display" || kind === "text";

    const { text, caret } = symbolInsertion(symbol.code, inMath);
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + caret },
      userEvent: "input.symbol",
    });
    view.focus();
  }

  async function handleOpenWorkspace() {
    const picked = await tauri.pickWorkspace();
    if (picked) {
      // Standalone compact windows stay pure — workspaces open elsewhere.
      if (isCompactFileMode) {
        await tauri.openWorkspaceInNewWindow(picked);
      } else {
        await openWorkspace(picked);
      }
    }
    close();
  }

  type Command = { id: string; label: string; description: string; run: () => void };

  function runPaletteAction(action: () => Promise<void>) {
    close();
    void action().catch((error) => {
      showEditorNotice(error instanceof Error ? error.message : String(error));
    });
  }

  const commands: Command[] = [
    ...(root && !isCompactFileMode
      ? lessonsOn(calendarEvents, new Date()).map(
          (event): Command => ({
            id: `lesson-${event.occurrence_key}`,
            label: `Lesson: ${localTime(event.start)} ${courseName(event.summary) ?? event.summary}`,
            description: "Open or create this lesson's note",
            run: () => runPaletteAction(() => useCalendarStore.getState().openLesson(event)),
          }),
        )
      : []),
    root &&
      !isCompactFileMode &&
      calendarConfigured && {
        id: "refresh-calendar",
        label: "Refresh Calendar",
        description: "Command",
        run: () => runPaletteAction(() => useCalendarStore.getState().refresh()),
      },
    ...(root && !isCompactFileMode
      ? layouts.flatMap((name): Command[] => [
          {
            id: `open-layout-${name}`,
            label: `Layout: ${name}`,
            description: name === activeLayout ? "Current layout" : "Command",
            run: () => runPaletteAction(() => useWorkspaceStore.getState().openLayout(name)),
          },
          {
            id: `delete-layout-${name}`,
            label: `Delete Layout: ${name}`,
            description: "Command",
            run: () => runPaletteAction(() => useWorkspaceStore.getState().deleteLayout(name)),
          },
        ])
      : []),
    root &&
      !isCompactFileMode && {
        id: "toggle-sidebar",
        label: "Toggle Sidebar",
        description: "Command",
        run: () => {
          toggleSidebar();
          close();
        },
      },
    (root || (isCompactFileMode && activeFilePath)) && {
      id: "new-file",
      label: "Create New File",
      description: "Command",
      run: () => openCommandPalette("create-file"),
    },
    root &&
      !isCompactFileMode && {
        id: "new-drawing",
        label: "Create New Drawing",
        description: "Command",
        run: () => openCommandPalette("create-drawing"),
      },
    root &&
      activeFilePath && {
        id: "open-in-compact-window",
        label: "Open File in Compact Window",
        description: "Command",
        run: () => {
          void tauri.openFileInStandaloneWindow(activeFilePath);
          close();
        },
      },
    activeTabId &&
      !isCompactFileMode && {
        id: "close-tab",
        label: "Close Current Tab",
        description: "Command",
        run: () => {
          closeActiveTab();
          close();
        },
      },
    tabs.length > 0 &&
      !isCompactFileMode && {
        id: "close-all",
        label: "Close All Tabs",
        description: "Command",
        run: () => {
          for (const tab of tabs) closeTab(tab.id);
          close();
        },
      },
    {
      id: "open-workspace",
      label: "Open Workspace",
      description: "Command",
      run: () => void handleOpenWorkspace(),
    },
    // One row per other known workspace: shown here, or in the window that
    // already has it (SPECs/workspace-switching-spec.md).
    ...(isCompactFileMode ? [] : recentWorkspaces)
      .filter((path) => path !== root)
      .map(
        (path): Command => ({
          id: `switch-workspace:${path}`,
          label: `Switch Workspace: ${workspaceLabels(recentWorkspaces).get(path)}`,
          description: "Command",
          run: () => {
            close();
            switchWorkspace(path);
          },
        }),
      ),
    root && {
      id: "close-workspace",
      label: "Close Workspace",
      description: "Command",
      run: () => {
        closeWorkspace();
        close();
      },
    },
    {
      id: "toggle-theme",
      label: "Toggle Dark Mode",
      description: "Command",
      run: () => {
        toggleTheme();
        close();
      },
    },
    {
      id: "toggle-vim-mode",
      label: "Toggle Vim Mode",
      description: "Command",
      run: () => {
        void setSetting("editor.vim-mode", !isVimMode);
        close();
      },
    },
    !isCompactFileMode && {
      id: "open-settings",
      label: "Settings",
      description: settingsKind.description,
      run: () => {
        openSettingsTab();
        close();
      },
    },
    root &&
      !isCompactFileMode &&
      aiEnabled && {
        id: "open-graph",
        label: "Open Graph",
        description: graphKind.description,
        run: () => {
          openGraphTab();
          close();
        },
      },
    root &&
      activeFilePath &&
      aiEnabled &&
      ["md", "markdown"].includes(getFileExtension(activeFilePath).toLowerCase()) && {
        id: "ai-suggest-tags",
        label: "AI: Suggest Tags for Current Note",
        description: "Command",
        run: () => {
          close();
          void openPanel(activeFilePath);
        },
      },
    root &&
      !isCompactFileMode &&
      aiEnabled && {
        id: "ai-rescan",
        label: "AI: Rescan Note Index",
        description: "Command",
        run: () => {
          void aiRescan();
          close();
        },
      },
    activeTabId && {
      id: "insert-symbol",
      label: "Insert Math Symbol",
      description: "Command",
      run: () => openCommandPalette("insert-symbol"),
    },
    activeTabId && {
      id: "highlight",
      label: "Highlight Selection",
      description: "Command",
      run: () => {
        close();
        const view = getEditorView(activeTabId);
        if (view) {
          openAndFocusHighlightBar(view);
        }
      },
    },
    activeTabId && {
      id: "underbrace",
      label: "Underbrace Annotation",
      description: "Command",
      run: () => {
        close();
        const view = getEditorView(activeTabId);
        if (view) runEditorCommand(view, "insert.underbrace");
      },
    },
    activeTabId && {
      id: "overbrace",
      label: "Overbrace Annotation",
      description: "Command",
      run: () => {
        close();
        const view = getEditorView(activeTabId);
        if (view) runEditorCommand(view, "insert.overbrace");
      },
    },
    ...(activeTabId
      ? [
          ...(activeFilePath && isLatexSourcePath(activeFilePath) ? LATEX_PALETTE : []),
          ...MATRIX_PALETTE,
          ...MATH_PALETTE,
        ].map(
          ([id, label, command]): Command => ({
            id,
            label,
            description: "Command",
            run: () => {
              close();
              const view = getEditorView(activeTabId);
              if (view) runEditorCommand(view, command);
            },
          }),
        )
      : []),
    // Last, so Enter never saves a layout while another command matches.
    root &&
      !isCompactFileMode &&
      trimmedSearch && {
        id: "save-layout",
        label: `Save Layout as “${trimmedSearch}”`,
        description: "Command",
        run: () => runPaletteAction(() => useWorkspaceStore.getState().saveLayoutAs(trimmedSearch)),
      },
  ].filter((c): c is Command => Boolean(c));

  const visibleFiles: SearchResult[] =
    !isCreateIntent && !isDrawingIntent && trimmedSearch && !isCompactFileMode ? results : [];
  const visibleRecents: RecentFile[] =
    !isCreateIntent && !isDrawingIntent && isCompactFileMode && trimmedSearch
      ? globalRecents.filter(
          (entry) =>
            matchesSearch(entry.title ?? "", trimmedSearch) ||
            matchesSearch(entry.name, trimmedSearch) ||
            matchesSearch(entry.path, trimmedSearch),
        )
      : [];
  const visibleCommands =
    isCreateIntent || isDrawingIntent || isSymbolIntent
      ? []
      : trimmedSearch
        ? commands.filter((c) => matchesSearch(c.label, trimmedSearch))
        : commands;

  const visibleSymbols = isSymbolIntent ? searchSymbols(trimmedSearch) : [];

  const drawingActionValue = "create-drawing-action";
  const firstValue = isSymbolIntent
    ? visibleSymbols[0]
      ? `sym-${visibleSymbols[0].code}`
      : ""
    : isDrawingIntent
      ? drawingActionValue
      : isCreateIntent
        ? (createPath ?? "")
        : (visibleCommands[0]?.id ?? visibleFiles[0]?.path ?? visibleRecents[0]?.path ?? "");

  const listRef = useRef<HTMLDivElement>(null);
  const [selectedValue, setSelectedValue] = useState(firstValue);

  // Snap selection + scroll to the first item whenever the search/intent
  // changes, or when async file results arrive and the first item shifts.
  // firstValue is a primitive, so this is stable across renders.
  // selectedValue is also set by cmdk onValueChange (keyboard nav) and this effect also scrolls the list — not pure derived state.
  /* eslint-disable react-doctor/no-derived-state */
  useEffect(() => {
    setSelectedValue(firstValue);
    listRef.current?.scrollTo({ top: 0 });
  }, [search, intent, firstValue]);
  /* eslint-enable react-doctor/no-derived-state */

  const placeholder = isCreateIntent
    ? "Create a new note..."
    : isDrawingIntent
      ? "Drawing name (optional, press Enter to skip)..."
      : isSymbolIntent
        ? "Insert a math symbol — search by name or \\code..."
        : "Search...";

  return (
    <CommandDialog
      open={isOpen && intent !== "content-search"}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      label="Command Palette"
      shouldFilter={false}
      value={selectedValue}
      onValueChange={setSelectedValue}
    >
      <CommandInput placeholder={placeholder} value={search} onValueChange={setSearch} />
      <CommandList ref={listRef}>
        {isCreateIntent ? (
          <>
            {!trimmedSearch && <CommandEmpty>Type a note name to create it.</CommandEmpty>}
            {createPath && (
              <CommandGroup heading="Create note">
                <CommandItem value={createPath} onSelect={handleCreate}>
                  Create: {getFileName(createPath)}
                </CommandItem>
              </CommandGroup>
            )}
          </>
        ) : isDrawingIntent ? (
          <CommandGroup heading="Create drawing">
            <CommandItem value={drawingActionValue} onSelect={handleCreateDrawing}>
              <div className="flex flex-col">
                <span>
                  Create:{" "}
                  {trimmedSearch
                    ? `${sanitizeDrawingStem(trimmedSearch)}${DRAWING_EXTENSION}`
                    : `drawing${DRAWING_EXTENSION}`}
                </span>
                <span className="text-[13px] text-text-muted">
                  {trimmedSearch
                    ? `Heading: "### ${extractDrawingTitle(trimmedSearch)}"`
                    : "Leave blank for default name without heading (press Enter)"}
                </span>
              </div>
            </CommandItem>
          </CommandGroup>
        ) : isSymbolIntent ? (
          <>
            {visibleSymbols.length === 0 && <CommandEmpty>No matching symbol.</CommandEmpty>}
            <CommandGroup heading="Math symbols">
              {visibleSymbols.map((symbol) => (
                <CommandItem
                  key={symbol.code}
                  value={`sym-${symbol.code}`}
                  onSelect={() => handleInsertSymbol(symbol)}
                >
                  <div className="flex items-center gap-3">
                    <SymbolGlyph code={symbol.code} />
                    <span className="flex-1">{symbol.name}</span>
                    <span className="text-[13px] text-text-muted">{symbol.code}</span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : (
          <>
            {visibleFiles.length === 0 &&
              visibleRecents.length === 0 &&
              visibleCommands.length === 0 && (
                <CommandEmpty>
                  {isIndexing && trimmedSearch && !isCompactFileMode
                    ? "Indexing workspace..."
                    : "No results found."}
                </CommandEmpty>
              )}

            {(visibleFiles.length > 0 ||
              visibleRecents.length > 0 ||
              visibleCommands.length > 0) && (
              <CommandGroup
                heading={
                  trimmedSearch ? (isIndexing ? "Results (indexing...)" : "Results") : "Suggested"
                }
              >
                {visibleCommands.map((c) => (
                  <CommandItem key={c.id} value={c.id} onSelect={c.run}>
                    <div className="flex flex-col">
                      <span>{c.label}</span>
                      <span className="text-[13px] text-text-muted">{c.description}</span>
                    </div>
                  </CommandItem>
                ))}

                {visibleFiles.map((r) => (
                  <CommandItem key={r.path} value={r.path} onSelect={() => handleSelect(r.path)}>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{getFileName(r.path)}</span>
                      <span className="truncate text-[13px] text-text-muted">
                        <HighlightedPath path={r.relative_path} indices={r.match_indices} />
                      </span>
                    </div>
                  </CommandItem>
                ))}

                {visibleRecents.map((entry) => (
                  <CommandItem
                    key={entry.path}
                    value={entry.path}
                    onSelect={() => handleSelect(entry.path)}
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{entry.title || getFileStem(entry.name)}</span>
                      <span className="truncate text-[13px] text-text-muted">
                        {getParentDir(entry.path)}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
