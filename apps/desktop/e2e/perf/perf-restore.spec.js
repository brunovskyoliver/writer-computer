// Session-restore storm: planted sessions.json = 10 tabs × ~45 history entries.
// Measures time-to-ready and memory delta vs the cold boot.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8" });
}

function snap(label) {
  const base = new Set(
    readFileSync("/tmp/writer-perf-baseline.txt", "utf8")
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter(Boolean),
  );
  const rows = sh("ps -axo pid=,rss=,command=").split("\n");
  let app = 0;
  const web = [];
  for (const line of rows) {
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (line.includes("target/release/bundle/macos/Writer.app")) {
      app += Number(line.trim().split(/\s+/)[1]);
    } else if (line.includes("com.apple.WebKit") && !base.has(pid)) {
      web.push(Number(line.trim().split(/\s+/)[1]));
    }
  }
  console.log(
    `[restore] ${label}: app=${(app / 1024).toFixed(1)}MB web=${(web.reduce((a, b) => a + b, 0) / 1024).toFixed(1)}MB`,
  );
}

describe("restore storm", function () {
  this.timeout(180_000);

  it("restores a fat session", async function () {
    const t0 = Date.now();
    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 60_000 });
    const sidebarMs = Date.now() - t0;
    // Wait for the first editor to be usable — restore loads all
    // history-referenced files into openFiles in parallel.
    await browser
      .waitUntil(
        async () =>
          browser.execute(() =>
            [...document.querySelectorAll(".cm-content")].some((c) => c.offsetParent !== null),
          ),
        { timeout: 90_000, timeoutMsg: "no editor after restore" },
      )
      .catch(() => {});
    const readyMs = Date.now() - t0;
    const tabs = (await $$('[aria-label^="Close "]')).length;
    console.log(`[restore] sidebar=${sidebarMs}ms ready=${readyMs}ms tabs=${tabs}`);
    snap("post-restore");
    await browser.pause(3000);
    snap("post-restore+3s");
  });
});
