# Quickstart: validating LaTeX Suite

Runnable checks that prove the feature end to end. Contracts: [snippet-file-format](./contracts/snippet-file-format.md), [editor-extension](./contracts/editor-extension.md), [ipc-and-events](./contracts/ipc-and-events.md), [settings](./contracts/settings.md). Data shapes: [data-model.md](./data-model.md).

## Prerequisites

```bash
vp install
cd apps/desktop && vp run dev        # or: vp exec tauri dev
```

Quality gates that must be green before any manual step is trusted:

```bash
vp check && vp test
cd apps/desktop/src-tauri && cargo test && cargo clippy && cargo fmt --check
```

## Automated scenarios (`vp test`)

| Test file                            | Proves                                                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `latex-snippet-file.test.ts`         | `SPECs/obsidian-latex-suite` parses with exactly 4 `function-replacement` warnings and no other errors (SC-006); a syntax error yields `failed` with the right line; `export default` and bare array both load |
| `latex-snippet-compile.test.ts`      | option validation table, `${GREEK}` substitution, `missing-capture`, priority/file-order sort                                                                                                                  |
| `latex-snippet-match.test.ts`        | `dm` vs `admin` (word boundary), `dot`/`ddot` priority, `sin` in prose does not match, macro guard (`\text` stays), visual `S` with selection                                                                  |
| `latex-snippet-expand.test.ts`       | `//` → `\frac{}{}` with stops 0,1,2; `${0:f}` placeholder selected; repeated `$0` → two ranges; nested frame pops back to outer                                                                                |
| `latex-math-context.test.ts`         | prose / `$x$` inline / `$$x$$` display / `\text{}` / inline code / fenced code                                                                                                                                 |
| `latex-auto-fraction.test.ts`        | `(a+b)/` → `\frac{a+b}{}`; `x^2/` → `\frac{x^2}{}`; `\sqrt{x}/`; ` /` → literal                                                                                                                                |
| `latex-tab-out.test.ts`              | `\sqrt{x                                                                                                                                                                                                       | }`→ past`}`; at end of content → past `$`; nothing ahead → `false` |
| `latex-highlighting.test.ts`         | tokenizer emits the five classes; `MathFormula` mounts the nested tree; ` ```latex ` resolves to the same language                                                                                             |
| `latex-default-set.test.ts`          | SC-001: every string-trigger default snippet expands to its replacement with the caret at the first stop; the whole set matches a 200-char line in < 1 ms                                                      |
| `settings-schema.test.ts` (existing) | the five new keys have defaults and categories                                                                                                                                                                 |

Rust (`cargo test`): `latex_snippets_path` creates the file once and never overwrites; `reset_latex_snippets` restores the default bytes; `Settings::reload_global` picks up an external edit.

## Manual scenarios (running app)

### 1. Snippets in a note (US1)

1. New note. Type `mk` → `$|$`, caret inside. Type `//` → `\frac{|}{}`. Tab → denominator. Tab → after `}`.
2. Type `sin`, `cos`, `theta`, `->`, `RR`, `ooo` inside math → `\sin` `\cos` `\theta` `\to` `\mathbb{R}` `\infty`.
3. New line, type `dm` → `$$` / empty line / `$$`, caret on the empty line. Type `cases` → `\begin{cases} … \end{cases}` with caret inside.
4. In prose type "the sin of theta" → nothing expands.
5. After any expansion press ⌘Z once → trigger text is back (`mk`). Press Backspace right after an expansion → same result.
6. Select `a+b` inside math, type `S` → `\sqrt{ a+b }`. With no selection `S` is literal.
7. Type `(a+b)/` in math → `\frac{a+b}{|}`. Type `x^2/` → `\frac{x^2}{|}`. Type ` /` → literal `/`.
8. Inside `\sqrt{x|}` with no active stop press Tab → past `}`; Tab again at end → past `$`.
9. Type `\text` letter by letter in math → stays `\text` (macro guard). Type `\alpha` then `x` → `\alpha x`. Type `\in` then `t` → `\int`.
10. Turn on Vim mode: in Normal mode `mk` does not expand; in Insert mode it does; Esc clears tabstop highlights.

### 2. Edit the snippet file live (US2)

1. Settings → LaTeX Suite → **Edit snippets**. A new tab `latex-snippets.js` opens with JavaScript highlighting; Settings stays open. Click **Edit snippets** again → the same tab is focused, no duplicate.
2. Append `{trigger: "lap", replacement: "\\mathcal{L}", options: "mA"},`, ⌘S. Switch to the note, type `lap` in math within a second → `\mathcal{L}`. Watch the note: no scroll jump, no caret move, no flicker.
3. Edit the file in another editor (e.g. `code`/`vim`), save → the open tab reloads and the new trigger works.
4. Break the file (`{trigger: "x"` unclosed), save → the note's snippets still work; Settings shows "Could not load … line N"; the tab shows no dialog. Fix it, save → the message clears.
5. Add `{trigger: "bad", replacement: "[[3]]", options: "mA"}` → Settings lists one skipped entry with index and line; everything else still works.
6. Quit, delete the file, relaunch, click **Edit snippets** → a populated file is recreated.
7. **Reset to defaults** → confirm dialog → file content is the shipped default; the open tab shows it.
8. Two windows: open the snippet tab in both; save from A → B's tab and B's snippets update once.

### 3. Highlighting (US3)

1. Put the caret in `$$\begin{cases} \frac{a}{b} & x % note \\ c & y \end{cases}$$`. Five visibly distinct colours: commands, braces, `& \\ ^ _`, numbers, the comment.
2. Caret beside `{` → its `}` is outlined; delete the `}` → the `{` shows the error colour.
3. A ` ```latex ` fence shows the same colours; ` ```tex ` too.
4. Move the caret out → the rendered KaTeX widget looks exactly as before the feature.
5. Switch light/dark and a custom theme preset → colours follow.

### 4. Settings (US4)

1. Toggle **Snippets** off → `sin` in math stays literal; Tab behaves as before. On → expands.
2. Toggle **Highlight math source** off → unfolded math is code-font, delimiters muted, no colours. On → colours return without the caret moving.
3. Toggle **Tab out** and **Auto fraction** individually and repeat 1.7/1.8.
4. Remove `phi` from `GREEK` in **Snippet variables** → in math `phi` stays literal. Restore `phi` → `phi` expands to `\phi` (through the "add backslash before Greek letters" rule). The default already includes `phi`, so adding it without first removing it does not test recompilation.
5. With two windows open, change any LaTeX toggle in A → B reflects it (check B's Settings and behaviour) without restart.

### 5. Performance (SC-004)

Open a 5,000-line note (generate one with a 200-line math-heavy section repeated 25×). In DevTools → Performance, record 30 s of typing inside math with snippets on, then off. Compare p95 "keypress → paint" — must be within 2 ms. Record the two numbers in the tasks checkpoint.

## Expected outcome

All automated tests pass; every manual step behaves as written; `CHANGELOG.md`, `docs/latex-suite.md` and `docs/keyboard-shortcuts.md` describe the shipped behaviour; `TODOS.md` moves the task to Done.
