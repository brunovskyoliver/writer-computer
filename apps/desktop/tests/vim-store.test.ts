import { beforeEach, describe, expect, test } from "vite-plus/test";
import {
  createTab,
  deleteTab,
  registerVimDialogHost,
  selectVimFooterModel,
  setTabMode,
  setTabPending,
  setTabRecording,
  toVimMode,
  useVimStore,
} from "../src/components/editor-area/vim-store";

describe("toVimMode", () => {
  test("maps the library's mode and subMode onto the six modes", () => {
    expect(toVimMode("normal")).toBe("normal");
    expect(toVimMode("insert")).toBe("insert");
    expect(toVimMode("replace")).toBe("replace");
    expect(toVimMode("visual")).toBe("visual");
    expect(toVimMode("visual", "linewise")).toBe("visual-line");
    expect(toVimMode("visual", "blockwise")).toBe("visual-block");
  });
});

describe("vim store", () => {
  beforeEach(() => {
    useVimStore.setState({ byTab: new Map(), dialogHost: null });
  });

  test("createTab starts in Normal with nothing pending or recording", () => {
    createTab("t1");
    expect(useVimStore.getState().byTab.get("t1")).toEqual({
      mode: "normal",
      pending: "",
      recording: null,
    });
  });

  test("setters update only the named tab and replace the map", () => {
    createTab("t1");
    createTab("t2");
    const before = useVimStore.getState().byTab;

    setTabMode("t1", "insert");
    setTabPending("t1", "d2");
    setTabRecording("t1", "a");

    const after = useVimStore.getState().byTab;
    expect(after).not.toBe(before);
    expect(after.get("t1")).toEqual({ mode: "insert", pending: "d2", recording: "a" });
    expect(after.get("t2")).toEqual({ mode: "normal", pending: "", recording: null });
  });

  test("setters on an unknown tab are no-ops", () => {
    const before = useVimStore.getState().byTab;
    setTabMode("ghost", "insert");
    expect(useVimStore.getState().byTab).toBe(before);
  });

  test("deleteTab removes the entry", () => {
    createTab("t1");
    deleteTab("t1");
    expect(useVimStore.getState().byTab.has("t1")).toBe(false);
  });

  test("registerVimDialogHost stores the element", () => {
    const el = {} as HTMLElement;
    registerVimDialogHost(el);
    expect(useVimStore.getState().dialogHost).toBe(el);
    registerVimDialogHost(null);
    expect(useVimStore.getState().dialogHost).toBeNull();
  });

  test("footer model is null without an entry and labelled otherwise", () => {
    expect(selectVimFooterModel(useVimStore.getState(), "t1")).toBeNull();
    expect(selectVimFooterModel(useVimStore.getState(), null)).toBeNull();

    createTab("t1");
    setTabMode("t1", "visual-line");
    setTabPending("t1", "2");
    expect(selectVimFooterModel(useVimStore.getState(), "t1")).toEqual({
      label: "V-LINE",
      pending: "2",
      recording: null,
    });
  });
});
