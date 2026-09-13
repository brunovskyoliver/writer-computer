import type { EditorView } from "@codemirror/view";
import { useProsemarkEditor } from "./use-prosemark-editor";
import "./prosemark-theme.css";

interface ProseMarkEditorProps {
  tabId: string;
  filePath: string;
  getScrollContainer?: () => HTMLElement | null;
  autoFocus?: boolean;
  onViewChange?: (view: EditorView | null) => void;
}

export function ProseMarkEditor({
  tabId,
  filePath,
  getScrollContainer,
  autoFocus,
  onViewChange,
}: ProseMarkEditorProps) {
  const editorRef = useProsemarkEditor(
    tabId,
    filePath,
    getScrollContainer,
    autoFocus ?? false,
    onViewChange,
  );
  return <div ref={editorRef} className="h-full" />;
}
