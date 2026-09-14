import { describe, expect, test } from "vite-plus/test";
import { editorFlavorForPath, editorFlavorKey } from "../src/lib/editor-flavor";

describe("editorFlavorForPath", () => {
  test("treats notes, plain text and extension-less files as markdown", () => {
    for (const path of ["/notes/a.md", "/notes/a.markdown", "/notes/a.txt", "/notes/README"]) {
      expect(editorFlavorForPath(path)).toBe("markdown");
    }
  });

  test("opens the snippet file as JavaScript", () => {
    const flavor = editorFlavorForPath("/config/latex-snippets.js");
    expect(flavor).not.toBe("markdown");
    if (flavor === "markdown") return;
    expect(flavor.language.name).toBe("JavaScript");
  });

  test("opens json as code", () => {
    const flavor = editorFlavorForPath("/notes/notes.json");
    expect(flavor).not.toBe("markdown");
  });
});

describe("editorFlavorKey", () => {
  test("is identical for every markdown note, so tab switches reuse the view", () => {
    expect(editorFlavorKey("/a.md")).toBe(editorFlavorKey("/b/c.markdown"));
  });

  test("differs between markdown and code", () => {
    expect(editorFlavorKey("/a.md")).not.toBe(editorFlavorKey("/latex-snippets.js"));
  });
});
