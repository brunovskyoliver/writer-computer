# Code review completion report

Completed on 2026-10-02. All 20 findings from the desktop review and two adjacent fixes are implemented in separate local commits. Each linked ticket records its investigation, regression checks, review and remaining validation limits.

The main changes protect unsaved work, bound retained metadata and compiler output, release failed acquisitions and completed tasks, and make LaTeX transformations and numeric checks more conservative. The review covered application resource ownership and failure/reset paths; it does not certify every allocation made by WebKit, pdf.js or native libraries.

| Finding                             | Result                                                                                                                                        | Commit    | Ticket                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------- |
| 01: Workspace save boundary         | Close and switch drain pending clipboard edits and save all text before reset. Failed saves preserve the workspace.                           | `f9966c7` | [Report](../Agent/worksheet-review-01-workspace-save.md)         |
| 02: Failed PDF search acquisition   | Failed loads release their reference and allow the idle PDF worker to terminate.                                                              | `1400e05` | [Report](../Agent/worksheet-review-02-pdf-search-release.md)     |
| 03: Compiler output retention       | Both pipes drain with bounded buffers, logs and diagnostics. Error/timeout paths kill, reap and join readers.                                 | `94115a7` | [Report](../Agent/worksheet-review-03-compiler-output.md)        |
| 04: Image height metadata           | A 256-entry recency cache uses compact keys for data URLs and long destinations. Decode corrects stale hints.                                 | `df95150` | [Report](../Agent/worksheet-review-04-image-height-cache.md)     |
| 05: Workspace-owned LaTeX state     | Reset clears build/PDF records and queues; generation and identity checks reject old completions.                                             | `02540fb` | [Report](../Agent/worksheet-review-05-latex-reset.md)            |
| 06: Shared compile roots            | Canonical root locks serialize native output writes across aliases, chapters and windows. Frontend requests retain publication ownership.     | `01e01a8` | [Report](../Agent/worksheet-review-06-compile-root-lock.md)      |
| 07: Save failure before compile     | Explicit compile and preview commands stop when source saving fails.                                                                          | `60b8284` | [Report](../Agent/worksheet-review-07-compile-save-failure.md)   |
| 08: Preview root selection          | Commands discover roots after saving, use the returned PDF and preserve explicit/queued request ordering.                                     | `2f436ae` | [Report](../Agent/worksheet-review-08-preview-root.md)           |
| 09: Aligned math splitting          | Only whole aligned-family formulas split. Every output row validates before one undoable transaction.                                         | `4dd2be5` | [Report](../Agent/worksheet-review-09-math-split.md)             |
| 10: TeX syntax stars                | Tidy preserves starred commands, scripts, literal text, metadata and comments while recognizing operand multiplication.                       | `bf26e85` | [Report](../Agent/worksheet-review-10-tidy-stars.md)             |
| 11: Nested matrix separators        | Set-based collection rewrites each separator once.                                                                                            | `9df8a3e` | [Report](../Agent/worksheet-review-11-tidy-nesting.md)           |
| 12: Literal argument spacing        | Cell-level tidy preserves text, grouped arguments, optional indices, column specs and comments.                                               | `723c9cd` | [Report](../Agent/worksheet-review-12-tidy-text.md)              |
| 13: Expression equality             | Bare expressions compare values. Proportional residual checks apply only to two single equations.                                             | `d590c3d` | [Report](../Agent/worksheet-review-13-math-expression-check.md)  |
| 14: Valid numeric evidence          | Equality requires finite usable samples; bounded recovery and normalized comparisons avoid singular/overflow false matches.                   | `106580b` | [Report](../Agent/worksheet-review-14-math-valid-samples.md)     |
| 15: Numeric formatting              | Integer zeros and scientific exponents are preserved; large complex values avoid norm-overflow zero formatting.                               | `527071c` | [Report](../Agent/worksheet-review-15-math-format.md)            |
| 16: TeX token boundaries            | Numeric annotations follow TeX arguments and superscripts. Plot fences keep ordinary power syntax and bare function aliases.                  | `57cd58c` | [Report](../Agent/worksheet-review-16-math-exponents.md)         |
| 17: Zero powers and roots           | Positive finite real powers of zero, zero roots and inverse-function endpoints evaluate correctly.                                            | `b14f23d` | [Report](../Agent/worksheet-review-17-math-zero.md)              |
| 18: Pathological snippet matching   | Custom patterns use interruptible bounded programs, with load errors for unsupported/oversized syntax. Compiled patterns release parser ASTs. | `63f112b` | [Report](../Agent/worksheet-review-18-snippet-budget.md)         |
| 19: Removed tab view state          | Workspace reset clears each removed tab's independent cursor and scroll record.                                                               | `7b92fbb` | [Report](../Agent/worksheet-review-19-tab-view-reset.md)         |
| 20: Failed MCP handshakes           | Rejected handshakes reach cleanup. Registration shares the cleanup lock and checks settings admission before spawning.                        | `a60b60e` | [Report](../Agent/worksheet-review-20-mcp-handshake-cleanup.md)  |
| 21: Native Close/Quit saves         | Native shutdown uses the text/input barrier before drawing saves and acknowledges only its current request.                                   | `a922fd3` | [Report](../Agent/worksheet-review-21-native-shutdown.md)        |
| 22: Wiki image resolution retention | A 256-entry positive LRU clears on reset, ignores old completions and caps serialized key plus path at 8,192 UTF-16 characters.               | `7e91450` | [Report](../Agent/worksheet-review-22-embed-resolution-cache.md) |

Final validation on the completed source:

- `vp test`: **1,687 tests pass in 110 files**.
- `vp check`: formatting, lint and type checks pass with **0 errors and 10 existing warnings**.
- Desktop `vp run build`: TypeScript compilation and production bundling pass. Existing toolchain, chunk-size and dynamic-import warnings remain.
- `cargo test`: **276 tests pass**.
- `cargo clippy`: succeeds with **9 existing warnings** outside the changed Rust paths.
- `cargo fmt --check` and `git diff --check`: pass.

Relevant review personas approved the non-trivial fixes. Trivial existing-helper/guard corrections record their formal-review skip in their tickets and commits. Snippet review included 95,522 short-input differential comparisons and a garbage-collection probe showing four parser ASTs released while their compiled patterns remained usable.

Browser checks exercised real CodeMirror views and the shipped Markdown/math grammar for input freezing, Vim paste, image sizing, math rewrites and undo, and snippet fallback. The hostile snippet returned normal typing in 3.4 ms; subsequent literal expansion took 0.4 ms. Preview-root checks used the actual store/save pipeline with mocked native IPC. The final wiki-image widget check used installed Chrome in an isolated temporary profile after the shared T3 preview explicitly became unavailable. It verified one lookup shared by two widgets, re-probing after real editor-store reset, source preservation and protection of a newer same-key result from an older completion.

Remaining validation limits:

- Native/WebKit heap and allocator profiling was not performed. Bounded application metadata and unit-level ownership checks do not establish whole-process memory behavior.
- Native two-window Close/Quit and compile flows, plus full native PDF rendering/scroll preservation, still need a live runtime check. The ordinary browser has no Tauri globals, so its whole-app error boundary was not treated as a native-app test.
- MCP tests cover handshake failures and cleanup separately. They do not drive the full `serve_connection` or accept/disable race through a real Tauri `AppHandle`.
- Injected OS polling/thread-start failures in compiler cleanup remain untested; real noisy output, timeout, startup failure and reader-failure paths are covered.

Math equality remains numeric sampling rather than proof, and unsupported forms report indeterminate. The existing `0^0 = 1` convention remains explicit. Positive image resolutions may stay stale until eviction or reset. Snippet matching has work/time/state limits; whole-file parsing and replacement expansion retain their existing size behavior.

All review tickets are Done. Temporary test servers, browser profiles and owned scratch fixtures were removed at wrap-up. The user's pre-existing AGENTS.md edit remains outside these commits.
