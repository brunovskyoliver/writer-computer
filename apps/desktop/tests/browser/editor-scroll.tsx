import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { codeMirrorBaseSetup } from "@/lib/prosemark-core/main";
import { EditorScrollContainer } from "@/components/editor-area/editor-scroll-container";
import { editorSearchExtensions } from "@/components/editor-area/editor-search-extensions";
import "@/App.css";
import "@/components/editor-area/prosemark-theme.css";
createRoot(document.getElementById("root")!).render(
  <div style={{ height: 600 }}>
    <EditorScrollContainer>
      <div
        style={{ paddingTop: 144, paddingBottom: 24 }}
        ref={(node) => {
          if (!node) return;
          const view = new EditorView({
            parent: node,
            state: EditorState.create({
              doc: Array.from({ length: 60 }, (_, i) => `Line ${i}`).join("\n"),
              extensions: [codeMirrorBaseSetup(), editorSearchExtensions],
            }),
          });
          Object.assign(window, { view, scrollChecks: runChecks(view) });
          return () => view.destroy();
        }}
      />
    </EditorScrollContainer>
  </div>,
);

// Open /tests/browser/editor-scroll.html through vp dev. The promise rejects
// on failure; browser automation can await window.scrollChecks for the verdict.
async function runChecks(view: EditorView) {
  const scroller = view.dom.closest<HTMLElement>(".overflow-y-auto")!;
  const frame = document.getElementById("root")!.firstElementChild as HTMLElement;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  const results: string[] = [];
  function assertClear(label: string) {
    const caret = view.coordsAtPos(view.state.selection.main.head)!;
    const top = scroller.getBoundingClientRect().top + scroller.clientTop;
    const margin = Math.min(140, scroller.clientHeight / 3);
    if (caret.top < top + margin - 1 || caret.bottom > top + scroller.clientHeight - margin + 1) {
      throw new Error(
        `${label}: caret outside clear area (top=${caret.top - top}, bottom=${top + scroller.clientHeight - caret.bottom})`,
      );
    }
    results.push(label);
  }
  view.focus();
  view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
  await settle();
  assertClear("end of note");
  for (let i = 0; i < 20; i++) {
    view.dispatch(view.state.replaceSelection("\nnew line"), {
      scrollIntoView: true,
      userEvent: "input.type",
    });
    await settle();
    assertClear(`newline ${i + 1}`);
  }
  const beforeTyping = scroller.scrollTop;
  view.dispatch(view.state.replaceSelection("x"), {
    scrollIntoView: true,
    userEvent: "input.type",
  });
  await settle();
  if (Math.abs(scroller.scrollTop - beforeTyping) > 1)
    throw new Error("visible typing moved scroll");
  results.push("visible typing stays still");
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: "wrapped words ".repeat(1500) },
    selection: { anchor: 20000 },
    scrollIntoView: true,
  });
  await settle();
  assertClear("tall wrapped paragraph");
  view.dispatch(view.state.replaceSelection(" more words ".repeat(20)), {
    scrollIntoView: true,
    userEvent: "input.type",
  });
  await settle();
  assertClear("typing wraps");
  frame.style.height = "260px";
  view.requestMeasure();
  await settle();
  view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
  await settle();
  assertClear("short pane");
  scroller.scrollTop -= 100;
  const manuallyScrolled = scroller.scrollTop;
  await settle();
  if (scroller.scrollTop !== manuallyScrolled) throw new Error("manual scroll snapped back");
  results.push("manual scroll stays put");
  frame.style.height = "600px";
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: Array.from({ length: 1500 }, (_, i) => `Line ${i}`).join("\n"),
    },
    selection: { anchor: 0 },
    scrollIntoView: true,
  });
  await settle();
  view.dispatch({
    selection: { anchor: view.state.doc.length },
    scrollIntoView: true,
    userEvent: "select.search",
  });
  await settle();
  assertClear("virtualized search target");
  return results;
}
