/**
 * `\` completions for LaTeX: commands (with a rendered preview), environment
 * names after `\begin{`, labels after `\ref{`, bibliography keys after
 * `\cite{`. In a note they are offered inside math only; in a `.tex` file
 * everywhere but comments. Accepting inserts the entry's template through the
 * snippet engine's tabstops, so Tab walks its arguments like any snippet.
 *
 * Rules: SPECs/latex-completions/spec.md.
 */

import {
  autocompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, tooltips } from "@codemirror/view";
import {
  bibEntriesIn,
  labelsIn,
  LATEX_COMMANDS,
  macrosIn,
  LATEX_ENVIRONMENTS,
  renderTemplate,
  type LatexCommand,
} from "@/lib/latex-completions/catalog";
import { frameOf } from "@/lib/latex-snippets/expand";
import { mathContext, mathSource } from "@/lib/latex-snippets/math-context";
import { getParentDir } from "@/lib/paths";
import * as tauri from "@/lib/tauri";
import { setFrames, tabstopField } from "./latex-snippets-extension";
import { renderMath } from "./math-renderer";

const PARSE_BUDGET_MS = 20;

type Where = "math" | "text" | null;

/** Which entries fit at `pos`: math, LaTeX prose, or none at all. */
function whereAt(context: CompletionContext): Where {
  const { state, pos } = context;
  ensureSyntaxTree(state, state.doc.lineAt(pos).to, PARSE_BUDGET_MS);
  const math = mathContext(state, pos);
  if (math.kind === "inline" || math.kind === "display") return "math";
  // Prose is LaTeX only in a `.tex` source; in a note it is Markdown.
  if (state.facet(mathSource) === "latex" && (math.kind === "prose" || math.kind === "text")) {
    return "text";
  }
  return null;
}

/** Insert `template` over `[from, to)` and hand its stops to the snippet
 *  engine's frame stack — one tabstop system for snippets and completions. */
function insertTemplate(view: EditorView, template: string, from: number, to: number) {
  const { text, stops } = renderTemplate(template);
  const frame = frameOf(stops.map((s) => ({ ...s, from: from + s.from, to: from + s.to })));
  const first = frame
    ? stops.filter((s) => s.group === frame.currentGroup)[0]!
    : { from: text.length, to: text.length };
  view.dispatch({
    changes: { from, to, insert: text },
    selection: EditorSelection.range(from + first.from, from + first.to),
    effects: frame ? [setFrames.of([...view.state.field(tabstopField).frames, frame])] : [],
    userEvent: "input.complete",
    scrollIntoView: true,
  });
}

type LatexOption = Completion & { glyph?: string };

function commandOption(entry: LatexCommand): LatexOption {
  return {
    label: entry.label,
    detail: entry.detail,
    type: entry.glyph ? "constant" : "keyword",
    glyph: entry.glyph,
    apply: (view, _completion, from, to) => {
      insertTemplate(view, entry.template, from, to);
      if (entry.retrigger) startCompletion(view);
    },
  };
}

function commandCompletions(context: CompletionContext, where: Exclude<Where, null>) {
  const word = context.matchBefore(/\\[A-Za-z]*$/);
  if (!word) return null;
  // `\\` is a row break, not the start of a command.
  if (context.state.sliceDoc(word.from - 1, word.from) === "\\") return null;
  if (
    word.text === "\\" &&
    !context.explicit &&
    context.state.sliceDoc(word.to, word.to + 1) === "\\"
  ) {
    return null;
  }
  const builtIn = LATEX_COMMANDS.filter((entry) => entry.mode === "both" || entry.mode === where);
  const known = new Set(builtIn.map((entry) => entry.label));
  // The document's own macros, usable in math and prose alike.
  const own = macrosIn(context.state.doc.toString())
    .filter((macro) => !known.has(macro.label))
    .map(
      (macro): LatexOption => ({
        label: macro.label,
        detail: "defined here",
        type: "function",
        apply: (view, _completion, from, to) => insertTemplate(view, macro.template, from, to),
      }),
    );
  return {
    from: word.from,
    options: [...own, ...builtIn.map(commandOption)],
    validFor: /^\\[A-Za-z]*$/,
  } satisfies CompletionResult;
}

function environmentCompletions(context: CompletionContext, where: Exclude<Where, null>) {
  const match = context.matchBefore(/\\begin\{[A-Za-z*]*$/);
  if (!match) return null;
  const from = match.from + "\\begin{".length;
  // In `.tex` prose the display-math environments are text-level blocks too.
  const envs = LATEX_ENVIRONMENTS.filter((e) => e.mode === where);
  return {
    from,
    options: envs.map(
      (entry): Completion => ({
        label: entry.name,
        detail: entry.detail,
        type: "type",
        apply: (view, _completion, applyFrom, to) => {
          // Swallow a `}` the bracket closer already put after the caret.
          const end = view.state.sliceDoc(to, to + 1) === "}" ? to + 1 : to;
          insertTemplate(view, entry.name + entry.body, applyFrom, end);
        },
      }),
    ),
    validFor: /^[A-Za-z*]*$/,
  } satisfies CompletionResult;
}

/** Accept a label or key: close the argument when nothing closes it yet
 *  (a `.tex` editor does not auto-pair braces) and land after it. */
function applyArgument(value: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const closed = view.state.sliceDoc(to, to + 1) === "}";
    const insert = closed ? value : `${value}}`;
    view.dispatch({
      changes: { from, to, insert },
      selection: EditorSelection.cursor(from + value.length + 1),
      userEvent: "input.complete",
    });
  };
}

async function siblingFiles(path: string | null, extension: string): Promise<string[]> {
  if (!path) return [];
  try {
    const entries = await tauri.readDirectory(getParentDir(path));
    const files = entries.filter(
      (entry) => !entry.is_dir && entry.name.toLowerCase().endsWith(extension),
    );
    const texts = await Promise.all(
      files.map((entry) => tauri.readFile(entry.path).then((file) => file.content)),
    );
    return texts;
  } catch (error) {
    console.error("[latex-completion] reading sibling files failed", error);
    return [];
  }
}

async function referenceCompletions(
  context: CompletionContext,
  path: string | null,
): Promise<CompletionResult | null> {
  const match = context.matchBefore(/\\(?:eq|auto|c|C|page)?ref\{[^}]*$/);
  if (!match) return null;
  const from = match.from + match.text.indexOf("{") + 1;
  const labels = new Set(labelsIn(context.state.doc.toString()));
  if (context.state.facet(mathSource) === "latex") {
    for (const text of await siblingFiles(path, ".tex")) {
      for (const label of labelsIn(text)) labels.add(label);
    }
  }
  if (labels.size === 0) return null;
  return {
    from,
    options: [...labels].map((label) => ({ label, type: "variable", apply: applyArgument(label) })),
    validFor: /^[^}]*$/,
  };
}

async function citationCompletions(
  context: CompletionContext,
  path: string | null,
): Promise<CompletionResult | null> {
  const match = context.matchBefore(/\\cite[pt]?\*?(?:\[[^\]]*\])*\{[^}]*$/);
  if (!match) return null;
  // Several keys: complete the one after the last comma.
  const open = match.text.indexOf("{");
  const lastComma = match.text.lastIndexOf(",");
  const from = match.from + Math.max(open, lastComma) + 1;
  const entries = (await siblingFiles(path, ".bib")).flatMap(bibEntriesIn);
  if (entries.length === 0) return null;
  return {
    from,
    options: entries.map((entry) => ({
      label: entry.key,
      detail: entry.title ?? undefined,
      type: "text",
      apply: applyArgument(entry.key),
    })),
    validFor: /^[^},]*$/,
  };
}

/** The LaTeX completion source for a view of `path` (null for the unsaved). */
export function latexCompletions(getFilePath: () => string | null): CompletionSource {
  return async (context) => {
    const where = whereAt(context);
    if (!where) return null;
    return (
      environmentCompletions(context, where) ??
      (await referenceCompletions(context, getFilePath())) ??
      (await citationCompletions(context, getFilePath())) ??
      commandCompletions(context, where)
    );
  };
}

// ---------- Shared autocompletion config ----------

/** A rendered preview of the command (`renderMath` caches it). */
function glyphFor(code: string): string | null {
  const result = renderMath(code, false);
  return "html" in result && result.html !== undefined ? result.html : null;
}

/**
 * The one `autocompletion()` a view gets. CodeMirror refuses two configs
 * with different `override`s, so every flavor passes its sources here
 * instead of each feature adding its own.
 */
export function editorCompletion(sources: CompletionSource[]): Extension {
  return [
    // Appended to `document.body` so the card's backdrop blur works outside
    // `EditorScrollContainer`'s mask (see App.css).
    tooltips({ parent: document.body }),
    autocompletion({
      override: sources,
      icons: false,
      // Accept on the first Tab/Enter, as VS Code does. The default 75 ms
      // guard swallowed a fast `\fr` + Tab and indented the line instead.
      interactionDelay: 0,
      addToOptions: [
        {
          position: 20,
          render: (completion) => {
            const code = (completion as LatexOption).glyph;
            const html = code ? glyphFor(code) : null;
            if (!html) return null;
            const span = document.createElement("span");
            span.className = "cm-latex-completion-glyph";
            // KaTeX output from renderMath (trust:false) for a table entry.
            span.innerHTML = html;
            return span;
          },
        },
      ],
    }),
    EditorView.baseTheme({
      ".cm-latex-completion-glyph": {
        display: "inline-block",
        minWidth: "2.2em",
        marginRight: "8px",
        textAlign: "center",
      },
    }),
  ];
}
