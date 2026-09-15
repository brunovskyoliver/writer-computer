import type { EditorView } from "@codemirror/view";
import { insertAtCursor } from "@/hooks/editor-api";
import { panes } from "@/lib/editor-layout";
import { getEditorView } from "@/lib/editor-views";
import { getRelativePath, normalizePath } from "@/lib/paths";
import { quoteMarkdown, type PdfAnchor } from "@/lib/pdf-anchor";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { showEditorNotice } from "./editor-notice-store";
import { pageKind } from "./page-kinds";

/**
 * The quote action that appears beside a live PDF selection (FR-015–FR-018).
 *
 * See SPECs/pdf-quote-links/ — the inserted Markdown's shape is
 * `contracts/quote-link.md` and is built in `lib/pdf-anchor.ts`; this file owns
 * only *where* the text goes.
 */

/** A capture ready to be quoted: what was selected, and where it sits in the
 *  viewer's scrolled content so the button can be placed beside it. */
export interface PdfQuoteCapture {
  anchor: PdfAnchor;
  /** The full passage for the blockquote. The anchor carries a truncated
   *  re-find hint; these are deliberately not the same string (FR-019). */
  body: string;
  /** Selection bounds in the scroll container's *content* coordinates. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** How bright the page is where the button will sit, sampled from the
   *  rendered canvas. A PDF page is not always white — figures, dark plates
   *  and slide decks are common — so the button's colours are derived from the
   *  paper rather than assumed. */
  onDarkPage: boolean;
}

/** Space between the selection and the button. */
export const QUOTE_BUTTON_OFFSET = 8;
/** Enough room above the selection to sit there rather than below it. Exported
 *  because `pdf-pane.tsx` samples the page's brightness over exactly the area
 *  the button will occupy; if the two numbers drift, it samples the wrong
 *  pixels and the button can invert against the paper it is not on. */
export const QUOTE_BUTTON_HEIGHT = 28;

/**
 * The note the quote lands in: the **active tab of a visible pane**, not any
 * open note tab — a note sitting behind a PDF in the same pane is not visible
 * and quoting into it would be invisible (FR-018).
 *
 * The focused pane wins when it holds a note, so quoting goes where the user
 * was last working; otherwise the first note pane in layout order does. Panes
 * holding a standalone surface (a PDF, a drawing) are skipped via the same
 * `primaryPath === null` predicate the editor store dispatches on, so a future
 * kind needs no change here.
 *
 * Resolved at press time, never at capture time: the note pane can be closed
 * between the selection and the press (scenario 2.5).
 */
function visibleNote(): { tabId: string; path: string; view: EditorView } | null {
  const { layout, tabs } = useEditorStore.getState();
  const candidates = panes(layout);
  const focusedFirst = [
    ...candidates.filter((pane) => pane.id === layout.focusedPaneId),
    ...candidates.filter((pane) => pane.id !== layout.focusedPaneId),
  ];

  for (const pane of focusedFirst) {
    const tab = tabs.find((candidate) => candidate.id === pane.activeTabId);
    if (!tab) continue;
    const path = pageKind(tab.location).primaryPath(tab.location);
    if (path === null) continue;
    const view = getEditorView(tab.id);
    // A note whose view has not mounted yet cannot be dispatched into. Keep
    // looking rather than failing: another pane may well have one.
    if (view) return { tabId: tab.id, path, view };
  }
  return null;
}

/**
 * Surround the insertion with blank lines so it reads as its own block
 * wherever the caret happened to be. Without this, quoting mid-paragraph
 * produces `some text> The quote` — valid characters, meaningless Markdown.
 */
function blockPadding(view: EditorView, pos: number): { prefix: string; suffix: string } {
  const doc = view.state.doc;
  const before = doc.sliceString(Math.max(0, pos - 2), pos);
  const after = doc.sliceString(pos, Math.min(doc.length, pos + 1));
  return {
    prefix: pos === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n",
    suffix: after === "" ? "\n" : after === "\n" ? "\n" : "\n\n",
  };
}

/**
 * Insert the quote at the target note's caret.
 *
 * Goes through `editorApi.insertAtCursor` rather than dispatching here: that is
 * the app's one API-level insert path, and it is a *single* `view.dispatch`,
 * which is what makes one undo revert the whole insertion (FR-017, scenario
 * 2.4). Because it carries no `syncTransaction` annotation and no `writer` user
 * event, `publishEditorUpdate` treats it exactly like typing — the document
 * reaches the store, the save is scheduled, and every other pane showing the
 * note gets the change. A quote that appeared only in the visible buffer and
 * never reached disk is the failure that would look like success.
 *
 * Padding is applied before the call because `insertAtCursor`'s own clean-line
 * rule only fires for headings; a `>` landing mid-line is the same bug for a
 * blockquote.
 */
function insertQuote(capture: PdfQuoteCapture, pdfPath: string, pdfTabId: string): boolean {
  const root = useWorkspaceStore.getState().root;
  if (!root) {
    // A link with an absolute path in it is a permanent on-disk contract
    // violation, not a recoverable slip — refuse rather than write one.
    showEditorNotice("No workspace is open, so the quote has nowhere to point.", pdfTabId);
    return false;
  }

  const target = visibleNote();
  if (!target) {
    showEditorNotice("No note is visible to quote into.", pdfTabId);
    return false;
  }

  // `getRelativePath` hands back the absolute path unchanged when the file is
  // not under the root — a PDF opened from elsewhere on disk. Writing that into
  // a link would produce a note that only resolves on this machine, so refuse
  // rather than emit one.
  const relative = normalizePath(getRelativePath(pdfPath, root));
  if (relative.startsWith("/") || /^[a-z]:\//i.test(relative)) {
    showEditorNotice("This PDF is outside the workspace, so it cannot be linked.", pdfTabId);
    return false;
  }

  const text = quoteMarkdown(relative, capture.anchor, capture.body);
  const { prefix, suffix } = blockPadding(target.view, target.view.state.selection.main.head);
  if (!insertAtCursor(target.path, `${prefix}${text}${suffix}`, target.tabId)) {
    // Unreachable while `visibleNote` only returns panes with a live view, but
    // FR-018 is explicit that this action never fails silently.
    showEditorNotice("The quote could not be inserted into the note.", pdfTabId);
    return false;
  }
  // Focus follows the text. The insertion is one transaction either way, but
  // undo is a keystroke, and a keystroke goes wherever focus is: leaving focus
  // in the PDF means Cmd+Z never reaches the note's history and the
  // single-step undo the user was promised appears not to work.
  target.view.focus();
  return true;
}

export function PdfQuoteButton({
  capture,
  pdfPath,
  pdfTabId,
  onQuoted,
}: {
  capture: PdfQuoteCapture;
  pdfPath: string;
  pdfTabId: string;
  onQuoted: () => void;
}) {
  // Positioned in the scroll container's content coordinates, so it tracks the
  // selection through a scroll with no scroll handler at all. It is absolutely
  // placed and so shifts nothing else in the layout (scenario 2.1).
  const above = capture.top >= QUOTE_BUTTON_HEIGHT + QUOTE_BUTTON_OFFSET;
  const top = above
    ? capture.top - QUOTE_BUTTON_HEIGHT - QUOTE_BUTTON_OFFSET
    : capture.top + capture.height + QUOTE_BUTTON_OFFSET;

  // Taken from the paper, not from the app theme. The previous version used
  // `--surface-card`, which is near-white in light mode and so vanished against
  // a white page — the button was there, just invisible. Inverting against the
  // sampled page keeps it legible on white paper, on a dark figure, and on a
  // slide deck, and it stays correct when the app theme changes because it
  // never depended on the theme.
  const ink = capture.onDarkPage ? "#ffffff" : "#1a1a1a";
  const paper = capture.onDarkPage ? "rgba(20, 20, 20, 0.92)" : "rgba(255, 255, 255, 0.94)";

  return (
    <button
      type="button"
      // The selection is cleared by any mousedown outside it, including on
      // this button — which would unmount it before the click ever lands.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (insertQuote(capture, pdfPath, pdfTabId)) onQuoted();
      }}
      className="absolute z-20 flex h-[24px] cursor-pointer items-center rounded-md px-2 text-[12px] font-medium"
      style={{
        left: capture.left,
        top,
        background: paper,
        border: `1px solid ${ink}`,
        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.28)",
        color: ink,
      }}
    >
      Quote
    </button>
  );
}
