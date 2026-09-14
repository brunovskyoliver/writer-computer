import { describe, expect, test } from "vite-plus/test";
import { isWorkspaceEventCurrent } from "../src/lib/workspace-events";
import identityContract from "../shared/workspace-identity.contract.json";

describe("workspace watcher event routing", () => {
  test("shares the serialized workspace identity contract", () => {
    expect(identityContract).toEqual({ root: "/workspace", epoch: 7 });
  });

  test("rejects stale workspace events after switches and close", () => {
    const first = { root: "/workspace-a", epoch: 1 };
    expect(isWorkspaceEventCurrent(first, first)).toBe(true);
    expect(isWorkspaceEventCurrent(first, { root: "/workspace-b", epoch: 2 })).toBe(false);
    expect(isWorkspaceEventCurrent(first, null)).toBe(false);
    expect(isWorkspaceEventCurrent(first, { root: "/workspace-a", epoch: 3 })).toBe(false);
  });

  test("keeps unscoped standalone-file events", () => {
    expect(isWorkspaceEventCurrent(null, null)).toBe(true);
  });

  test("keeps unscoped global events while a workspace is open", () => {
    // The global config watcher emits `workspace: null` for the LaTeX snippet
    // file to every window, including ones showing a workspace; those windows
    // must still reload the open tab (SPECs/latex-suite, US2).
    expect(isWorkspaceEventCurrent(null, { root: "/workspace-a", epoch: 1 })).toBe(true);
  });
});
