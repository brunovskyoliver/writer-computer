import { describe, expect, it } from "vite-plus/test";
import { CompletionContext } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { plotCompletions } from "../src/components/editor-area/plot-completion";
import { withFullParse } from "./helpers/parsed-state";

function labelsAt(doc: string) {
  const pos = doc.indexOf("|");
  const state = withFullParse(
    EditorState.create({ doc: doc.replace("|", ""), extensions: [markdown()] }),
  );
  return plotCompletions(new CompletionContext(state, pos, false))?.options.map((o) => o.label);
}

describe("plotCompletions", () => {
  it("offers line forms and functions at the start of a plot line", () => {
    const labels = labelsAt("```plot\nsi|\n```");
    expect(labels).toContain("domain");
    expect(labels).toContain("T(x,y) =");
    expect(labels).toContain("sinh");
  });

  it("offers only functions and constants mid-expression", () => {
    const labels = labelsAt("```plot\n2*co|\n```");
    expect(labels).toContain("cos");
    expect(labels).toContain("pi");
    expect(labels).not.toContain("domain");
  });

  it("stays out of other fences, the info line and prose", () => {
    expect(labelsAt("```js\nsi|\n```")).toBeUndefined();
    expect(labelsAt("```plo|t\nx\n```")).toBeUndefined();
    expect(labelsAt("si|\n```plot\nx\n```")).toBeUndefined();
  });
});
