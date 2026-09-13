# Writer Constitution

## Core Principles

### I. Local-First Plain Text (NON-NEGOTIABLE)

User documents are plain Markdown files on the user's disk, readable and editable without
Writer. The app MUST launch, open a workspace, edit, and save with no network connection
available. No feature may introduce a proprietary store, a required account, or a required
server round-trip on a document path.

Anything leaving the machine is opt-in and disclosed: telemetry MUST default to off, MUST
be documented in `docs/telemetry.md`, and adding an event MUST update the call site, that
doc, and the consent dialog in the same change.

Rationale: the target user keeps Obsidian vaults and docs repos and expects their files to
outlive the editor. A single mandatory network hop breaks that promise permanently.

### II. Smallest Correct Change

Ship the smallest change that is correct, robust, and easy to reason about. An abstraction
MUST NOT be introduced for a single caller: no interface with one implementation, no
factory for one product, no config key for a value that never varies. Speculative
scaffolding for anticipated future work MUST NOT be added.

Smallness never justifies skipping comprehension. Before editing a shared function, all of
its callers MUST be checked; a fix belongs at the point every caller routes through, not
in the one path a bug report happened to name.

Rationale: unused generality is permanent maintenance cost paid for a benefit that usually
never arrives, and a small diff in the wrong place is a second bug rather than a fix.

### III. One Place Per Concern

Adding the next case in a domain MUST touch exactly one file. If it touches more than one,
the structure is wrong and MUST be fixed before the case is added.

Concretely: a value or shape defined twice MUST have one definition derive from the other,
enforced by codegen, a lint, or a runtime assertion — "we will remember to update both" is
not enforcement. Per-case `if`/`switch` chains over data MUST be replaced by a registry
that is iterated. A domain MUST have one write path.

Rationale: parallel lists drift, and the drift surfaces as an unreproducible bug months
later because each half was verified alone. See `docs/consolidation.md`.

### IV. Explicit Failure and Owned State

Invalid states and unexpected errors MUST surface. Errors MUST NOT be silently swallowed or
masked by fallback behavior that hides the failure from the user and from logs.

A store owns the side effects of mutating its domain. Side-effect helpers MUST NOT be
imported or invoked outside their owning module; hydration and runtime mutation MUST run
through the same entry point. Async flows over shared state MUST be race-safe by explicit
sequencing, cancellation, or idempotency, and MUST NOT rely on incidental execution order.

Rationale: the theme-hydration bug in `docs/consolidation.md` shipped because a call site
applied a side effect itself and drifted from the store. The compiler cannot catch that
class of divergence; structure can.

### V. Specs and Docs Move With the Code

Non-trivial work MUST have a spec in `SPECs/` before implementation begins, linked from its
task in `TODOS.md`. User-visible changes MUST be recorded in `CHANGELOG.md` in the same
change that makes them. When a behavior or rule changes in practice, the doc that owns that
rule MUST be updated in the same task — a doc that describes the old behavior is worse than
no doc.

Rationale: this codebase is worked on by agents that load documentation as their only
context. Stale docs actively mislead the next contributor, human or otherwise.

### VI. Code structure

We do not reinvent the wheel. Meaning do not implement features which can be used via third party library.
Always simplicity over complicated implementations.
Do not over-test -> especially in UI. Always get back to me so I can review the changes.
DO NOT GET STUCK IN LOOP WHILE TESTING.

### VII. Scope of the user

This tool is primary for me, for school, my studying processes and writing knowledge about work.
I used Obsidian b4 but was not really happy about it.

## Technology and Quality Constraints

Stack: Tauri v2 — React frontend in `apps/desktop/src/`, Rust backend in
`apps/desktop/src-tauri/src/`. Frontend tooling is Vite+, driven by the `vp` CLI.

Quality gates. A change is not complete until all of the following pass:

- `vp check` — format, lint, and TypeScript type checks
- `vp test` — JavaScript and TypeScript tests
- `cargo test`, `cargo clippy`, `cargo fmt --check` — from `apps/desktop/src-tauri/`

Non-trivial logic — a branch, a loop, a parser, a file-write path — MUST leave behind at
least one runnable check that fails if the logic breaks. Side effects MUST sit at
boundaries and dependencies MUST be explicit, so logic can be exercised in isolation.

Performance regressions MUST NOT be introduced casually. Added renders, subscriptions,
allocations, full scans, blocking work, or I/O on interactive paths MUST be justified in
the change that adds them.

## Development Workflow

1. Read `TODOS.md` before starting. Move the task Up Next → In Progress → Done as it
   progresses.
2. For non-trivial work, write the spec in `SPECs/` and link it from the task.
3. Load only the docs relevant to the current task; `CLAUDE.md` and `AGENTS.md` are routers,
   not reference material.
4. Implement, then run every quality gate listed above.
5. Update `CHANGELOG.md` and any doc whose stated rules the change altered.
6. One commit per completed task, with a message matching existing history. In autonomous
   or loop mode, complete exactly one task per commit; batching requires an explicit request.

When a fix fails after one iteration, add a debug log before changing approach again.
Iterating on guesses is prohibited — the runtime must identify which term is wrong.

Review follows the personas and findings format in `docs/workflows/agent-review.md`.

## Governance

This constitution supersedes other practice documents where they conflict. Where it is
silent, the linked guidelines in `docs/` govern.

Amendments require a written rationale in the amending change and a version bump under the
policy below. An amendment that invalidates existing code MUST state the migration path;
"new code only" is an acceptable path if said explicitly.

Versioning policy, semantic:

- MAJOR — a principle is removed or redefined in a backward-incompatible way
- MINOR — a principle or section is added, or guidance is materially expanded
- PATCH — clarification, wording, or typo fixes with no change in meaning

Compliance. Every review MUST verify the change against these principles. Deviation is
permitted only when recorded in the change itself, naming the principle, the reason, and
the option chosen — and the option chosen MUST be the one with the lowest long-term
correctness and maintenance risk.

**Version**: 1.0.0 | **Ratified**: 2026-09-13 | **Last Amended**: 2026-09-13
