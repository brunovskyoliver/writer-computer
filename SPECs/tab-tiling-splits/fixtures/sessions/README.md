# Session fixtures

Shared by `apps/desktop/tests/session.test.ts` and the Rust tests in
`apps/desktop/src-tauri/src/session.rs`. Both codecs must accept, reject,
migrate, prune, and extract the focused file from every fixture identically;
this directory is the runtime assertion that the two mirrored wire
declarations do not drift (constitution III).

Each file is one case:

```json
{
  "description": "why this case exists",
  "input": <the raw value stored under the workspace key in sessions.json, or null>,
  "missing_files": ["/vault/gone.md"],
  "expected": {
    "status": "ready" | "malformed" | "missing",
    "session": <canonical v2 after migration and pruning, or null when nothing remains>,
    "focused_file": "/vault/a.md" | null
  }
}
```

`missing_files` is optional and lists paths that do not exist at restore
time; both sides prune against it with the same rules (remove tabs whose
location is missing, drop history entries that reference a missing path,
collapse empty panes, activate the tab that slides into a removed active
tab's slot else the previous one, move a lost focus to the first pane in
tree order). `session` and `focused_file` are only present for `ready`.

Adding a case: drop a file here. Both test suites glob the directory.
