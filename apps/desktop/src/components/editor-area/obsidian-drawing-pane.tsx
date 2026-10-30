import { useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useObsidianDrawing, useDrawingCopy, useDrawingViewport } from "./use-obsidian-drawing";
import type { DrawingPreview } from "@/lib/drawing-source-cache";
import { drawingName } from "@/lib/drawings";

function PreviewImage({
  preview,
  name,
  zoom,
  onError,
}: {
  preview: DrawingPreview;
  name: string;
  zoom: number;
  onError: () => void;
}) {
  const { ref: viewport, box } = useDrawingViewport();
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const fit =
    imageSize.width && imageSize.height
      ? Math.min(box.width / imageSize.width, box.height / imageSize.height)
      : 0;
  const width = imageSize.width * fit * zoom;
  const height = imageSize.height * fit * zoom;
  return (
    <div
      ref={viewport}
      className="min-h-0 flex-1 overflow-auto"
      tabIndex={0}
      aria-label="Drawing. Scroll to pan when zoomed."
    >
      <div
        style={{
          width: Math.max(box.width, width),
          height: Math.max(box.height, height),
          display: "grid",
          placeItems: "center",
        }}
      >
        <img
          src={preview.url}
          alt={name}
          draggable={false}
          data-obsidian-drawing
          onLoad={(event) =>
            setImageSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          onError={onError}
          style={{ width, height, maxWidth: "none" }}
        />
      </div>
    </div>
  );
}

const buttonClass =
  "rounded px-2 py-1 text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";

/** A rendered source preview never mounts an editable canvas or save session. */
export default function ObsidianDrawingPane({
  path,
  tabId,
  onEdit,
}: {
  path: string;
  tabId: string;
  onEdit: () => void;
}) {
  const { state, retry, fail } = useObsidianDrawing(path);
  const { busy, notice, setNotice, copy } = useDrawingCopy(path, tabId);
  const [zoom, setZoom] = useState(1);
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={`${drawingName(path)} drawing preview`}
    >
      <div className="obsidian-drawing-header flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        <span className="text-muted-foreground mr-auto text-xs">
          <span className="obsidian-preview-full">Obsidian preview</span>
          <span className="obsidian-preview-short">Preview</span>
        </span>
        <button
          className={buttonClass}
          title="Show original in Finder"
          onClick={() => {
            void revealItemInDir(path).catch((error: unknown) => setNotice(String(error)));
          }}
        >
          Original
        </button>
        <button
          className={buttonClass}
          disabled={state.status !== "ready"}
          title="Edit this drawing. Changes save to this file and stay readable in Obsidian."
          onClick={onEdit}
        >
          Edit
        </button>
        <button
          className={buttonClass}
          disabled={busy || state.status !== "ready"}
          aria-label={busy ? "Creating editable copy" : "Create editable copy"}
          aria-description="Creates a separate drawing beside this file. Existing notes still show the original."
          title="Create a separate editable SVG beside this file. Existing notes still show the original drawing."
          onClick={() => void copy()}
        >
          {busy ? (
            "Creating…"
          ) : (
            <>
              <span className="obsidian-copy-full">Create editable copy</span>
              <span className="obsidian-copy-short">Edit copy</span>
            </>
          )}
        </button>
      </div>
      {notice && (
        <p role="alert" className="text-destructive max-h-16 shrink-0 overflow-auto px-2 text-xs">
          {notice}
        </p>
      )}
      {state.status === "loading" && (
        <p role="status" className="text-muted-foreground p-3 text-sm">
          Loading drawing…
        </p>
      )}
      {state.status === "error" && (
        <div className="min-h-0 overflow-auto p-3 text-sm" role="alert">
          <p>This drawing could not be previewed.</p>
          <p className="text-muted-foreground mt-1 break-words">{state.message}</p>
          <button className={buttonClass} onClick={retry}>
            Retry
          </button>
        </div>
      )}
      {state.status === "ready" && (
        <>
          {state.preview.scene.elements.every((element) => element.isDeleted) ? (
            <p className="text-muted-foreground min-h-0 flex-1 overflow-auto p-3 text-sm">
              This drawing is empty.
            </p>
          ) : (
            <PreviewImage
              preview={state.preview}
              name={drawingName(path)}
              zoom={zoom}
              onError={() => fail("The generated drawing image could not be displayed.")}
            />
          )}
          <div className="obsidian-drawing-zoom flex shrink-0 items-center justify-end gap-1 border-t border-border px-2 py-0.5">
            <button
              className={buttonClass}
              aria-label="Zoom out"
              disabled={zoom <= 0.5}
              onClick={() => setZoom((n) => Math.max(0.5, n / 1.5))}
            >
              −
            </button>
            <button className={buttonClass} aria-label="Fit drawing" onClick={() => setZoom(1)}>
              {Math.round(zoom * 100)}%
            </button>
            <button
              className={buttonClass}
              aria-label="Zoom in"
              disabled={zoom >= 8}
              onClick={() => setZoom((n) => Math.min(8, n * 1.5))}
            >
              +
            </button>
          </div>
        </>
      )}
    </section>
  );
}
