import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { type Extension, Prec } from "@codemirror/state";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import * as editorApi from "@/hooks/editor-api";
import { isPdfPath } from "@/lib/pdf";
import { parseWikiLink } from "@/lib/wiki-links";
import { followWikiLink } from "./wiki-link-extension";

/**
 * Makes the **blockquote** of a PDF quote the thing you click to jump back to
 * the PDF, rather than the link line underneath it.
 *
 * The file on disk is unchanged — `contracts/quote-link.md` still owns the
 * shape, and the `[[…#page=…]]` line is still the link, still works, and is
 * still what another Markdown editor sees. This only changes where the
 * *editor* accepts the click, because the passage is the thing the reader is
 * looking at and the link below it is bookkeeping.
 *
 * The block stays editable: while the caret or selection is inside it, clicks
 * behave normally and no jump fires. That is the same rule the wiki-link widget
 * already uses to unfold itself for editing, so a quote is a button when you
 * are reading and text when you are writing.
 */

/** A line of the doc, as much of it as this module needs. */
interface DocLine {
  number: number;
  from: number;
  to: number;
  text: string;
}

interface DocLike {
  lines: number;
  line(n: number): DocLine;
  lineAt(pos: number): DocLine;
}

const BLOCKQUOTE_LINE = /^\s{0,3}>/;
const LONE_WIKI_LINK = /^\s*\[\[([^\]]+)\]\]\s*$/;

/**
 * The PDF quote link belonging to the blockquote at `pos`, plus the block's
 * extent, or null when this is not a quote block.
 *
 * Walks **forward** from the clicked line: the link sits after the blockquote,
 * separated by one blank line. Only a line that is *nothing but* a wiki link
 * counts — a sentence that happens to mention a PDF link is prose, not a
 * citation, and must not turn the paragraph above it into a button.
 */
export function pdfQuoteBlockAt(
  doc: DocLike,
  pos: number,
): { target: string; from: number; to: number } | null {
  const clicked = doc.lineAt(pos);
  if (!BLOCKQUOTE_LINE.test(clicked.text)) return null;

  // Back to the start of the contiguous blockquote, so clicking any line of a
  // multi-line quote behaves the same.
  let first = clicked.number;
  while (first > 1 && BLOCKQUOTE_LINE.test(doc.line(first - 1).text)) first -= 1;

  let after = clicked.number;
  while (after < doc.lines && BLOCKQUOTE_LINE.test(doc.line(after + 1).text)) after += 1;

  let linkLine = after + 1;
  if (linkLine <= doc.lines && doc.line(linkLine).text.trim() === "") linkLine += 1;
  if (linkLine > doc.lines) return null;

  const inner = LONE_WIKI_LINK.exec(doc.line(linkLine).text)?.[1];
  if (!inner || !isPdfPath(parseWikiLink(inner).path)) return null;

  return { target: inner, from: doc.line(first).from, to: doc.line(after).to };
}

/** Is the caret or a selection inside this block? Then it is being edited, and
 *  a click is a click, not a jump. */
function isBeingEdited(view: EditorView, block: { from: number; to: number }): boolean {
  return view.state.selection.ranges.some(
    (range) => range.from <= block.to && range.to >= block.from,
  );
}

const quoteBlockLine = Decoration.line({ class: "cm-pdf-quote-block" });

function buildDecorations(view: EditorView): DecorationSet {
  const decorations = [];
  for (const { from, to } of view.visibleRanges) {
    let line = view.state.doc.lineAt(from);
    while (line.from <= to) {
      if (BLOCKQUOTE_LINE.test(line.text)) {
        const block = pdfQuoteBlockAt(view.state.doc, line.from);
        if (block && !isBeingEdited(view, block)) decorations.push(quoteBlockLine.range(line.from));
      }
      if (line.number === view.state.doc.lines) break;
      line = view.state.doc.line(line.number + 1);
    }
  }
  return Decoration.set(decorations);
}

function quoteBlockDecorations() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

/** The quote block under a mouse event, if it is one and is not being edited. */
function jumpTargetAt(event: MouseEvent, view: EditorView): string | null {
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) return null;
  const block = pdfQuoteBlockAt(view.state.doc, pos);
  if (!block || isBeingEdited(view, block)) return null;
  return block.target;
}

function quoteBlockClickHandler(getFilePath: () => string, isDisposed: () => boolean): Extension {
  return Prec.highest(
    EditorView.domEventHandlers({
      // Claim the press so the caret does not move into the quote — which would
      // immediately make the block "being edited" and swallow the click that
      // follows. Navigation waits for the release, matching the wiki-link and
      // link-navigation handlers.
      mousedown(event, view) {
        if (jumpTargetAt(event, view) === null) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
      },
      click(event, view) {
        const target = jumpTargetAt(event, view);
        if (target === null) return false;
        event.preventDefault();
        event.stopPropagation();

        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) return true;

        // The same follow path the link line itself uses: one resolution, one
        // reveal, one place where a broken link is reported.
        void followWikiLink(target, {
          workspaceRoot,
          filePath: getFilePath(),
          tabId: editorApi.getTabIdForView(view),
          isDisposed,
        }).catch((error) => {
          if (!isDisposed()) console.error("[editor] Failed to follow quote block:", error);
        });

        return true;
      },
    }),
  );
}

const quoteBlockTheme = EditorView.baseTheme({
  ".cm-pdf-quote-block": {
    cursor: "pointer",
  },
  // Hover marks the whole block, so it is visible that the passage — not just
  // the word under the pointer — is the thing that will be followed.
  ".cm-pdf-quote-block:hover": {
    backgroundColor: "var(--surface-subtle)",
  },
});

export function pdfQuoteBlockExtension(
  getFilePath: () => string,
  isDisposed: () => boolean,
): Extension[] {
  return [
    quoteBlockDecorations(),
    quoteBlockClickHandler(getFilePath, isDisposed),
    quoteBlockTheme,
  ];
}
