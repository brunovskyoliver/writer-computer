import { createRoot } from "react-dom/client";
import DrawingEditor from "./components/editor-area/drawing-editor";
import { createDrawing } from "./lib/drawings";
import { saveDrawingSessions } from "./lib/drawing-sessions";

const fixture = { svg: "", writes: 0 };
(window as any).__TAURI_INTERNALS__ = {
  invoke: async (command: string, args: any) => {
    if (command === "write_file") {
      fixture.svg = args.content;
      fixture.writes++;
      return {};
    }
    if (command === "read_file") return { content: fixture.svg };
    return null;
  },
};
await createDrawing("/fixture.excalidraw.svg");
fixture.writes = 0;
const host = document.createElement("div");
host.style.cssText = "position:fixed;inset:0;background:white";
document.body.append(host);
const root = createRoot(host);
root.render(<DrawingEditor tabId="harness" path="/fixture.excalidraw.svg" />);
(window as any).drawingHarness = {
  fixture,
  save: saveDrawingSessions,
  unmount: () => root.unmount(),
};
