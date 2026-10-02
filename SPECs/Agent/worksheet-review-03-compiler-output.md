# Bound LaTeX compiler output

Status: Done.

Spec: [Code review fixes](../review-fixes/spec.md). Review finding 3.

## Plan

Drain stdout and stderr without retaining unlimited bytes. Keep diagnostics and returned logs bounded and report truncation.

Replace read-to-end collectors with fixed 8 KiB read chunks, a 64 KiB byte tail per stream and an 8 KiB line buffer. Parse diagnostics incrementally so an early error survives log-tail eviction; cap retained diagnostics at 200 and prioritize errors over warnings. Bound the merged log by bytes and 200 lines and report truncation explicitly. Reader failures and panics return errors instead of silently returning empty logs. Keep stdout/stderr drained on separate threads. Every post-spawn exit settles the child and joins both readers before returning any wait/read/panic error. Kill and reap on polling failure and timeout, and report cleanup failures explicitly.

Extract the collector into a private Rust module so the command retains process and root ownership. Validate tens of megabytes, newline-free and invalid UTF-8 output, early diagnostics, diagnostic overflow and read errors with bounded synthetic readers; retain installed-engine success/failure integration coverage. Apply final caps after UTF-8 decoding, markers, merged diagnostics and timeout/fallback errors. Retain earliest errors and suppress boilerplate across both streams. Update the LaTeX spec with output caps and the command error-contract comment.

Systems and QA plan reviews approved. Rust review required explicit cleanup on polling failure and joining both readers before propagating errors; those requirements are now part of the plan.

## Report

Extracted bounded stream collection into commands/latex_output.rs. Each pipe retains 64 KiB and one 8 KiB line; parsing keeps early diagnostics independently of the log tail. Final decoded logs fit 128 KiB/200 lines and diagnostics fit 200 entries, including timeout/fallback/truncation notices. The command kills/reaps on polling failure or timeout and joins both readers before propagating errors.

Rust and Systems reviews approved after fixing the final-cap truncation notice order. QA found a noisy-process test false positive; it now requires the engine to exit without timeout. A direct two-stream regression verifies the merged diagnostic budget. Targeted checks cover 32 MiB streams, bounded live buffer capacities, EOF draining, malformed/split UTF-8, CRLF/final lines, warning saturation, early errors and synthetic error budgets. Process checks cover noisy pipes, timeout cleanup and reader panic joining its sibling. Installed Tectonic 0.17.0 success/failure runs passed. Full Rust suite passed 266 tests before the final merged-budget test; final targeted suite has 23 tests. Clippy and fmt pass with existing warnings only.

Remaining validation gaps are injected OS polling/thread-start failures and native allocation profiling. Later ticket06 handles canonical-root serialization.
