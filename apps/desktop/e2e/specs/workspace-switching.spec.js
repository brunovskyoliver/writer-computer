import { ok } from "node:assert/strict";

// Several workspaces, switched in one window or kept in separate windows
// (SPECs/workspace-switching-spec.md): seeds a second workspace beside the
// restored one, then
//   - "Switch Workspace: …" in the palette shows it in this window, and
//     switching back restores the first workspace with its open tab
//   - opening a workspace in a new window gives it its own window
//   - switching to a workspace another window already has focuses that
//     window instead of replacing this one
//
// Requires a restorable workspace (recent_workspaces.json). The second
// workspace is created beside it and removed afterwards.
describe("Switching between workspaces", function () {
  let workspaceRestored = false;
  let first = null;
  let second = null;

  async function invoke(cmd, args) {
    return browser.executeAsync(
      (c, a, done) => {
        window.__TAURI_INTERNALS__
          .invoke(c, a)
          .then((v) => done({ ok: true, value: v }))
          .catch((e) => done({ ok: false, error: e && e.message ? e.message : String(e) }));
      },
      cmd,
      args,
    );
  }

  function switcherLabel() {
    return browser.execute(
      () => document.querySelector('[aria-label="Switch workspace"]')?.textContent?.trim() ?? null,
    );
  }

  function folderName(path) {
    return path.split("/").filter(Boolean).pop();
  }

  async function runPaletteCommand(value) {
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    const item = await $(`[cmdk-item][data-value="${value}"]`);
    await item.waitForExist({ timeout: 5_000, timeoutMsg: `palette has no ${value}` });
    await item.click();
  }

  async function windows() {
    const result = await invoke("workspace_windows", {});
    ok(result.ok, `workspace_windows failed: ${result.error}`);
    return result.value;
  }

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;

    const recents = await invoke("get_recent_workspaces", {});
    first = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(first, "no restored workspace");
    second = `${first}-second`;
    const made = await invoke("create_directory", { path: second });
    ok(made.ok || /exists/i.test(made.error ?? ""), `could not create ${second}: ${made.error}`);
    for (const [path, content] of [
      [`${first}/first-note.md`, "# First workspace note\n"],
      [`${second}/second-note.md`, "# Second workspace note\n"],
    ]) {
      const wrote = await invoke("write_file", { path, content });
      ok(wrote.ok, `failed to seed ${path}: ${wrote.error}`);
    }

    // Make the second workspace a known one: open it in a window once and
    // close that window again, the way a user would have used it before.
    await browser.execute(() => window.location.reload());
    await $('[data-sidebar-surface][data-workspace-open="true"]').waitForExist({
      timeout: 20_000,
    });
    const opened = await invoke("open_workspace_in_new_window", { path: second, file: null });
    ok(opened.ok, `could not open ${second}: ${opened.error}`);
    await browser.waitUntil(async () => (await windows()).length === 2, {
      timeout: 15_000,
      timeoutMsg: "the second workspace's window never registered",
    });
  });

  beforeEach(function () {
    if (!workspaceRestored) this.skip();
  });

  after(async function () {
    if (!workspaceRestored) return;
    await invoke("remove_recent_workspace", { path: second }).catch(() => {});
    await invoke("delete_entry", { path: `${first}/first-note.md` }).catch(() => {});
  });

  it("focuses the window that already has a workspace instead of replacing this one", async function () {
    const all = await windows();
    const secondRoot = all.find((w) => !w.current)?.root;
    ok(secondRoot, "no second window");
    const focused = await invoke("focus_workspace_window", { path: secondRoot });
    ok(focused.ok && focused.value === true, "the other window was not focused");
    // This window still shows its own workspace.
    ok((await switcherLabel()) === folderName(first), "this window's workspace changed");
  });

  it("lists the other workspace in the palette and switches this window to it", async function () {
    // Close the second window's workspace so the switch happens here.
    const handles = await browser.getWindowHandles();
    const mine = await browser.getWindowHandle();
    for (const handle of handles) {
      if (handle === mine) continue;
      await browser.switchToWindow(handle);
      await browser.closeWindow();
    }
    await browser.switchToWindow(mine);
    await browser.waitUntil(async () => (await windows()).length === 1, {
      timeout: 10_000,
      timeoutMsg: "the second window did not close",
    });

    // Leave a tab open here so the switch back can prove the session returns.
    const row = await $("span*=First workspace note");
    await row.waitForExist({ timeout: 10_000 });
    await row.click();

    const recents = await invoke("get_recent_workspaces", {});
    const secondRoot = recents.value.find((path) => path.endsWith("-second"));
    ok(secondRoot, `the second workspace is not a recent one: ${JSON.stringify(recents.value)}`);

    await runPaletteCommand(`switch-workspace:${secondRoot}`);
    await browser.waitUntil(async () => (await switcherLabel()) === folderName(secondRoot), {
      timeout: 10_000,
      timeoutMsg: "the window did not switch to the second workspace",
    });
    await $("span*=Second workspace note").waitForExist({ timeout: 10_000 });
    ok((await windows()).length === 1, "switching opened another window");

    const back = recents.value.find((path) => !path.endsWith("-second"));
    await runPaletteCommand(`switch-workspace:${back}`);
    await browser.waitUntil(async () => (await switcherLabel()) === folderName(back), {
      timeout: 10_000,
      timeoutMsg: "the window did not switch back",
    });
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          [...document.querySelectorAll(".cm-line")].some((line) =>
            line.textContent?.includes("First workspace note"),
          ),
        ),
      { timeout: 10_000, timeoutMsg: "the first workspace's open note did not come back" },
    );
  });
});
