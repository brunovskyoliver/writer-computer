/**
 * Which editor a file gets. Notes are Markdown; anything CodeMirror's language
 * data recognises by file name (the LaTeX snippet file, a stray `.json`) opens
 * as a plain code editor instead, with none of the prosemark decorations.
 *
 * Research R7, SPECs/latex-suite.
 */

import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

export type EditorFlavor = "markdown" | { kind: "code"; language: LanguageDescription };

/** `.bib` has no entry in the language data; BibTeX reads fine with the LaTeX
 *  mode (`@`, braces, `%` comments), which is all the colouring it needs. */
const bibtex = LanguageDescription.of({
  name: "BibTeX",
  extensions: ["bib"],
  load: () => LanguageDescription.matchFilename(languages, "x.tex")!.load(),
});

export function editorFlavorForPath(path: string): EditorFlavor {
  const language =
    LanguageDescription.matchFilename(languages, path) ??
    LanguageDescription.matchFilename([bibtex], path);
  // No match, or Markdown itself (`.md`, `.markdown`) — and anything unknown,
  // including `.txt` and extension-less files — stays a note.
  if (!language || language.name === "Markdown") return "markdown";
  return { kind: "code", language };
}

/** A LaTeX source tab: the code flavor plus the math tools, compile and
 *  preview (SPECs/latex-documents). */
export function isLatexFlavor(flavor: EditorFlavor): boolean {
  return (
    flavor !== "markdown" && (flavor.language.name === "LaTeX" || flavor.language.name === "BibTeX")
  );
}

/** Stable identity for a flavor, so a view is rebuilt only when the *kind* of
 *  editor changes — not on every ordinary tab switch between notes. */
export function editorFlavorKey(path: string): string {
  const flavor = editorFlavorForPath(path);
  return flavor === "markdown" ? "markdown" : `code:${flavor.language.name}`;
}
