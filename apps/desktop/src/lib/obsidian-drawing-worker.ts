import { readObsidianDrawing } from "./obsidian-drawing-format";

self.onmessage = (event: MessageEvent<string>) => {
  try {
    self.postMessage({ ok: true, scene: readObsidianDrawing(event.data) });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
