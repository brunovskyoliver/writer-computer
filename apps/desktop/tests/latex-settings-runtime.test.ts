import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { prosemarkMarkdownSyntaxExtensions } from "../src/lib/prosemark-core/main";
import { latexSnippetsExtension } from "../src/components/editor-area/latex-snippets-extension";
import { generalSyntaxHighlights } from "../src/lib/prosemark-core/syntaxHighlighting";
import {
  latexHighlighting,
  latexMathNesting,
} from "../src/components/editor-area/latex-highlighting";
import { useSettingsStore } from "../src/stores/settings-store";

vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn(), applyCssVarBindings: vi.fn() }));

beforeEach(() => {
  useSettingsStore.setState({
    settings: { "latex.snippets-enabled": false, "latex.auto-fraction": false },
  });
});

/** Exercise the real input facet with state/dispatch only; no DOM or view plugins. */
function editor(doc: string, caret: number) {
  const view = {
    composing: false,
    state: EditorState.create({
      doc,
      selection: { anchor: caret },
      extensions: [
        markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions, latexMathNesting] }),
        latexSnippetsExtension(() => "test"),
      ],
    }),
    dispatch(...specs: TransactionSpec[]) {
      this.state = this.state.update(...specs).state;
    },
  };
  return {
    view,
    type(text: string) {
      const { from, to } = view.state.selection.main;
      const insert = () =>
        view.state.update(view.state.replaceSelection(text), { userEvent: "input.type" });
      if (
        !view.state
          .facet(EditorView.inputHandler)
          .some((handler) => handler(view as EditorView, from, to, text, insert))
      ) {
        view.state = insert().state;
      }
    },
  };
}

describe("live auto-fraction setting", () => {
  test.each([
    ["$x$", 2, "$\\frac{x}{}$"],
    ["Prose $x^2$", 10, "Prose $\\frac{x^2}{}$"],
    ["$$x$$", 3, "$$\\frac{x}{}$$"],
    ["$$\nx\n$$", 4, "$$\n\\frac{x}{}\n$$"],
  ])("respects the toggle and math boundaries in %s", (doc, caret, expected) => {
    const off = editor(doc, caret);
    off.type("/");
    expect(off.view.state.doc.toString()).toBe(doc.slice(0, caret) + "/" + doc.slice(caret));
    const on = editor(doc, caret);
    // Change after constructing the editor: no remount/reconfiguration needed.
    useSettingsStore.setState({
      settings: { "latex.snippets-enabled": false, "latex.auto-fraction": true },
    });
    on.type("/");
    expect(on.view.state.doc.toString()).toBe(expected);
    expect(on.view.state.selection.main.head).toBe(expected.indexOf("{}") + 1);
  });
});

test("the disabled LaTeX palette overrides general code colours", () => {
  useSettingsStore.setState({ settings: { "latex.highlight-source": false } });
  const state = EditorState.create({ extensions: [generalSyntaxHighlights, latexHighlighting()] });
  // CodeMirror mounts modules in reverse facet order. The scoped plain rule
  // must come after the generic token palette in CSS to win equal specificity.
  const rules = state.facet(EditorView.styleModule).map((module) => module.getRules());
  const plain = rules.findIndex((rule) => rule.includes("color: inherit"));
  const generic = rules.findIndex((rule) => rule.includes("--pm-syntax-keyword"));
  expect(plain).toBeGreaterThanOrEqual(0);
  expect(generic).toBeGreaterThan(plain);
});
