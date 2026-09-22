import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// AI note-relations verification (SPECs/ai-note-graph/quickstart.md §§2–4).
// Drives the seeded ~/obsidian/SDU workspace against whatever live endpoints
// are configured in the e2e data dir (`com.writer-computer.e2e/config`) —
// chat endpoint + key are read from that file, never hardcoded here.
// One probe note is created at the vault root, exercised, then deleted.

const VAULT = "/Users/oliver/obsidian/SDU";
const E2E_DATA = join(
  process.env.HOME ?? "",
  "Library/Application Support/com.writer-computer.e2e",
);

/** Read one `key = value` line from the e2e app config (keeps keys out of git). */
function configValue(key) {
  const line = readFileSync(join(E2E_DATA, "config"), "utf-8")
    .split("\n")
    .find((l) => l.startsWith(`${key} =`));
  return line?.split("=").slice(1).join("=").trim() ?? "";
}

const CHAT_ENDPOINT = configValue("ai.chat-endpoint");
const CHAT_KEY = configValue("ai.chat-api-key");
const PROBE_PATH = join(VAULT, "ai-e2e-probe.md");
const PROBE_CONTENT = [
  "---",
  "title: AI e2e probe",
  "---",
  "",
  "# Eigenvalues and eigenvectors",
  "",
  "An eigenvector of a square matrix is a nonzero vector whose direction is",
  "unchanged by the linear map: $Av = \\lambda v$. The scalar $\\lambda$ is the",
  "eigenvalue. Eigendecomposition factors $A = V\\Lambda V^{-1}$ when the matrix",
  "is diagonalizable.",
  "",
].join("\n");

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), "screenshots");

/** Invoke a Tauri command inside the WKWebView and throw on AppError. */
async function ipc(cmd, args = {}) {
  const result = await browser.executeAsync(
    (command, invokeArgs, done) => {
      window.__TAURI_INTERNALS__
        .invoke(command, invokeArgs)
        .then((value) => done({ ok: value }))
        .catch((error) => done({ err: error && error.message ? error.message : String(error) }));
    },
    cmd,
    args,
  );
  if (result.err) throw new Error(`${cmd} failed: ${result.err}`);
  return result.ok;
}

async function pressCmd(key) {
  await browser.execute((pressedKey) => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: pressedKey,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, key);
}

async function pressKey(key) {
  await browser.execute((pressedKey) => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: pressedKey,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, key);
}

async function saveShot(name) {
  mkdirSync(SHOTS, { recursive: true });
  await browser.saveScreenshot(join(SHOTS, `${name}.png`));
}

describe("AI note relations", function () {
  this.timeout(300_000);

  before(async function () {
    // Workspace restore from the seeded recent_workspaces.json.
    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 20_000 });
    await $('[data-sidebar-surface][data-workspace-open="true"]').waitForExist({
      timeout: 20_000,
    });
  });

  it("reports enabled with both endpoints reachable", async function () {
    let lastStatus;
    await browser.waitUntil(
      async () => {
        try {
          lastStatus = await ipc("ai_status");
        } catch (error) {
          lastStatus = { error: error.message };
        }
        return lastStatus.enabled && lastStatus.chat_ok && lastStatus.embed_ok;
      },
      {
        timeout: 30_000,
        interval: 1_000,
        timeoutMsg: `endpoints never probed reachable (last: ${JSON.stringify(lastStatus)})`,
      },
    );
  });

  it("indexes the vault in the background", async function () {
    await browser.waitUntil(
      async () => {
        const status = await ipc("ai_status");
        return status.indexed > 20 && status.pending === 0;
      },
      {
        timeout: 240_000,
        interval: 2_000,
        timeoutMsg: "ai_status never reached indexed>20 && pending==0",
      },
    );
    await saveShot("01-status");
  });

  it("builds the graph: a node per markdown note, link and similarity edges", async function () {
    const graph = await ipc("ai_graph");
    ok(graph.nodes.length > 20, `expected >20 nodes, got ${graph.nodes.length}`);
    const linkEdges = graph.edges.filter((e) => e.kind === "link");
    const similarEdges = graph.edges.filter((e) => e.kind === "similar");
    console.log(
      `[ai] graph: ${graph.nodes.length} nodes, ${linkEdges.length} link, ${similarEdges.length} similar`,
    );
    ok(linkEdges.length > 0, "expected at least one resolved wikilink edge");
    ok(similarEdges.length > 0, "expected at least one similarity edge");
    for (const edge of similarEdges) {
      ok(edge.score >= 0.55, `similarity edge below floor: ${edge.score}`);
    }
  });

  it("opens the Graph tab from the palette and renders a canvas", async function () {
    await pressCmd("p");
    const item = await $('[cmdk-item][data-value="open-graph"]');
    await item.waitForExist({ timeout: 5_000 });
    await item.click();
    await $("canvas").waitForExist({ timeout: 15_000 });
    // Let the force layout settle a few ticks before the screenshot.
    await browser.pause(2_000);
    await saveShot("02-graph-tab");
  });

  it("suggests tags for a note and accepting one writes frontmatter", async function () {
    writeFileSync(PROBE_PATH, PROBE_CONTENT);
    try {
      // Let the watcher + worker index the probe (debounce is 800 ms).
      await browser.waitUntil(
        async () => {
          const status = await ipc("ai_status");
          const graph = await ipc("ai_graph");
          return status.pending === 0 && graph.nodes.some((n) => n.path === PROBE_PATH);
        },
        { timeout: 60_000, interval: 1_000, timeoutMsg: "probe note never indexed" },
      );

      // Open the probe note through the sidebar so the editor has it live.
      // The watcher may take a beat to surface the new row in the tree.
      const row = await $(`[data-tree-path="${PROBE_PATH}"]`);
      await row.waitForExist({ timeout: 15_000 });
      await row.click();

      // Palette → "AI: Suggest Tags for Current Note".
      await pressCmd("p");
      const suggest = await $('[cmdk-item][data-value="ai-suggest-tags"]');
      await suggest.waitForExist({ timeout: 5_000 });
      await suggest.click();

      const card = await $('[role="dialog"][aria-label="AI suggestions"]');
      await card.waitForExist({ timeout: 5_000 });

      // Direct IPC probe — surfaces the real error if the card never fills.
      try {
        const direct = await ipc("ai_suggest_tags", {
          path: PROBE_PATH,
          content: PROBE_CONTENT,
        });
        console.log(`[ai] direct suggest_tags: ${JSON.stringify(direct)}`);
      } catch (error) {
        console.log(`[ai] direct suggest_tags error: ${error.message}`);
      }

      // Chips appear when the chat call returns; click the first one.
      const firstChip = await card.$("button.rounded-full");
      try {
        await firstChip.waitForExist({ timeout: 90_000 });
      } catch (error) {
        const alert = await card.$('[role="alert"]');
        const alertText = (await alert.isExisting()) ? await alert.getText() : "<none>";
        const cardText = await card.getText();
        throw new Error(
          `no chips after 90s — alert: ${alertText} — card: ${JSON.stringify(cardText)}`,
        );
      }
      const acceptedTag = await firstChip.getText();
      await firstChip.click();

      // Frontmatter gains a `tags:` list containing the accepted tag, written
      // through the normal save path (the file is open → dirty → autosave).
      await browser.waitUntil(
        async () => {
          const onDisk = readFileSync(PROBE_PATH, "utf-8");
          return onDisk.includes("tags:") && onDisk.includes(acceptedTag);
        },
        {
          timeout: 15_000,
          interval: 500,
          timeoutMsg: `frontmatter never gained accepted tag "${acceptedTag}"`,
        },
      );
      await saveShot("03-suggest-card");

      // Closing writes nothing further.
      const close = await card.$('button[aria-label="Close suggestions"]');
      await close.click();
    } finally {
      if (existsSync(PROBE_PATH)) unlinkSync(PROBE_PATH);
    }
  });

  it("ai_related returns scored neighbours for an embedded note", async function () {
    const graph = await ipc("ai_graph");
    const connected = new Set(graph.edges.map((e) => e.source));
    const candidate = graph.nodes.find((n) => connected.has(n.path));
    ok(candidate, "no node participates in an edge");
    const related = await ipc("ai_related", { path: candidate.path });
    ok(related.length > 0, `no related notes for ${candidate.path}`);
    ok(related.length <= 8);
    for (const note of related) ok(note.score >= 0.3, `related below floor: ${note.score}`);
  });

  it("ai_rescan completes and pending drains to zero", async function () {
    await ipc("ai_rescan");
    await browser.waitUntil(async () => (await ipc("ai_status")).pending === 0, {
      timeout: 120_000,
      interval: 2_000,
      timeoutMsg: "pending never drained after rescan",
    });
  });

  it("falls back to the secondary chat endpoint when the primary is down", async function () {
    // Primary → dead port (connect-refused is fallback-worthy); fallback → the
    // live tailnet chat server, since the local fallback isn't always up.
    await ipc("set_setting", {
      key: "ai.chat-endpoint",
      value: "http://127.0.0.1:9/v1",
      scope: "global",
    });
    await ipc("set_setting", {
      key: "ai.chat-fallback-endpoint",
      value: CHAT_ENDPOINT,
      scope: "global",
    });
    await ipc("set_setting", {
      key: "ai.chat-fallback-api-key",
      value: CHAT_KEY,
      scope: "global",
    });
    try {
      const tags = await ipc("ai_suggest_tags", {
        path: PROBE_PATH,
        content: PROBE_CONTENT,
      });
      ok(Array.isArray(tags), "suggest_tags did not return a list via fallback");
    } finally {
      await ipc("set_setting", {
        key: "ai.chat-endpoint",
        value: CHAT_ENDPOINT,
        scope: "global",
      });
      await ipc("set_setting", {
        key: "ai.chat-fallback-endpoint",
        value: "http://127.0.0.1:8000/v1",
        scope: "global",
      });
      await ipc("set_setting", {
        key: "ai.chat-fallback-api-key",
        value: "oliver",
        scope: "global",
      });
    }
  });

  it("errors (no partial write) when every chat endpoint is down", async function () {
    await ipc("set_setting", {
      key: "ai.chat-endpoint",
      value: "http://127.0.0.1:9/v1",
      scope: "global",
    });
    await ipc("set_setting", {
      key: "ai.chat-fallback-endpoint",
      value: "http://127.0.0.1:9/v1",
      scope: "global",
    });
    try {
      let threw = false;
      try {
        await ipc("ai_suggest_tags", { path: PROBE_PATH, content: PROBE_CONTENT });
      } catch {
        threw = true;
      }
      ok(threw, "suggest_tags should fail when both endpoints are down");
    } finally {
      await ipc("set_setting", {
        key: "ai.chat-endpoint",
        value: CHAT_ENDPOINT,
        scope: "global",
      });
      await ipc("set_setting", {
        key: "ai.chat-fallback-endpoint",
        value: "http://127.0.0.1:8000/v1",
        scope: "global",
      });
    }
  });

  it("disable stops the worker: status reports off, palette loses AI items", async function () {
    await ipc("set_setting", { key: "ai.enabled", value: false, scope: "global" });
    try {
      const status = await ipc("ai_status");
      strictEqual(status.enabled, false);
      // Commands collapse to disabled shapes — no graph, no suggestions.
      const graph = await ipc("ai_graph");
      strictEqual(graph.nodes.length, 0);
      strictEqual(graph.edges.length, 0);

      await pressCmd("p");
      await browser.pause(300);
      const graphItem = await $('[cmdk-item][data-value="open-graph"]');
      strictEqual(await graphItem.isExisting(), false);
      await pressKey("Escape");
    } finally {
      await ipc("set_setting", { key: "ai.enabled", value: true, scope: "global" });
    }
  });
});
