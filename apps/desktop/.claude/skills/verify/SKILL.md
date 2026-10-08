---
name: verify
description: Build, launch, and drive the Writer desktop app to verify a change end-to-end via the macOS WebDriver harness, including real MCP stdio clients.
---

# Verifying Writer desktop changes

The surface is a macOS Tauri GUI. Use the repo's WebdriverIO and tauri-webdriver
harness in `apps/desktop/e2e/`. Install the intermediary with
`cargo install tauri-webdriver --locked`.

## Toolchain and build

If Rust or Vite+ is missing, the official installers work:

```sh
curl -fsSL https://sh.rustup.rs -o /tmp/writer-rustup.sh
sh /tmp/writer-rustup.sh -y --profile minimal
curl -fsSL https://viteplus.dev/install.sh -o /tmp/writer-vp-install.sh
VP_NODE_MANAGER=no VP_HOME="$HOME/.vite-plus" bash /tmp/writer-vp-install.sh
source "$HOME/.cargo/env"
source "$HOME/.vite-plus/env"
vp install
```

Vite+ installation can download managed Node even when system Node is installed;
network restrictions must allow `nodejs.org` as well as npm/Vite+/Rust registries.

From `apps/desktop`, avoid needing a separate cargo-tauri CLI installation by
using the CLI already installed in workspace dependencies:

```sh
vp exec tauri build --features e2e --bundles app --ignore-version-mismatches \
  --config '{"identifier":"com.writer-computer.e2e","bundle":{"createUpdaterArtifacts":false}}'
```

Alternatively, `cargo tauri build` with the same flags works from
`apps/desktop/src-tauri` when cargo-tauri is installed.

- `--ignore-version-mismatches` may be required while npm Tauri packages lag Rust.
- Binary: `apps/desktop/src-tauri/target/release/bundle/macos/Writer.app/Contents/MacOS/desktop`.
- Rebuild after frontend changes too; the app ships built assets.

## Launch state

E2E app data: `~/Library/Application Support/com.writer-computer.e2e`.
Create that directory if absent. For a deterministic disposable workspace,
seed `recent_workspaces.json` with `["/absolute/canonical/workspace/path"]`.
Startup restores its first existing directory. Do not wipe non-test app data.

## Drive

From `apps/desktop/e2e`, run
`vp exec wdio run ./wdio.conf.js --spec ./specs/<your>.spec.js`.

- Wait for `button[aria-label="Hide sidebar"]`, not the obsolete `.animate-fade-in`.
- WKWebView key chords can be flaky. Synthetic KeyboardEvents via
  `browser.execute` may help; dispatch editor shortcuts on `.cm-content`,
  not document, when CodeMirror owns them.
- Cmd+P opens the palette. Settings item: `[cmdk-item][data-value="open-settings"]`.
- `setValue` on empty inputs may throw in clear; use `addValue`.
- Real Rust IPC is reachable via `window.__TAURI_INTERNALS__.invoke` in
  `browser.executeAsync`; do not substitute direct write IPC for MCP testing.
- Screenshots: `browser.saveScreenshot(absPath)`.
- `specs/font-picker.spec.js` is a working palette/settings example and may skip
  if workspace restore did not complete.
- If Writer is not foreground after driver launch, activate process `desktop`
  through System Events; maximize using the native title bar before recording.

## MCP runtime checks

- UI: sidebar Search → Settings → Privacy → MCP Server.
- Create a symlink named `writer` to the built `desktop` binary. The basename
  activates CLI mode; invoke that symlink with `mcp`.
- Use a long-lived subprocess or initialize each fresh connection, send
  `notifications/initialized`, then tools/list or tools/call as NDJSON.
- The socket currently resolves to the normal
  `~/Library/Application Support/com.writer-computer/mcp.sock` even for an
  e2e-identifier build. Avoid running another Writer MCP instance concurrently.
- Assert both exact disk bytes and live sidebar/search/editor behavior.
  Sidebar refresh is asynchronous: wait for a concrete result with a deadline
  (e.g. 5 seconds), rather than judging a screenshot immediately after the call.
- Autosave makes dirty states short-lived. For a durable real dirty fixture,
  temporarily remove write permission from a disposable note's parent directory,
  type via UI, and verify disk still has old bytes. Restore permissions BEFORE
  MCP overwrite, then expect unsaved_conflict and unchanged visible user text.
  Always restore permissions in cleanup. Do not fake the dirty flag.
- A normal further UI edit can trigger autosave recovery after permissions return.
  Do not assume ordinary Markdown Cmd+S exists; verify the current shortcut path.

## Devin Secrets Needed

None for local desktop/MCP verification with disposable workspaces.
