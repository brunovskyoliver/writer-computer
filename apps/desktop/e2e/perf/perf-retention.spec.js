// WebContent retention rig (NOT a regression test).
// SPECs/Agent/worksheet-webcontent-retention.md: split post-close WebContent
// RSS into reclaimable pools vs live JS vs WebCore/graphics, attributed per
// feature. Unlike perf-audit (one big session then close), each feature is
// opened and closed in its own stage so its retained delta is measurable.
//
// Per snapshot the record carries:
//  - RSS per spawned WebKit child (baseline-diffed, as in perf-audit)
//  - parsed `footprint` category table for EVERY WebContent pid + the app
//    pid (dirty / clean / reclaimable per category — the audit's raw text
//    could not be diffed numerically)
//  - `__writerDebug()` in-page probe: store/cache counts + DOM canvas bytes
//  - at "deep" snapshots: raw `heap` and `vmmap -summary` for the tracked
//    app WebContent pid
// After each close, an in-page allocation churn nudges JSC through a GC so
// "post-gc" dirty approximates genuinely-live bytes; the gap between
// "-closed" and "-gc" is allocator/scavenger lag.
//
// Foreign WebContent processes spawn and die constantly on a live machine
// (browsers, Finder previews). The baseline diff alone cannot exclude ones
// born mid-run, so the app-owned webview pid is pinned at boot (the largest
// just-spawned WebContent) and tracked for headline numbers; every pid's
// footprint is still recorded so contamination stays visible in the data.
//
// Report → /tmp/writer-perf-retention.jsonl
// Requires /tmp/writer-perf-baseline.txt (WebKit PIDs before app launch)
// and the e2e data dir pointed at /tmp/writer-perf-ws.

import { execSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const WS = "/private/tmp/writer-perf-ws";
const REPORT = "/tmp/writer-perf-retention.jsonl";
const BASELINE = "/tmp/writer-perf-baseline.txt";

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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

function toMb(value, unit) {
  const n = Number(value);
  if (unit === "GB") return +(n * 1024).toFixed(1);
  if (unit === "MB") return +n.toFixed(1);
  if (unit === "KB") return +(n / 1024).toFixed(2);
  return +(n / 1024 / 1024).toFixed(3);
}

// Same attribution rule as perf-audit: WebKit children are the ones absent
// from the pre-launch baseline.
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

// footprint's summary table → { category: { dirty_mb, clean_mb, reclaim_mb } }.
// The audit kept the raw text; keeping the parsed map makes per-stage deltas
// computable from the JSONL alone.
function parseFootprint(pid) {
  let out = "";
  try {
    out = sh(`footprint -p ${pid} 2>/dev/null || true`);
  } catch {
    return null;
  }
  const cats = {};
  let footprintMb = null;
  let physMb = null;
  for (const line of out.split("\n")) {
    const header = line.match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB|B)/);
    if (header) footprintMb = toMb(header[1], header[2]);
    const phys = line.match(/phys_footprint:\s*([\d.]+)\s*(KB|MB|GB|B)/);
    if (phys) physMb = toMb(phys[1], phys[2]);
    const row = line.match(
      /^\s*([\d.]+)\s*(KB|MB|GB|B)\s+([\d.]+)\s*(KB|MB|GB|B)\s+([\d.]+)\s*(KB|MB|GB|B)\s+(\d+)\s+(.+?)\s*$/,
    );
    if (row) {
      // The TOTAL row would double-count every category into dirtyOf().
      const name = row[8];
      if (name === "TOTAL") continue;
      cats[name] = {
        dirty_mb: toMb(row[1], row[2]),
        clean_mb: toMb(row[3], row[4]),
        reclaim_mb: toMb(row[5], row[6]),
        regions: Number(row[7]),
      };
    }
  }
  return { pid, footprint_mb: footprintMb, phys_mb: physMb, cats };
}

function firstLines(cmd, n) {
  try {
    return sh(cmd).split("\n").slice(0, n).join("\n");
  } catch (e) {
    return `unavailable: ${String(e).slice(0, 200)}`;
  }
}

async function debugProbe() {
  return browser.execute(() => {
    window.__WRITER_E2E_DEBUG = true;
    return typeof window.__writerDebug === "function" ? window.__writerDebug() : "missing";
  });
}

// The app-owned WebContent pid, pinned at boot: the largest WebContent pid
// spawned since the baseline is the app's webview. Re-picked only if it
// dies (a webview crash-swap); foreign pids born mid-run are never adopted.
let appWebPid = null;

function trackWebPid(webContent) {
  if (webContent.some((p) => p.pid === appWebPid)) return appWebPid;
  const next = webContent.sort((a, b) => b.rss - a.rss)[0]?.pid ?? null;
  if (next !== appWebPid) {
    console.log(`[ret] tracking WebContent pid ${appWebPid} -> ${next}`);
    appWebPid = next;
  }
  return appWebPid;
}

// A WebKit RSS snapshot plus the parsed footprint of every spawned
// WebContent process (the audit footprinted only the first, which often was
// a small idle pid while the real UI process ballooned elsewhere).
async function snapshot(label, { deep = false } = {}) {
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
    debug: await debugProbe(),
  };
  const webContent = t.web_pids
    .filter((p) => !p.kind.includes("GPU") && !p.kind.includes("Networking"))
    .sort((a, b) => b.rss - a.rss);
  rec.fp_web = webContent.map((p) => parseFootprint(p.pid)).filter(Boolean);
  const tracked = trackWebPid(webContent);
  rec.app_web_pid = tracked;
  const appFp = t.app_pids[0] ? parseFootprint(t.app_pids[0]) : null;
  if (appFp) rec.fp_app = appFp;
  if (deep && tracked) {
    rec.heap_web = firstLines(`heap ${tracked} 2>/dev/null`, 60);
    rec.vmmap_web = firstLines(`vmmap -summary ${tracked} 2>/dev/null`, 55);
  }
  appendFileSync(REPORT, JSON.stringify(rec) + "\n");
  const main = rec.fp_web.find((f) => f.pid === tracked);
  console.log(
    `[ret] ${label}: app=${rec.app_mb}MB web=${rec.web_mb}MB ` +
      (main
        ? `fp=${main.footprint_mb}MB (pid ${main.pid}, dirty=${dirtyOf(main)}MB)`
        : "no-webcontent"),
  );
  return rec;
}

function dirtyOf(fp) {
  return Object.values(fp.cats)
    .reduce((sum, c) => sum + c.dirty_mb, 0)
    .toFixed(1);
}

function lastDebug(rec) {
  return rec.debug && rec.debug !== "missing" ? rec.debug : null;
}

// Pressure churn to push JSC through GC without holding the allocations:
// a rolling 2-block window of 8 MB buffers, ~96 MB of churn total. Freed
// bytes land in reclaimable pools, so post-nudge dirty ≈ live.
async function gcNudge(rounds = 12) {
  await browser.executeAsync((n, done) => {
    const keep = [];
    let i = 0;
    const step = () => {
      for (let k = 0; k < 3 && i < n; k++, i++) {
        const b = new Uint8Array(8 * 1024 * 1024);
        b.fill(i & 0xff);
        keep.push(b);
        if (keep.length > 2) keep.shift();
      }
      if (i < n) setTimeout(step, 15);
      else done(i);
    };
    step();
  }, rounds);
}

async function openTreeFile(path) {
  const sel = `[data-tree-path="${path}"]`;
  const row = await $(sel);
  await row.waitForExist({ timeout: 10_000 });
  await row.click();
}

async function closeAllTabs() {
  for (const btn of await $$('[aria-label^="Close "]')) {
    await btn.click().catch(() => {});
  }
}

async function pressKey(init) {
  await browser.execute((opts) => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { ...opts, bubbles: true, cancelable: true }),
    );
  }, init);
}

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

// open → measure → close → settle → nudge → measure. Every stage ends with
// only the launcher tab left, so each "X-gc" snapshot reads that feature's
// retained dirty on top of the previous stage's floor.
async function stage(name, exercise) {
  await exercise();
  await snapshot(`${name}-open`, { deep: true });
  await closeAllTabs();
  await browser.pause(2000);
  await snapshot(`${name}-closed`);
  await gcNudge();
  await browser.pause(2500);
  await snapshot(`${name}-gc`, { deep: true });
}

describe("webcontent retention bisect", function () {
  this.timeout(600_000);

  before(async function () {
    writeFileSync(REPORT, "");
    const sidebar = await $('button[aria-label="Hide sidebar"]');
    await sidebar.waitForExist({ timeout: 30_000 });
    await browser.pause(2500);
    await snapshot("boot", { deep: true });
  });

  it("markdown tabs", async function () {
    await stage("md", async () => {
      for (let i = 1; i <= 20; i++) {
        await openTreeFile(`${WS}/note-${String(i).padStart(2, "0")}.md`);
      }
      await browser.pause(800);
    });
  });

  it("large doc + keystrokes", async function () {
    await stage("large", async () => {
      await openTreeFile(`${WS}/large-01.md`);
      await browser.waitUntil(
        async () =>
          browser.execute(() => {
            const cs = [...document.querySelectorAll(".cm-content")].filter(
              (c) => c.offsetParent !== null,
            );
            return cs.some((c) => c.closest("[data-tab-host]"));
          }),
        { timeout: 60_000, timeoutMsg: "large doc never mounted" },
      );
      await browser.executeAsync(async (n, done) => {
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
        for (let i = 0; i < n; i++) {
          document.execCommand("insertText", false, "x");
          await tick();
        }
        done({});
      }, 200);
      await browser.pause(1500); // debounced stats + autosave settle
    });
  });

  it("pdfs", async function () {
    await stage("pdf", async () => {
      await openTreeFile(`${WS}/report-40p.pdf`);
      await browser.waitUntil(
        async () => {
          const s = await visiblePdfScroller();
          return s && s.sh > s.ch * 2;
        },
        { timeout: 30_000, timeoutMsg: "pdf-40 never laid out" },
      );
      await scrollVisiblePdf(true);
      await scrollVisiblePdf(false);

      await openTreeFile(`${WS}/manual-200p.pdf`);
      await browser.waitUntil(
        async () => {
          const s = await visiblePdfScroller();
          return s && s.sh > s.ch * 10;
        },
        { timeout: 60_000, timeoutMsg: "pdf-200 never laid out" },
      );
      await scrollVisiblePdf(true);
      await scrollVisiblePdf(false);
    });

    // The pdf.js worker now idles out WORKER_IDLE_MS after the last
    // release — verify it actually dies and what that returns.
    const before = await snapshot("pdf-pre-idle");
    console.log(`[ret] workerAlive before idle: ${lastDebug(before)?.pdf?.workerAlive}`);
    await browser.pause(32_000);
    const after = await snapshot("pdf-idle", { deep: true });
    console.log(`[ret] workerAlive after idle: ${lastDebug(after)?.pdf?.workerAlive}`);
  });

  it("excalidraw", async function () {
    await stage("draw", async () => {
      await openTreeFile(`${WS}/sketch.excalidraw.svg`);
      await browser
        .waitUntil(
          async () =>
            browser.execute(() => {
              const el = [...document.querySelectorAll(".excalidraw")].find(
                (e) => e.offsetParent !== null,
              );
              if (el) return true;
              return document.body.textContent.includes("could not be opened") ? true : false;
            }),
          { timeout: 90_000, timeoutMsg: "excalidraw neither mounted nor errored" },
        )
        .catch(() => {});
      await browser.pause(2500);
    });
  });

  it("graph", async function () {
    // The pane renders a hint instead of the canvas when ai.enabled is off,
    // so the lazy force-graph chunk would never load — enable it first.
    await browser.executeAsync((done) => {
      window.__TAURI_INTERNALS__
        .invoke("set_setting", { key: "ai.enabled", value: true, scope: "global" })
        .then(() => done(true))
        .catch((e) => done(String(e)));
    });
    await stage("graph", async () => {
      await pressKey({ key: "P", metaKey: true });
      const item = await $('[cmdk-item][data-value="open-graph"]');
      await item.waitForExist({ timeout: 5_000 });
      await item.click();
      await browser.pause(3000); // force sim warmup ticks
    });
  });

  it("settles after everything", async function () {
    // Long-tail check: WebKit's scavenger returns free pages over tens of
    // seconds. If dirty is still high at +30 s, it is not scavenger lag.
    await gcNudge();
    await browser.pause(30_000);
    const rec = await snapshot("final-settle", { deep: true });
    const mainPid = rec.app_web_pid;
    if (mainPid) {
      const leaks = firstLines(`leaks ${mainPid} 2>&1 | head -40`, 40);
      appendFileSync(REPORT, JSON.stringify({ label: "leaks", pid: mainPid, leaks }) + "\n");
      console.log(`[ret] leaks:\n${leaks}`);
    }
  });
});
