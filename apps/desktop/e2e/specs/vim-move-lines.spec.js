import { ok } from "node:assert/strict";

// Vim visual-mode `J` / `K` move the selected lines (the user's Neovim
// `vnoremap J :m '>+1<CR>gv` / `K :m '<-2<CR>gv`): select two lines with `V`,
// move them down twice and up once, and check the selection travelled with
// them by deleting it.
//
// Requires a restorable workspace, like the other editor specs. Self-skips on
// the welcome screen.
describe("Vim visual J / K move lines", function () {
  const DOC = ["# Move lines", "", "alpha", "beta", "gamma", "delta", ""].join("\n");
  const FILE_STEM = "vim-move-lines-e2e";

  let workspaceRestored = false;
  let filePath = null;

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

  function body() {
    return browser.execute(() =>
      [...document.querySelectorAll(".cm-line")]
        .map((line) => line.textContent)
        .filter((text) => ["alpha", "beta", "gamma", "delta"].includes(text)),
    );
  }

  /** Synthetic keydown on the visible editor — the Vim plugin reads keydown. */
  async function press(key, mods = {}) {
    await browser.execute(
      (pressedKey, m) => {
        const target = [...document.querySelectorAll(".cm-content")].find(
          (el) => el.offsetParent !== null,
        );
        target?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: pressedKey,
            shiftKey: Boolean(m.shift),
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      key,
      mods,
    );
  }

  async function expectBody(expected, message) {
    await browser.waitUntil(async () => JSON.stringify(await body()) === JSON.stringify(expected), {
      timeout: 5_000,
      timeoutMsg: `${message}: ${JSON.stringify(await body())}`,
    });
  }

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;

    const recents = await invoke("get_recent_workspaces", {});
    const root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root to seed into");
    filePath = `${root}/${FILE_STEM}.md`;
    const wrote = await invoke("write_file", { path: filePath, content: DOC });
    ok(wrote.ok, `failed to seed ${filePath}: ${wrote.error}`);

    await browser.execute(() => window.location.reload());
    await $('[data-sidebar-surface][data-workspace-open="true"]').waitForExist({
      timeout: 20_000,
    });
    const row = await $("span*=Move lines");
    await row.waitForExist({ timeout: 15_000 });
    await row.click();
    await browser.waitUntil(async () => (await body()).length === 4, {
      timeout: 10_000,
      timeoutMsg: "the seeded note never opened",
    });
    await invoke("set_setting", { key: "editor.vim-mode", value: true, scope: "global" });
    await $('[data-vim-mode="NORMAL"]').waitForExist({ timeout: 10_000 });
  });

  beforeEach(function () {
    if (!workspaceRestored) this.skip();
  });

  after(async function () {
    if (!workspaceRestored) return;
    await invoke("set_setting", { key: "editor.vim-mode", value: false, scope: "global" }).catch(
      () => {},
    );
    if (filePath) await invoke("delete_entry", { path: filePath }).catch(() => {});
  });

  it("moves a V-LINE selection with J and K and keeps it selected", async function () {
    await press("g");
    await press("g"); // first line
    await press("j");
    await press("j"); // "alpha"
    await press("V", { shift: true });
    await press("j"); // "alpha" + "beta"
    await $('[data-vim-mode="V-LINE"]').waitForExist({ timeout: 5_000 });

    await press("J", { shift: true });
    await expectBody(["gamma", "alpha", "beta", "delta"], "J did not move the lines down");
    await press("J", { shift: true });
    await expectBody(["gamma", "delta", "alpha", "beta"], "a second J did not move again");
    await press("K", { shift: true });
    await expectBody(["gamma", "alpha", "beta", "delta"], "K did not move the lines up");

    ok(
      await $('[data-vim-mode="V-LINE"]').isExisting(),
      "moving the lines dropped the visual selection",
    );
    // The selection moved with the lines: deleting it removes exactly them.
    await press("d");
    await expectBody(["gamma", "delta"], "the selection did not follow the moved lines");
  });
});
