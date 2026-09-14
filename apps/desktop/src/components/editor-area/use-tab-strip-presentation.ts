import { useEffect, useState } from "react";
import type { Tab } from "@/hooks/use-tabs";

export const TAB_MOTION_MS = 240;

interface PresentedTab {
  tab: Tab;
  exiting: boolean;
  exitLeft: boolean;
}

/** Removed tabs survive only as inert chrome; document close is never delayed. */
export function reconcilePresentedTabs(previous: PresentedTab[], tabs: Tab[]): PresentedTab[] {
  const live = new Set(tabs.map((tab) => tab.id));
  const next = tabs.map((tab) => ({ tab, exiting: false, exitLeft: false }));
  previous.forEach((entry, index) => {
    if (live.has(entry.tab.id)) return;
    const right = previous.slice(index + 1).find((item) => live.has(item.tab.id));
    const position = right ? next.findIndex((item) => item.tab.id === right.tab.id) : next.length;
    next.splice(position, 0, { ...entry, exiting: true, exitLeft: !right });
  });
  return next;
}

export function useTabStripPresentation(tabs: Tab[]) {
  const [source, setSource] = useState(tabs);
  const [presented, setPresented] = useState<PresentedTab[]>(() =>
    tabs.map((tab) => ({ tab, exiting: false, exitLeft: false })),
  );
  if (source !== tabs) {
    setSource(tabs);
    setPresented(reconcilePresentedTabs(presented, tabs));
  }

  useEffect(() => {
    if (!presented.some((item) => item.exiting)) return;
    const timer = setTimeout(() => {
      setPresented((items) => items.filter((item) => !item.exiting));
    }, TAB_MOTION_MS);
    return () => clearTimeout(timer);
  }, [presented]);

  return presented;
}
