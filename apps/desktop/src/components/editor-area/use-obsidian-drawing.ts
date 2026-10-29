import { useCallback, useEffect, useRef, useState } from "react";
import { obsidianDrawings, copyObsidianDrawing } from "@/lib/obsidian-drawings";
import type { DrawingPreview } from "@/lib/drawing-source-cache";
import { captureActiveTabOperation, navigateToFile } from "@/hooks/editor-api";
type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; preview: DrawingPreview };

export function useObsidianDrawing(path: string) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  useEffect(() => obsidianDrawings.subscribe(path, () => setRevision((n) => n + 1)), [path]);
  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    const lease = obsidianDrawings.acquire(path);
    void lease.result
      .then((preview) => {
        if (current) setState({ status: "ready", preview });
      })
      .catch((error: unknown) => {
        if (current) setState({ status: "error", message: String(error) });
      });
    return () => {
      current = false;
      lease.release();
    };
  }, [path, revision]);

  return {
    state,
    retry: () => obsidianDrawings.invalidate(path),
    fail: (message: string) => setState({ status: "error", message }),
  };
}

export function useDrawingCopy(path: string, tabId: string) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const copy = async () => {
    const operation = captureActiveTabOperation(tabId);
    const isCurrent = () => mounted.current && operation.isCurrent();
    setBusy(true);
    setNotice("");
    try {
      const destination = await copyObsidianDrawing(path, isCurrent);
      if (destination && isCurrent()) await navigateToFile(destination, { tabId });
    } catch (error) {
      if (mounted.current) setNotice(`Could not create copy: ${String(error)}`);
    } finally {
      operation.dispose();
      if (mounted.current) setBusy(false);
    }
  };
  return { busy, notice, setNotice, copy };
}

export function useDrawingViewport() {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const ref = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  return { ref, box };
}
