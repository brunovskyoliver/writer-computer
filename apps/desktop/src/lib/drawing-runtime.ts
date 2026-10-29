/** Shared bootstrap for cold inline previews, canvas mounts and SVG exports. */
export function configureDrawingAssets(): void {
  if (typeof window !== "undefined") {
    window.EXCALIDRAW_ASSET_PATH = new URL("excalidraw-assets/", window.location.href).href;
  }
}

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

export function loadDrawingRuntime() {
  configureDrawingAssets();
  return import("@excalidraw/excalidraw");
}
