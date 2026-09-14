import { createRoot } from "react-dom/client";
import { EditorTabs } from "@/components/editor-area/editor-tabs";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { EditorScrollContainer } from "@/components/editor-area/editor-scroll-container";
import "@/App.css";

useWorkspaceStore.setState({ root: "/fixture" });

const tabs = ["Notes", "Mathematics for Science", "Settings", "Formulas"].map((name, index) => ({
  id: `fixture-${index}`,
  location: { kind: "file" as const, path: `/fixture/Own notes/${name}.md` },
  back: [],
  forward: [],
}));
useEditorStore.setState({
  tabs,
  activeTabId: tabs[1].id,
  layout: {
    revision: 0,
    root: {
      kind: "pane",
      id: "fixture-pane",
      tabIds: tabs.map((tab) => tab.id),
      activeTabId: tabs[1].id,
    },
    focusedPaneId: "fixture-pane",
  },
});
Object.assign(window, { tabFixture: useEditorStore });
createRoot(document.getElementById("root")!).render(
  <div style={{ padding: 32 }}>
    <div
      id="fixture-pane"
      style={{
        position: "relative",
        width: "100%",
        height: 440,
        border: "1px solid var(--surface-selected)",
      }}
    >
      <div data-pane-strip style={{ position: "absolute", inset: "0 0 auto", zIndex: 40 }}>
        <EditorTabs paneId="fixture-pane" clearTrafficLights={false} />
      </div>
      <EditorScrollContainer>
        <div style={{ padding: "144px 40px 100px" }}>
          <h1>Mathematics for Science</h1>
          <p>Tabs stay visible while the document scrolls beneath its path.</p>
          <button type="button">Focus outside the strip</button>
          {Array.from({ length: 60 }, (_, index) => (
            <p key={index}>Line {index + 1}: a note in this workspace.</p>
          ))}
        </div>
      </EditorScrollContainer>
    </div>
  </div>,
);
