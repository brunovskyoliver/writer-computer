import { EditorView, keymap } from "@codemirror/view";
import { type Extension, Prec } from "@codemirror/state";
import { search } from "@codemirror/search";
import {
  closeEditorSearch,
  findNextMatch,
  findPreviousMatch,
  openEditorSearch,
  useEditorSearchStore,
} from "./editor-search-store";
import { editorScrollHandler } from "./editor-scroll";

// Invisible CodeMirror search panel: returning a hidden DOM here flips
// `searchState.panel` to truthy, which is what gates the built-in match
// highlighter. The actual UI is our React `EditorSearchOverlay`.
function invisibleSearchPanel() {
  const dom = document.createElement("div");
  dom.style.display = "none";
  return { dom };
}

const openOrFind = (find: (view: EditorView) => boolean) => (view: EditorView) => {
  if (!useEditorSearchStore.getState().isOpen) {
    openEditorSearch(view);
    return true;
  }
  return find(view);
};

/** Find/replace wiring: CodeMirror's search state (with a hidden panel so its
 *  match highlighter runs), the shared safe-zone cursor scrolling, and
 *  the Mod-f / Mod-g / Escape bindings that drive the React overlay.
 *
 *  Place after `prosemarkBasicSetup()` in the extension list: the Escape
 *  binding is at default precedence so an open completion popup gets Escape
 *  first. */
export const editorSearchExtensions: Extension = [
  search({ literal: true, createPanel: invisibleSearchPanel }),
  editorScrollHandler,
  Prec.highest(
    keymap.of([
      {
        key: "Mod-f",
        run: (view) => {
          openEditorSearch(view);
          return true;
        },
      },
      {
        key: "Mod-g",
        preventDefault: true,
        run: openOrFind(findNextMatch),
        shift: openOrFind(findPreviousMatch),
      },
    ]),
  ),
  keymap.of([
    {
      key: "Escape",
      run: (view) => {
        if (!useEditorSearchStore.getState().isOpen) return false;
        closeEditorSearch({ view, restoreFocus: true });
        return true;
      },
    },
  ]),
];
