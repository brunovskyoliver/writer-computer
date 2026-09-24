// Focused diagnostics: excalidraw error text + pdf scroll DOM dump.
const WS = "/private/tmp/writer-perf-ws";

async function openTreeFile(path) {
  const row = await $(`[data-tree-path="${path}"]`);
  await row.waitForExist({ timeout: 10_000 });
  await row.click();
}

describe("perf diagnostics", function () {
  this.timeout(120_000);

  before(async function () {
    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 30_000 });
    await browser.pause(1500);
  });

  it("dumps excalidraw error", async function () {
    await openTreeFile(`${WS}/sketch.excalidraw.svg`);
    await browser.pause(6000);
    const info = await browser.execute(() => {
      const err = [...document.querySelectorAll("p")].find((p) =>
        p.textContent.includes("could not be opened"),
      );
      const msg = [...document.querySelectorAll("p.font-mono")].map((p) => p.textContent);
      return { hasErr: !!err, msg, excal: document.querySelectorAll(".excalidraw").length };
    });
    console.log("[diag] excalidraw:", JSON.stringify(info));
  });

  it("dumps pdf scroll state", async function () {
    await openTreeFile(`${WS}/report-40p.pdf`);
    await browser.pause(4000);
    const info = await browser.execute(() => {
      const scrollers = [...document.querySelectorAll("div.overflow-auto")].map((d) => ({
        sh: d.scrollHeight,
        ch: d.clientHeight,
        vis: d.offsetParent !== null,
        canvases: d.querySelectorAll("canvas").length,
        cls: d.className.slice(0, 80),
      }));
      const canvases = [...document.querySelectorAll("canvas")].map((c) => ({
        w: c.width,
        h: c.height,
        vis: c.offsetParent !== null,
      }));
      const errTxt = [...document.querySelectorAll("p")]
        .map((p) => p.textContent)
        .filter(
          (t) => t && (t.includes("could not") || t.includes("failed") || t.includes("error")),
        )
        .slice(0, 5);
      return { scrollers, canvases: canvases.slice(0, 10), errTxt };
    });
    console.log("[diag] pdf:", JSON.stringify(info).slice(0, 3000));
  });
});
