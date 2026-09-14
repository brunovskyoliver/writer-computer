# Contract: Settings Schema and Section

## Schema entries (`apps/desktop/shared/settings.schema.json`, category `LaTeX Suite`, scope global)

| Key                       | Type      | Default   | Label                 | Description                                                                                    |
| ------------------------- | --------- | --------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `latex.snippets-enabled`  | `boolean` | `true`    | Snippets              | Expand LaTeX snippets while typing (automatic) or on Tab                                       |
| `latex.tab-out`           | `boolean` | `true`    | Tab out of brackets   | Inside math, Tab jumps past the next closing bracket or the closing `$`                        |
| `latex.auto-fraction`     | `boolean` | `true`    | Auto fraction         | Inside math, `/` after an operand turns it into `\frac{…}{}`                                   |
| `latex.highlight-source`  | `boolean` | `true`    | Highlight math source | Colour commands, brackets, operators, numbers and comments in unfolded math and `latex` fences |
| `latex.snippet-variables` | `list`    | see below | Snippet variables     | `NAME=alternation` pairs referenced as `${NAME}` in the snippet file                           |

Default `latex.snippet-variables` (values copied from the Obsidian plugin's defaults, which the reference file relies on):

```
GREEK=alpha|beta|gamma|Gamma|delta|Delta|epsilon|varepsilon|zeta|eta|theta|Theta|iota|kappa|lambda|Lambda|mu|nu|omicron|xi|Xi|pi|Pi|rho|sigma|Sigma|tau|upsilon|Upsilon|varphi|phi|Phi|chi|psi|Psi|omega|Omega
SYMBOL=parallel|perp|partial|nabla|hbar|ell|infty|oplus|ominus|otimes|oslash|square|star|dagger|vee|wedge|subseteq|subset|supseteq|supset|emptyset|exists|nexists|forall|implies|impliedby|iff|setminus|neg|lor|land|bigcup|bigcap|cdot|times|simeq|approx
MORE_SYMBOLS=leq|geq|neq|gg|ll|equiv|sim|propto|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|to|mapsto|cap|cup|in|sum|prod|exp|ln|log|det|dots|vdots|ddots|pm|mp|int|iint|iiint|oint
ACCENT=hat|bar|dot|ddot|tilde|vec|underline|overline|mathrm|mathbf|boldsymbol
SYMBOLS=parallel|perp|partial|nabla|hbar|ell|infty|oplus|ominus|otimes|oslash|square|star|dagger|vee|wedge|subseteq|subset|supseteq|supset|emptyset|exists|nexists|forall|implies|impliedby|iff|setminus|neg|lor|land|bigcup|bigcap|cdot|times|simeq|approx
```

(`SYMBOLS` duplicates `SYMBOL` so the reference file's `${SYMBOLS}` entry resolves; the value list above is the plugin default and is finalised in the implementation task by copying from the plugin's `default_snippet_variables`.)

Rust reads these through the existing `include_str!` of the schema; nothing else declares them (Principle III).

## Section rendering (`components/settings-panel`)

The generic renderer already produces the five controls for category `LaTeX Suite` (boolean toggles + the list editor). One addition: a `SECTION_EXTRAS: Record<string, ComponentType>` registry in `index.tsx`, rendered under a section's schema controls; `{"LaTeX Suite": LatexSuiteExtras}` is the only entry. `LatexSuiteExtras` shows:

| Element               | Behaviour                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snippet file path     | muted text, the absolute path from the store (`filePath`)                                                                                                                                |
| **Edit snippets**     | `useLatexSnippetStore.getState().openInEditor()` — opens/focuses the tab in the focused pane; Settings tab stays open behind it                                                          |
| **Reset to defaults** | native confirm dialog (`@tauri-apps/plugin-dialog` `ask`) → `reset()`; on cancel nothing happens                                                                                         |
| Status line           | `loaded`: "N snippets loaded" · `loaded` with warnings: "N loaded, M skipped" + list · `failed`: red text "Could not load: <message> (line L)" + "Using the last valid set (N snippets)" |
| Warning list          | one row per `EntryError`: `#index` · trigger (if any) · line · message                                                                                                                   |

No toasts, no dialogs on load errors (spec assumption). The section re-renders from the store; it does not read the file itself.

## Multi-window (FR-026)

Global setting writes already propagate to the writing window; the global watcher in [ipc-and-events.md](./ipc-and-events.md) makes every other window reload its settings store within one debounce interval. Snippet-file changes reach every window through the same watcher.
