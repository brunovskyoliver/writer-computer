# Contract: Snippet File Format

**File**: `<app_data_dir>/latex-snippets.js` (macOS: `~/Library/Application Support/<bundle-id>/latex-snippets.js`). Plain UTF-8 text. Owned by the user; the app writes it only on first creation and on "Reset to defaults".

## Grammar (what the parser accepts)

The file is JavaScript _syntax_, parsed with `acorn`, never evaluated. Exactly one of:

```js
export default [ <entry>, <entry>, ... ]
[ <entry>, <entry>, ... ]
```

`//` and `/* */` comments anywhere. Trailing commas allowed.

An `<entry>` is an object literal with these keys (others are ignored):

| Key           | Required | Accepted value                                                                                      |
| ------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `trigger`     | yes      | string literal `"…"`/`'…'`, template literal without `${}` expressions, or regex literal `/…/flags` |
| `replacement` | yes      | string literal or expression-free template literal                                                  |
| `options`     | yes      | string of option letters (see below)                                                                |
| `priority`    | no       | numeric literal, optionally negated (`-1`)                                                          |
| `description` | no       | string literal                                                                                      |

`${NAME}` inside a _string_ trigger or replacement is a snippet variable reference (substituted at load). Inside a template literal it would be a JS expression and is rejected (`unsupported-value`) — use a quoted string.

## Option letters

| Letter | Meaning                                                                                       |
| ------ | --------------------------------------------------------------------------------------------- |
| `t`    | text mode: fires only in prose (not in math, not in code)                                     |
| `m`    | math mode: inline or display                                                                  |
| `n`    | inline math only                                                                              |
| `M`    | display math only                                                                             |
| `A`    | automatic: fires as the last trigger character is typed; without `A` the snippet fires on Tab |
| `r`    | trigger is a regular expression (implied by a regex literal)                                  |
| `w`    | word boundary: the character before the match must not be a letter, digit or `_`              |

Exactly one of `t m n M` is required. Any other letter → `invalid-options`.

## Trigger semantics

- Compiled as `(?:<source>)$` with the `u` flag, tested against the current line's text up to the caret (after the just-typed character lands). Multi-line context is never visible to a trigger.
- The whole match (`match[0]`) is replaced. Use `[[n]]` to re-insert captured context.
- `[[n]]` refers to capture group `n + 1` (Obsidian convention: `[[0]]` is the first parenthesised group).
- Among all matching snippets, the highest `priority` wins; ties go to the earlier entry.
- Automatic snippets do not fire when the match starts strictly inside a control-sequence word (`\name`) that ends at the caret (the "typing a macro" guard, see research R4).

## Replacement syntax

| Syntax             | Meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| `$N` (N = 0–9)     | tabstop; caret visits ascending N, `$0` first              |
| `${N:placeholder}` | tabstop with placeholder text, selected when visited       |
| same N twice       | one stop with several ranges — typing at one edits all     |
| `[[n]]`            | capture group `n + 1` of a regex trigger                   |
| `${VISUAL}`        | the selected text; makes the snippet a _visual_ snippet    |
| `${NAME}`          | snippet variable, substituted at load time                 |
| `\\`               | JS string escape for one backslash (`"\\frac"` is `\frac`) |
| other `$`          | literal (`"$$0$"` is `$`, stop 0, `$`)                     |

Visual snippets fire only when text is selected and the typed character equals the trigger string exactly; all other snippets fire only with an empty selection.

## Error reporting

Loading never runs user code and never throws past the store. Two levels:

1. **File-level failure** (`status.kind = "failed"`): unreadable file, or `acorn` syntax error. `LoadError` carries `message`, `line`, `column`. The previous valid set stays active.
2. **Entry-level errors** (`status.warnings`): the entry is skipped, the rest load. Each carries `code`, `index`, `line`, `trigger` (when a string), `message`.

| Code                   | When                                                                            |
| ---------------------- | ------------------------------------------------------------------------------- |
| `not-an-object`        | array element is not an object literal                                          |
| `missing-field`        | `trigger`, `replacement` or `options` absent                                    |
| `invalid-options`      | unknown letter, or not exactly one mode letter                                  |
| `invalid-pattern`      | regex does not compile under the `u` flag (message from the JS engine)          |
| `missing-capture`      | `[[n]]` in replacement with no group `n + 1` in the trigger                     |
| `unknown-variable`     | `${NAME}` not defined in `latex.snippet-variables`                              |
| `invalid-priority`     | `priority` present but not a finite number                                      |
| `function-replacement` | `replacement` is a function or arrow function                                   |
| `unsupported-value`    | any other unsupported expression in a known key                                 |
| `pattern-timeout`      | runtime: a single evaluation exceeded 20 ms; snippet disabled until next reload |
| `pattern-threw`        | runtime: `RegExp.exec` threw; snippet disabled until next reload                |
| `invalid-variable`     | a `latex.snippet-variables` item is not `NAME=value`                            |

## Compatibility statement (SC-006)

The user's Obsidian Latex Suite file (`SPECs/obsidian-latex-suite`) loads with exactly four `function-replacement` warnings (indices of the four function entries) and no other errors. `SPECs/latex-suite/contracts/` is the normative reference for the test `latex-snippet-file.test.ts`.

## Shipped default set

`apps/desktop/shared/latex-snippets.default.js` = the reference file with: the two space/guard functions replaced per research R4, `iden` and list-aware `dm` removed, `${SYMBOLS}` corrected to `${SYMBOL}`, commented-out "convert letters to math" rules left commented, a header comment explaining the format and pointing at `docs/latex-suite.md`.
