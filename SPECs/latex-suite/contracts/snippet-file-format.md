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

- Regex triggers use ECMAScript `u` semantics, anchored as `(?:<source>)$` against the current line's text up to the caret (after the just-typed character lands). A bounded interpreter runs them; whole custom patterns never execute in the native regex engine. Literal triggers use a direct suffix check. Multi-line context is never visible to a trigger.
- Raw and expanded triggers are limited to 2,048 UTF-16 characters, regex group nesting to 32, captures to 128 and compiled instructions to 8,192. Variable expansion checks projected length before concatenation. Counted repetitions compile as counters, without unrolling. Capture counts come from parsed syntax, without matching the pattern at load time.
- Regex alternatives, greedy/lazy repetitions, captures, character classes/Unicode properties, anchors, word boundaries and positive/negative lookahead/lookbehind are supported. Backreferences, named captures, inline flag modifiers and `v` semantics are rejected with `invalid-pattern`. Existing regex-literal flags other than `v` continue to be ignored in favor of `u` semantics.
- Matching shares a 20ms deadline and 50,000 interpreter operations across the full candidate scan. Each pattern has its own 25,000-operation allowance and time accounting and a 256-state backtracking cap, including nested lookarounds. Individual exhaustion disables that pattern until reload. Shared exhaustion skips remaining regex candidates without disabling healthy entries; direct literal checks may continue while the deadline permits. Normal input remains available and the next input gets a fresh budget.
- The whole match (`match[0]`) is replaced. Use `[[n]]` to re-insert captured context.
- `[[n]]` refers to capture group `n + 1` (Obsidian convention: `[[0]]` is the first parenthesised group).
- Among all matching snippets, the highest `priority` wins; ties prefer the longer trigger source, then the earlier entry.
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

| Code                   | When                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `not-an-object`        | array element is not an object literal                                                            |
| `missing-field`        | `trigger`, `replacement` or `options` absent                                                      |
| `invalid-options`      | unknown letter, or not exactly one mode letter                                                    |
| `invalid-pattern`      | invalid `u` syntax, unsupported regex constructs, or a trigger/compilation limit exceeded         |
| `missing-capture`      | `[[n]]` in replacement with no group `n + 1` in the trigger                                       |
| `unknown-variable`     | `${NAME}` not defined in `latex.snippet-variables`                                                |
| `invalid-priority`     | `priority` present but not a finite number                                                        |
| `function-replacement` | `replacement` is a function or arrow function                                                     |
| `unsupported-value`    | any other unsupported expression in a known key                                                   |
| `pattern-timeout`      | runtime: an individual pattern exceeded its work, state or 20ms limit; disabled until next reload |
| `pattern-threw`        | runtime: unexpected matching failure; snippet disabled until next reload                          |
| `invalid-variable`     | a `latex.snippet-variables` item is not `NAME=value`                                              |

## Compatibility statement (SC-006)

The user's Obsidian Latex Suite file (`SPECs/obsidian-latex-suite`) parses with exactly four `function-replacement` warnings (indices of the four function entries). The shipped adaptation compiles without errors. Custom declarative patterns must also satisfy the supported syntax and limits above. `SPECs/latex-suite/contracts/` is the normative reference for the test `latex-snippet-file.test.ts`.

## Shipped default set

`apps/desktop/shared/latex-snippets.default.js` is the adapted reference file. Two space/guard functions were replaced per research R4, `iden` and list-aware `dm` removed, `${SYMBOLS}` corrected to `${SYMBOL}` and subsequent default-set fixes recorded in the changelog. The commented-out "convert letters to math" rules remain commented. This contract documents custom trigger syntax and limits.
