# Data Model: LaTeX Suite

Types live in `apps/desktop/src/lib/latex-snippets/`. Names below are the intended exported names.

## SnippetEntry (parsed, not yet validated)

Output of `parse-snippet-file.ts`, one per array element that is an object literal.

| Field         | Type                                                              | Source                                             |
| ------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `index`       | number                                                            | position in the array (0-based)                    |
| `line`        | number                                                            | `loc.start.line` of the object literal (1-based)   |
| `trigger`     | `{ kind: "string", value }` \| `{ kind: "regex", source, flags }` | string literal / template literal / regex literal  |
| `replacement` | string                                                            | string or expression-free template literal         |
| `options`     | string                                                            | raw option letters                                 |
| `priority`    | number \| undefined                                               | numeric literal (negative allowed via unary minus) |
| `description` | string \| undefined                                               |                                                    |

Elements that are not object literals, or objects whose `trigger`/`replacement`/`options` are missing or of an unsupported node kind, do not produce a `SnippetEntry`; they produce an `EntryError` (below) instead.

## CompiledSnippet

Output of `compile.ts` for each valid entry.

| Field          | Type                                        | Notes                                                                                       |
| -------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `id`           | number                                      | entry index                                                                                 |
| `pattern`      | RegExp                                      | anchored `(?:…)$`, flag `u`; string triggers escaped; `w` adds the non-word lookbehind      |
| `triggerText`  | string \| null                              | the literal trigger for non-regex snippets (used by visual matching and error messages)     |
| `template`     | `ReplacementSegment[]`                      | see below; variables already substituted                                                    |
| `mode`         | `"text" \| "math" \| "inline" \| "display"` | from `t` / `m` / `n` / `M`; exactly one is required                                         |
| `automatic`    | boolean                                     | `A`                                                                                         |
| `visual`       | boolean                                     | template contains a `visual` segment                                                        |
| `priority`     | number                                      | default 0                                                                                   |
| `captureCount` | number                                      | groups in `pattern` (computed by matching the pattern's source against `new RegExp(...\|)`) |
| `description`  | string \| undefined                         |                                                                                             |
| `disabled`     | `EntryError \| null`                        | set at runtime by the matcher on timeout/throw; a disabled snippet is skipped               |

**Validation rules** (each failure → `EntryError` with the entry index; the entry is skipped, others load — FR-018):

- `options` may contain only letters from `OPTION_LETTERS = "tmnMArw"`; exactly one of `t m n M`; `r` is implied for regex-literal triggers and allowed redundantly.
- `pattern` must compile (`new RegExp(src, "u")`); a thrown `SyntaxError` → `invalid-pattern` with the engine's message.
- Every `[[n]]` in the replacement must satisfy `n < captureCount` → else `missing-capture`.
- Every `${NAME}` must resolve in the variable map → else `unknown-variable` (`${VISUAL}` and `${digit:…}` are not variables).
- `priority`, when present, must be a finite number → else `invalid-priority`.
- Replacement not a string → `function-replacement` (for function/arrow nodes) or `unsupported-value`.

## ReplacementSegment

Union produced by `replacement.ts` from the replacement string:

| Variant   | Shape                                              | Syntax                                                      |
| --------- | -------------------------------------------------- | ----------------------------------------------------------- |
| `literal` | `{ kind: "literal", text }`                        | anything else, incl. a lone `$` not followed by a digit/`{` |
| `tabstop` | `{ kind: "tabstop", index, placeholder?: string }` | `$N` or `${N:placeholder}` with `N` a single digit 0–9      |
| `capture` | `{ kind: "capture", group }`                       | `[[n]]`                                                     |
| `visual`  | `{ kind: "visual" }`                               | `${VISUAL}`                                                 |

Ordering rule for stops: ascending `index`; `$0` first (Obsidian semantics). Repeated indexes form one group with several ranges.

## SnippetVariable

`Map<string, string>` built from the `latex.snippet-variables` setting: each list item `NAME=value` (first `=` splits). Items without `=` or with an empty name → `invalid-variable` (reported in the store's error list, not fatal). Substitution is textual, into both trigger source and replacement, before compilation.

## CompiledSnippetSet

| Field    | Type                                                                                                                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `byMode` | `Record<"text" \| "inline" \| "display", { auto: CompiledSnippet[]; tab: CompiledSnippet[] }>` — `math` snippets appear in both `inline` and `display`; each list pre-sorted by priority desc, then index |
| `visual` | `Map<string, CompiledSnippet[]>` keyed by `triggerText`, per mode                                                                                                                                         |
| `count`  | number of loaded snippets                                                                                                                                                                                 |

## SnippetLoadStatus (store)

```
{ kind: "empty" }                                   // before first load (engine inert)
{ kind: "loaded", set, warnings: EntryError[] }     // valid, possibly with skipped entries
{ kind: "failed", error: LoadError, set }           // parse/read failed; `set` is the last valid set
```

`LoadError = { message: string; line?: number; column?: number }`. Transitions: `empty → loaded | failed(set = empty set)`; `loaded → loaded | failed(set = previous)`; `failed → loaded | failed(set = previous valid)`. A successful load clears `error` (FR-017).

`EntryError = { code: EntryErrorCode; index: number; line?: number; trigger?: string; message: string }` with `EntryErrorCode` from one table in `options.ts`: `not-an-object`, `missing-field`, `invalid-options`, `invalid-pattern`, `missing-capture`, `unknown-variable`, `invalid-priority`, `function-replacement`, `unsupported-value`, `pattern-timeout`, `pattern-threw`, `invalid-variable`.

## LatexSnippetStore (Zustand, `stores/latex-snippet-store.ts`)

| Field / action   | Purpose                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `filePath`       | absolute path returned by `latex_snippets_path` (null until resolved)                                                                                                          |
| `status`         | `SnippetLoadStatus`                                                                                                                                                            |
| `load()`         | single entry point: ensure path → read → parse → compile with current variables → set status. Race-safe by a load sequence number (a stale read never overwrites a newer one). |
| `reset()`        | `reset_latex_snippets` then `load()`                                                                                                                                           |
| `openInEditor()` | `editorApi.openFileInNewTab(filePath)`                                                                                                                                         |
| `getActiveSet()` | `status.set` regardless of kind — what the editor reads per keystroke                                                                                                          |
| subscriptions    | `fs:file-changed` (path match) → `load()`; settings `latex.snippet-variables` change → recompile                                                                               |

The store is the only module that reads the file or calls the two Rust commands (Principle IV).

## MathContext

`{ kind: "prose" } | { kind: "code" } | { kind: "inline", node } | { kind: "display", node } | { kind: "text", node }` where `node` is the enclosing `Math` syntax node range (`from`, `to`, `formulaFrom`, `formulaTo`). Snippet modes map: `text` → prose; `inline` → inline; `display` → display; `math` → inline or display. `text` (inside `\text{}`) and `code` match nothing.

## SnippetMatch → Expansion

`SnippetMatch = { snippet, from, to, groups: string[], visualText?: string }`.

`expand(match, state) → { changes: ChangeSpec, selection: EditorSelection, frame: TabstopFrame | null }` where `TabstopFrame = { marks: DecorationSet (each mark carries `group: number`), currentGroup: number }`. If the template has no tabstops, `frame` is null and the caret lands after the inserted text.

## TabstopState (StateField)

`{ frames: TabstopFrame[]; lastExpansionAt: number | null }` — `frames` is a stack (top = innermost); `lastExpansionAt` is the doc-change counter value of the most recent `input.snippet` transaction, used by the Backspace-undo binding. Mapping: every frame's `marks` are `map`ped through `tr.changes`; a frame whose marks all vanish is dropped. Effects: `pushFrame`, `advance(±1)`, `clearFrames`.

## Settings (schema entries)

See [contracts/settings.md](./contracts/settings.md) — `latex.snippets-enabled`, `latex.tab-out`, `latex.auto-fraction`, `latex.highlight-source` (booleans, default true), `latex.snippet-variables` (list).

## Files on disk

| Path                                            | Owner | Notes                                                        |
| ----------------------------------------------- | ----- | ------------------------------------------------------------ |
| `<app_data_dir>/latex-snippets.js`              | user  | created from defaults when missing; never rewritten silently |
| `<app_data_dir>/config`                         | app   | existing global settings file; now watched for other windows |
| `apps/desktop/shared/latex-snippets.default.js` | repo  | the single source of the default set                         |
