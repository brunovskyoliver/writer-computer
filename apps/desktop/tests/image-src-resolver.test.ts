import { expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

import { resolveLocalImageSrc } from "../src/components/editor-area/image-src-resolver";

test("a parent-relative image loads from its collapsed path", () => {
  expect(resolveLocalImageSrc("<../Course/a b.png>", "/v/Archive")).toBe(
    `asset://localhost/${encodeURIComponent("/v/Course/a b.png")}`,
  );
});
