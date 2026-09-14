# Performance review and document stats

Review the five suggested hot spots. Make bounded improvements while preserving behavior.

Implement a combined whitespace/surrogate-pair scan after existing Markdown normalization. Preserve word, code-point character, and blank-line paragraph counts, including Unicode whitespace and malformed surrogates. Do not cache full documents or introduce incremental parsing without measurements.

Tree flattening already uses useMemo and visits expanded descendants only. Watcher work already runs on a dedicated thread. Search lowercases each candidate but uses substring matching, not regex or fuzzy scoring; defer index caches until their memory and invalidation costs are measured. Map copies retain existing file objects; avoid a new immutable-data dependency.

Validate against the previous algorithm with generated mixed Markdown/Unicode inputs and existing tests. Record a repeatable large-document timing comparison.
