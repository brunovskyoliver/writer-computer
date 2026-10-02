import { afterEach, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({ switchWorkspace: vi.fn() }));
vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("@/stores/workspace-store", () => ({
  useWorkspaceStore: (selector: (state: typeof fixture) => unknown) => selector(fixture),
}));
import { useSwitchWorkspace } from "../src/hooks/use-workspace";

afterEach(() => {
  fixture.switchWorkspace.mockReset();
  vi.unstubAllGlobals();
});

test("switch entry points report rejected saves instead of dropping the failure", async () => {
  const alert = vi.fn();
  vi.stubGlobal("window", { alert });
  fixture.switchWorkspace.mockRejectedValue(new Error("Failed to save /review/note.md"));

  useSwitchWorkspace()("/other");

  await vi.waitFor(() =>
    expect(alert).toHaveBeenCalledWith(
      "Failed to switch workspace: Failed to save /review/note.md",
    ),
  );
  expect(fixture.switchWorkspace).toHaveBeenCalledWith("/other");
});

test("a successful switch does not report an error", async () => {
  const alert = vi.fn();
  vi.stubGlobal("window", { alert });
  fixture.switchWorkspace.mockResolvedValue(undefined);
  useSwitchWorkspace()("/other");
  await Promise.resolve();
  expect(alert).not.toHaveBeenCalled();
});
