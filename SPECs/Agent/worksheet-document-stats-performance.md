# Performance review

Task: [spec](../document-stats-performance.md), TODOS performance review entry.

Working tree was clean. Reviewed document-stats, file-tree/flatten-tree, editor-store refresh/update paths, search.rs and watcher.rs; consolidation and review workflow docs.

Plan: preserve normalization order; combine counting into one regex traversal of whitespace runs and surrogate pairs. Whitespace runs contribute one character, one word boundary, and a paragraph boundary only when they contain two LF characters. Surrogate pairs subtract one UTF-16 unit. Test equivalence using the old implementation as oracle and benchmark representative large documents.

Initial validation blocked: vp is absent from PATH; locate installed executable before proceeding. No Rust changes planned.

## Results

QA reviewed the plan and implementation with no code findings. The change keeps Markdown normalization intact and combines counting only. A frozen previous implementation checks 1,000 deterministic mixed inputs.

Validation: local `node_modules/.bin/vp install`, `vp check` (zero errors, eight existing warnings), and `vp test` (1,024 passing tests). Cargo tests (187 passing), clippy (existing warnings) and format check pass. The local vp executable resolves the missing PATH entry.

Benchmark: Node v26.5.0, approximately one million UTF-16 units, ten warmup calls per implementation, median of 25 timed calls. Plain text: 16.20 ms before, 12.04 ms after. Markdown: 13.57 ms before, 6.12 ms after. These are synthetic Node timings, not desktop WebView measurements. Reproduce from repository root with the command below (the baseline commit is fixed):

```sh
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';
const load = async source => (await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`)).getDocumentStats;
const before = await load(execFileSync('git', ['show', '6023d38:apps/desktop/src/lib/document-stats.ts'], {encoding: 'utf8'}));
const after = await load(readFileSync('apps/desktop/src/lib/document-stats.ts', 'utf8'));
for (const [name, line] of [
  ['plain', 'The writer makes a sentence with several words.\n\n'],
  ['markdown', '# Heading 😀\n\n- Some `code` and [a link](https://example.com) with [[wiki]] text.\n\n'],
]) {
  const content = line.repeat(Math.ceil(1_000_000 / line.length));
  assert.deepEqual(after(content), before(content));
  for (let i = 0; i < 10; i++) { before(content); after(content); }
  const median = fn => {
    const samples = [];
    for (let i = 0; i < 25; i++) {
      const start = performance.now(); fn(content); samples.push(performance.now() - start);
    }
    return samples.sort((a, b) => a - b)[12];
  };
  console.log(name, {units: content.length, beforeMs: median(before), afterMs: median(after)});
}
JS
```

No runtime UI changes or Rust changes. No cache or store migrations. Tree virtualization, search normalization caching, and watcher batch changes remain profiling candidates, not demonstrated bottlenecks in this review.
