import { ok } from "node:assert/strict";

// Colour-highlight verification (SPECs/formula-highlight-colors, US1): seeds a
// display-math document, unfolds the math, selects a fragment, and asserts the
// selection-anchored bar appears, a swatch press writes `\textcolor{#rrggbb}`
// into the file, and the wrapper conceals again once the caret leaves the
// highlight.
//
// Requires a restorable workspace (see latex-math.spec.js); self-skips on the
// welcome screen.
describe("formula highlight", function () {
  const FILE_STEM = "highlight-e2e";
  const DOC = ["# Highlight check", "", "$$a+b$$", "", "tail", ""].join("\n");

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

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;

    const recents = await invoke("get_recent_workspaces", {});
    const root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root to seed the highlight document into");

    filePath = `${root}/${FILE_STEM}.md`;
    const wrote = await invoke("write_file", { path: filePath, content: DOC });
    ok(wrote.ok, `failed to seed ${filePath}: ${wrote.error}`);

    await browser.execute(() => window.location.reload());
    await $('[data-sidebar-surface][data-workspace-open="true"]').waitForExist({
      timeout: 20_000,
    });
  });

  beforeEach(function () {
    if (!workspaceRestored) this.skip();
  });

  after(async function () {
    if (filePath) await invoke("delete_entry", { path: filePath });
  });

  it("opens the seeded document and unfolds the math", async function () {
    const row = await $(`span*=Highlight check`);
    await row.waitForExist({ timeout: 15_000 });
    await row.click();
    await browser.waitUntil(async () => (await $$(".cm-content")).length > 0, {
      timeout: 10_000,
      timeoutMsg: "editor never mounted",
    });

    // Caret into the formula: select all, collapse to start, down to the
    // `$$a+b$$` line, then right past the opening `$$`. Entering the math
    // range unfolds it to source.
    await $(".cm-content").click();
    await browser.keys(["Meta", "a"]);
    await browser.keys(["ArrowLeft"]);
    for (let i = 0; i < 10; i++) {
      const line = await browser.execute(() => {
        const node = document.getSelection()?.anchorNode;
        const el = node?.nodeType === 1 ? node : node?.parentElement;
        return el?.closest(".cm-line")?.textContent ?? null;
      });
      if (line && line.includes("$$")) break;
      await browser.keys(["ArrowDown"]);
    }
    await browser.keys(["Meta", "ArrowLeft"]);
    await browser.keys(["ArrowRight"]);
    await browser.keys(["ArrowRight"]);
    await browser.waitUntil(async () => (await $(".cm-content").getText()).includes("$$a+b$$"), {
      timeout: 5_000,
      timeoutMsg: "display math never unfolded to source",
    });
  });

  it("shows the colour bar over a math selection and writes \\textcolor on press", async function () {
    // Caret is just inside the formula; shift+right three times selects `a+b`.
    await browser.keys(["Shift", "ArrowRight"]);
    await browser.keys(["Shift", "ArrowRight"]);
    await browser.keys(["Shift", "ArrowRight"]);

    const bar = await $(".highlight-bar");
    await bar.waitForExist({ timeout: 10_000 });
    ok(await bar.isDisplayed(), "highlight bar not visible");

    const swatch = await $('button[aria-label="Highlight Amber"]');
    await swatch.click();

    await browser.waitUntil(
      async () => (await $(".cm-content").getText()).includes("\\textcolor{#e0a000}{a+b}"),
      { timeout: 5_000, timeoutMsg: "\\textcolor never appeared in the source" },
    );

    // Persist and confirm the exact form reached the file.
    await browser.keys(["Meta", "s"]);
    await browser.waitUntil(
      async () => {
        const res = await invoke("read_file", { path: filePath });
        return res.ok && res.value.includes("$$\\textcolor{#e0a000}{a+b}$$");
      },
      { timeout: 10_000, timeoutMsg: "written file never contained the highlight" },
    );

    if (process.env.VERIFY_SHOT_DIR) {
      await browser.saveScreenshot(`${process.env.VERIFY_SHOT_DIR}/highlight-applied.png`);
    }
  });

  it("conceals the wrapper markup once the caret leaves the highlight", async function () {
    // The selection sits on the inner text right after the write, so the
    // markup is revealed. Arrow past the closing `}` to leave it.
    for (let i = 0; i < 8; i++) await browser.keys(["ArrowRight"]);

    await browser.waitUntil(
      async () => {
        const text = await $(".cm-content").getText();
        return text.includes("a+b") && !text.includes("\\textcolor{#e0a000}{a+b}");
      },
      { timeout: 5_000, timeoutMsg: "wrapper markup never concealed" },
    );
  });
});
