// Read-only performance/memory audit driver (NOT a regression test).
// Measures RSS of the Rust process + spawned WebKit children across
// scenarios: tab scaling, large-file typing, PDF, Excalidraw, graph,
// content search, tab teardown. Report → /tmp/writer-perf-report.jsonl
//
// Requires /tmp/writer-perf-baseline.txt (WebKit PIDs before app launch)
// and the e2e data dir pointed at /tmp/writer-perf-ws.

import { execSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const WS = "/private/tmp/writer-perf-ws";
const REPORT = "/tmp/writer-perf-report.jsonl";
const BASELINE = "/tmp/writer-perf-baseline.txt";

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8" });
}

function baselinePids() {
  try {
    return new Set(
      readFileSync(BASELINE, "utf8")
        .split("\n")
        .map((s) => Number(s.trim()))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

// RSS (MB) per process class. WebKit children are attributed by diffing
// against the pre-launch baseline — the e2e app spawns 1 WebContent + 1 GPU
// + 1 Networking process.
function processTable() {
  const base = baselinePids();
  const rows = sh("ps -axo pid=,rss=,command=").split("\n");
  const t = { app_kb: 0, web_kb: 0, gpu_kb: 0, net_kb: 0, web_pids: [], app_pids: [] };
  for (const line of rows) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const rss = Number(m[2]);
    const comm = m[3];
    if (comm.includes("target/release/bundle/macos/Writer.app")) {
      t.app_kb += rss;
      t.app_pids.push(pid);
    } else if (comm.includes("com.apple.WebKit") && !base.has(pid)) {
      t.web_pids.push({ pid, kind: comm, rss });
      if (comm.includes("GPU")) t.gpu_kb += rss;
      else if (comm.includes("Networking")) t.net_kb += rss;
      else t.web_kb += rss;
    }
  }
  return t;
}

function snapshot(label, footprint = false) {
  const t = processTable();
  const rec = {
    label,
    at: new Date().toISOString(),
    app_mb: +(t.app_kb / 1024).toFixed(1),
    web_mb: +(t.web_kb / 1024).toFixed(1),
    gpu_mb: +(t.gpu_kb / 1024).toFixed(1),
    net_mb: +(t.net_kb / 1024).toFixed(1),
    total_mb: +((t.app_kb + t.web_kb + t.gpu_kb + t.net_kb) / 1024).toFixed(1),
    webkit_children: t.web_pids.map((p) => `${p.pid}:${p.rss}k`),
  };
  if (footprint) {
    const webPid = t.web_pids.find(
      (p) => !p.kind.includes("GPU") && !p.kind.includes("Networking"),
    )?.pid;
    for (const [name, pid] of [
      ["app", t.app_pids[0]],
      ["web", webPid],
    ]) {
      if (!pid) continue;
      try {
        const out = sh(`footprint -p ${pid} 2>/dev/null || true`);
        rec[`fp_${name}`] = out.split("\n").slice(0, 45).join("\n");
      } catch {}
    }
  }
  appendFileSync(REPORT, JSON.stringify(rec) + "\n");
  console.log(
    `[perf] ${label}: app=${rec.app_mb}MB web=${rec.web_mb}MB gpu=${rec.gpu_mb}MB net=${rec.net_mb}MB total=${rec.total_mb}MB`,
  );
  for (const key of ["fp_app", "fp_web"]) {
    if (!rec[key]) continue;
    const cat = rec[key]
      .split("\n")
      .filter((l) => /^\s+\d+(\.\d+)?\s+(KB|MB|GB|B)\s/.test(l))
      .slice(0, 10);
    console.log(`[perf] ${label} ${key}:\n${cat.join("\n")}`);
  }
  return rec;
}

function invoke(cmd, args = {}) {
  return browser.executeAsync(
    (c, a, done) => {
      const t0 = performance.now();
      window.__TAURI_INTERNALS__
        .invoke(c, a)
        .then((r) =>
          done({ ms: performance.now() - t0, ok: true, size: JSON.stringify(r)?.length }),
        )
        .catch((e) => done({ ms: performance.now() - t0, ok: false, err: String(e) }));
    },
    cmd,
    args,
  );
}

async function timedInvoke(label, cmd, args) {
  const r = await invoke(cmd, args);
  appendFileSync(REPORT, JSON.stringify({ label, ipc: cmd, ...r }) + "\n");
  console.log(`[perf] ${label}: ${cmd} ${r.ms.toFixed(1)}ms ok=${r.ok}${r.err ? " " + r.err : ""}`);
  return r;
}

async function openTreeFile(path) {
  const sel = `[data-tree-path="${path}"]`;
  const row = await $(sel);
  await row.waitForExist({ timeout: 10_000 });
  const t0 = Date.now();
  await row.click();
  return t0;
}

async function tabCount() {
  return (await $$('[aria-label^="Close "]')).length;
}

// The real PDF scroller is the visible `overflow-auto` div with the largest
// scrollHeight (a second `h-full min-h-0` wrapper also contains canvases).
// Page code is inlined — the page CSP forbids eval.
async function visiblePdfScroller() {
  return browser.execute(() => {
    const ds = [...document.querySelectorAll("div.overflow-auto")].filter(
      (el) => el.offsetParent !== null && el.querySelector("canvas"),
    );
    const d = ds.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] ?? null;
    return d ? { sh: d.scrollHeight, ch: d.clientHeight, st: d.scrollTop } : null;
  });
}

async function scrollVisiblePdf(toBottom) {
  return browser.executeAsync((bottom, done) => {
    const ds = [...document.querySelectorAll("div.overflow-auto")].filter(
      (el) => el.offsetParent !== null && el.querySelector("canvas"),
    );
    const d = ds.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] ?? null;
    if (!d) return done(null);
    d.scrollTop = bottom ? d.scrollHeight : 0;
    setTimeout(() => done({ sh: d.scrollHeight, ch: d.clientHeight, st: d.scrollTop }), 1000);
  }, toBottom);
}

async function pressKey(init) {
  await browser.execute((opts) => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { ...opts, bubbles: true, cancelable: true }),
    );
  }, init);
}

describe("perf audit", function () {
  this.timeout(420_000);

  before(async function () {
    writeFileSync(REPORT, "");
    const sidebar = await $('button[aria-label="Hide sidebar"]');
    await sidebar.waitForExist({ timeout: 30_000 });
    await browser.pause(2500); // let startup settle
    snapshot("s0-boot", true);
  });

  it("measures IPC latency on the workspace", async function () {
    await timedInvoke("ipc-read-directory", "read_directory", { path: WS });
    await timedInvoke("ipc-read-recent-100", "read_recent_files", { limit: 100, offset: 0 });
    await timedInvoke("ipc-read-small", "read_file", { path: `${WS}/note-01.md` });
    await timedInvoke("ipc-read-medium", "read_file", { path: `${WS}/medium-01.md` });
    await timedInvoke("ipc-read-large", "read_file", { path: `${WS}/large-01.md` });
    await timedInvoke("ipc-fuzzy", "fuzzy_search", { query: "note", limit: 20 });
    // Parallel reads — stands in for the restoreSession preload burst.
    const r = await browser.executeAsync((root, done) => {
      const paths = Array.from(
        { length: 40 },
        (_, i) => `${root}/note-${String(i + 1).padStart(2, "0")}.md`,
      );
      const t0 = performance.now();
      void Promise.all(
        paths.map((p) =>
          window.__TAURI_INTERNALS__.invoke("read_file", { path: p }).catch(() => null),
        ),
      ).then(() => done(performance.now() - t0));
    }, WS);
    console.log(`[perf] ipc-40-parallel-reads: ${r.toFixed(1)}ms`);
    appendFileSync(REPORT, JSON.stringify({ label: "ipc-40-parallel-reads", ms: r }) + "\n");
  });

  it("scales tabs: 5 → 20 small files", async function () {
    for (let i = 1; i <= 5; i++) await openTreeFile(`${WS}/note-${String(i).padStart(2, "0")}.md`);
    await browser.pause(800);
    snapshot("s1-5-tabs");
    for (let i = 6; i <= 20; i++) await openTreeFile(`${WS}/note-${String(i).padStart(2, "0")}.md`);
    await browser.pause(800);
    snapshot("s2-20-tabs");
    console.log(`[perf] tabs open: ${await tabCount()}`);
  });

  it("opens medium + large markdown", async function () {
    let t0 = await openTreeFile(`${WS}/medium-01.md`);
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          [...document.querySelectorAll(".cm-content")].some((c) => c.offsetParent !== null),
        ),
      { timeout: 20_000 },
    );
    console.log(`[perf] medium open latency: ${Date.now() - t0}ms`);
    snapshot("s3-medium");

    t0 = await openTreeFile(`${WS}/large-01.md`);
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          // A fresh large-doc tab shows a loading state before CM mounts; the
          // visible .cm-content belonging to the active tab signals ready.
          const cs = [...document.querySelectorAll(".cm-content")].filter(
            (c) => c.offsetParent !== null,
          );
          return cs.some((c) => c.closest("[data-tab-host]"));
        }),
      { timeout: 60_000, timeoutMsg: "large doc never mounted" },
    );
    await browser.pause(1200);
    console.log(`[perf] large open latency: ${Date.now() - t0}ms`);
    snapshot("s4-large", true);
  });

  it("measures per-keystroke cost in the large doc", async function () {
    // Unclamped macrotask yield between inserts (MessageChannel avoids the
    // 4ms nested-setTimeout clamp) — lets CM observers + store work run.
    const r = await browser.executeAsync(async (n, done) => {
      const el = [...document.querySelectorAll(".cm-content[contenteditable]")].find(
        (c) => c.offsetParent !== null,
      );
      if (!el) return done({ err: "no editor" });
      el.focus();
      const mc = new MessageChannel();
      const tick = () =>
        new Promise((res) => {
          mc.port1.onmessage = res;
          mc.port2.postMessage(0);
        });
      let inserted = 0;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        if (document.execCommand("insertText", false, "x")) inserted++;
        await tick();
      }
      done({ ms: performance.now() - t0, inserted, n });
    }, 200);
    console.log(`[perf] 200 keystrokes large doc: ${JSON.stringify(r)}`);
    appendFileSync(REPORT, JSON.stringify({ label: "keystroke-large", ...r }) + "\n");
    await browser.pause(1500); // debounced stats + autosave settle
    snapshot("s5-after-typing", true);
  });

  it("opens the 40-page PDF, scrolls it, opens the 200-page PDF", async function () {
    const t0 = await openTreeFile(`${WS}/report-40p.pdf`);
    await browser.waitUntil(async () => (await visiblePdfScroller()) !== null, {
      timeout: 30_000,
      timeoutMsg: "pdf scroller never appeared",
    });
    console.log(`[perf] pdf-40 open latency: ${Date.now() - t0}ms`);
    await browser.waitUntil(
      async () => {
        const s = await visiblePdfScroller();
        return s && s.sh > s.ch * 2;
      },
      { timeout: 30_000, timeoutMsg: "pdf never laid out" },
    );
    snapshot("s6-pdf40");
    console.log(`[perf] pdf40 bottom: ${JSON.stringify(await scrollVisiblePdf(true))}`);
    console.log(`[perf] pdf40 top: ${JSON.stringify(await scrollVisiblePdf(false))}`);
    snapshot("s7-pdf40-scrolled");

    const t1 = await openTreeFile(`${WS}/manual-200p.pdf`);
    await browser.waitUntil(
      async () => {
        const s = await visiblePdfScroller();
        return s && s.sh > s.ch * 10;
      },
      { timeout: 60_000, timeoutMsg: "pdf-200 never laid out" },
    );
    console.log(`[perf] pdf-200 open latency: ${Date.now() - t1}ms`);
    console.log(`[perf] pdf200 bottom: ${JSON.stringify(await scrollVisiblePdf(true))}`);
    await scrollVisiblePdf(false);
    snapshot("s8-pdf200-scrolled", true);
  });

  it("opens the Excalidraw fixture", async function () {
    const t0 = await openTreeFile(`${WS}/sketch.excalidraw.svg`);
    const outcome = await browser
      .waitUntil(
        async () =>
          browser.execute(() => {
            const el = [...document.querySelectorAll(".excalidraw")].find(
              (e) => e.offsetParent !== null,
            );
            if (el) return "mounted";
            const err = document.body.textContent.includes("could not be opened");
            return err ? "error" : false;
          }),
        { timeout: 90_000, timeoutMsg: "excalidraw neither mounted nor errored" },
      )
      .catch((e) => e.message);
    await browser.pause(2500);
    console.log(`[perf] excalidraw: ${JSON.stringify(outcome)} in ${Date.now() - t0}ms`);
    snapshot("s9-excalidraw", true);
  });

  it("opens the graph tab", async function () {
    await pressKey({ key: "P", metaKey: true });
    const item = await $('[cmdk-item][data-value="open-graph"]');
    await item.waitForExist({ timeout: 5_000 });
    const t0 = Date.now();
    await item.click();
    await browser.pause(3000); // force sim warmup ticks
    console.log(`[perf] graph open: ${Date.now() - t0}ms, tabs=${await tabCount()}`);
    snapshot("s10-graph", true);
  });

  it("runs content search over markdown + PDFs", async function () {
    await pressKey({ key: "F", metaKey: true, shiftKey: true });
    const input = await $('[cmdk-input][placeholder="Search in files (including PDFs)..."]');
    await input.waitForExist({ timeout: 5_000 });
    const t0 = Date.now();
    await input.addValue("lorem");
    // "Searching..." heading marks a live scan; poll until it clears.
    await browser.waitUntil(
      async () => {
        const heading = await $("[cmdk-group-heading]");
        if (!(await heading.isExisting())) return Date.now() - t0 > 4000;
        return (await heading.getText()) !== "Searching...";
      },
      { timeout: 60_000, timeoutMsg: "content search never settled" },
    );
    const settled = Date.now() - t0;
    const items = (await $$("[cmdk-item]")).length;
    console.log(`[perf] content search 'lorem': ${settled}ms, ${items} items`);
    appendFileSync(REPORT, JSON.stringify({ label: "search-lorem", ms: settled, items }) + "\n");
    snapshot("s11-search");
    await pressKey({ key: "Escape" });
  });

  it("closes every tab and watches reclamation", async function () {
    const before = await tabCount();
    for (const btn of await $$('[aria-label^="Close "]')) {
      await btn.click().catch(() => {});
    }
    await browser.pause(2000);
    console.log(`[perf] closed ${before} tabs, remaining=${await tabCount()}`);
    snapshot("s12-closed-2s");
    await browser.pause(8000);
    snapshot("s13-closed-10s", true);
  });
});
