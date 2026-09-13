import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// Excalidraw loads its fonts from `window.EXCALIDRAW_ASSET_PATH` and silently
// falls back to esm.sh when they are missing — offline that produces a saved
// drawing whose `@font-face` points at a URL it can never fetch. Copy them out
// of node_modules into `public/` (gitignored, regenerated here) so the app is
// offline-correct without vendoring binaries into the repo.
//
// Xiaolai (CJK) is deliberately excluded: it is 12 MB of the 13 MB font
// payload. A drawing containing CJK text falls back to a system font.
const require = createRequire(import.meta.url);
function copyExcalidrawAssets() {
  const fontsDir = join(dirname(require.resolve("@excalidraw/excalidraw")), "fonts");
  const target = new URL("./public/excalidraw-assets/fonts", import.meta.url).pathname;
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(fontsDir, target, {
    recursive: true,
    filter: (src) => !src.includes("/Xiaolai"),
  });
}

// https://vite.dev/config/
export default defineConfig(async () => {
  copyExcalidrawAssets();
  return {
    plugins: [
      react({
        jsxImportSource: "@welldone-software/why-did-you-render",
      }),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        "@": new URL("./src", import.meta.url).pathname,
        "@shared": new URL("./shared", import.meta.url).pathname,
      },
    },
    test: {
      environment: "node",
      include: ["tests/**/*.test.ts"],
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
