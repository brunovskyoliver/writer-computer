// Bisect the app-process Malloc Large jump: palette open vs graph tab.
import { execSync } from "node:child_process";

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8" });
}

function appFootprint() {
  const rows = sh("ps -axo pid=,rss=,command=").split("\n");
  const appPid = rows
    .find((l) => l.includes("target/release/bundle/macos/Writer.app"))
    ?.trim()
    .split(/\s+/)[0];
  const rss = Number(
    rows
      .find((l) => l.includes("target/release/bundle/macos/Writer.app"))
      ?.trim()
      .split(/\s+/)[1],
  );
  let fp = { large: "", small: "", total: "" };
  if (appPid) {
    const out = sh(`footprint -p ${appPid} 2>/dev/null || true`);
    for (const line of out.split("\n")) {
      if (line.includes("Footprint:")) fp.total = line.trim();
      if (line.includes("Malloc Large")) fp.large = line.trim();
      if (line.includes("Malloc Small")) fp.small = line.trim();
    }
  }
  return { appPid, rss_mb: (rss / 1024).toFixed(1), ...fp };
}

function snap(label) {
  const f = appFootprint();
  console.log(`[bisect] ${label}: rss=${f.rss_mb}MB | ${f.total} | ${f.large} | ${f.small}`);
}

async function pressKey(init) {
  await browser.execute((opts) => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { ...opts, bubbles: true, cancelable: true }),
    );
  }, init);
}

describe("graph bisect", function () {
  this.timeout(120_000);

  before(async function () {
    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 30_000 });
    await browser.pause(1500);
    snap("boot");
  });

  it("isolates palette vs graph", async function () {
    await pressKey({ key: "P", metaKey: true });
    await browser.pause(800);
    snap("palette-open");

    const item = await $('[cmdk-item][data-value="open-graph"]');
    const exists = await item.isExisting();
    console.log(`[bisect] open-graph item exists: ${exists}`);
    if (exists) {
      await item.click();
      await browser.pause(1500);
      snap("graph-1.5s");
      await browser.pause(3000);
      snap("graph-4.5s");
    }

    // Check ai.enabled setting actually read at runtime.
    const ai = await browser.executeAsync((done) => {
      window.__TAURI_INTERNALS__
        .invoke("ai_status")
        .then((r) => done(r))
        .catch((e) => done(String(e)));
    });
    console.log(`[bisect] ai_status: ${JSON.stringify(ai)}`);

    // Close all tabs.
    for (const btn of await $$('[aria-label^="Close "]')) {
      await btn.click().catch(() => {});
    }
    await browser.pause(2000);
    snap("closed");
  });
});
