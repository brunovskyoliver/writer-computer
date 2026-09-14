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

export function editorFlavorForPath(path: string): EditorFlavor {
  const language = LanguageDescription.matchFilename(languages, path);
  // No match, or Markdown itself (`.md`, `.markdown`) — and anything unknown,
  // including `.txt` and extension-less files — stays a note.
  if (!language || language.name === "Markdown") return "markdown";
  return { kind: "code", language };
}

/** Stable identity for a flavor, so a view is rebuilt only when the *kind* of
 *  editor changes — not on every ordinary tab switch between notes. */
export function editorFlavorKey(path: string): string {
  const flavor = editorFlavorForPath(path);
  return flavor === "markdown" ? "markdown" : `code:${flavor.language.name}`;
}
