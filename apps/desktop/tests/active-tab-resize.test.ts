import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  effect: null as (() => void | (() => void)) | null,
  activeTabId: "active",
}));
vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => {
    harness.effect = effect;
  },
}));
vi.mock("@/hooks/use-editor-layout", () => ({
  usePaneActiveTabId: () => harness.activeTabId,
}));

import { useScrollActiveTabIntoView } from "../src/hooks/use-scroll-active-tab-into-view";

describe("active tab visibility after pane resize", () => {
  let resize: () => void;
  let cleanup: (() => void) | void;
  const observe = vi.fn();
  const disconnect = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resize = () => {};
    harness.effect = null;
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mount(settleMs = 240) {
    let right = 874;
    const tab = {
      getBoundingClientRect: () => ({ left: 690, right: 874 }),
      scrollIntoView: vi.fn(),
    };
    const strip = {
      getBoundingClientRect: () => ({ left: 322, right }),
      querySelector: vi.fn(() => tab),
      dispatchEvent: vi.fn(),
    };
    useScrollActiveTabIntoView("pane", { current: strip as unknown as HTMLElement }, 3, settleMs);
    cleanup = harness.effect!();
    return {
      tab,
      strip,
      shrink: () => {
        right = 748;
        resize();
      },
    };
  }

  it("reveals a tab clipped by shrinking the existing strip after animation settles", () => {
    const { tab, strip, shrink } = mount();
    vi.advanceTimersByTime(240);
    expect(tab.scrollIntoView).not.toHaveBeenCalled();

    shrink();
    expect(observe).toHaveBeenCalledWith(strip);
    expect(tab.scrollIntoView).toHaveBeenCalledExactlyOnceWith({
      behavior: "auto",
      block: "nearest",
      inline: "nearest",
    });
  });

  it("does not move the strip when the active tab still fits", () => {
    const { tab } = mount();
    resize();
    expect(tab.scrollIntoView).not.toHaveBeenCalled();
  });

  it("observes and disconnects even without an animation-settle timer", () => {
    const { tab, shrink } = mount(0);
    shrink();
    expect(tab.scrollIntoView).toHaveBeenCalledOnce();
    cleanup?.();
    cleanup = undefined;
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("disconnects observation and cancels pending animation work on unmount", () => {
    const { tab, shrink } = mount();
    shrink();
    tab.scrollIntoView.mockClear();
    cleanup?.();
    cleanup = undefined;
    vi.advanceTimersByTime(1000);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(tab.scrollIntoView).not.toHaveBeenCalled();
  });
});
