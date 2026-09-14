import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    // The shipped LaTeX snippet set keeps the Obsidian file's own formatting
    // so it stays diffable against a pasted-in plugin file; it is data, not
    // source. See SPECs/latex-suite/contracts/snippet-file-format.md.
    ignorePatterns: [
      "apps/website/src/routeTree.gen.ts",
      ".wrangler/**",
      "apps/desktop/shared/latex-snippets.default.js",
    ],
  },
  lint: {
    ignorePatterns: ["apps/website/src/routeTree.gen.ts", ".wrangler/**"],
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    projects: ["apps/*", "packages/*"],
  },
});
