import { useEffect, useRef } from "react";
import { useUIStore } from "@/stores/ui-store";

export type { CommandPaletteIntent } from "@/stores/ui-store";

export function useIsCommandPaletteOpen() {
  return useUIStore((s) => s.isCommandPaletteOpen);
}

export function useCommandPaletteIntent() {
  return useUIStore((s) => s.commandPaletteIntent);
}

export function useOpenCommandPalette() {
  return useUIStore((s) => s.openCommandPalette);
}

/**
 * Put focus back where it was when a palette closes, unless what it ran moved it.
 * Radix's restore leaves focus on the body here, and then typing goes nowhere.
 */
export function useRestoreFocus(open: boolean) {
  const wasOpen = useRef(false);
  const previous = useRef<Element | null>(null);
  // During render: by effect time the dialog's input has already taken focus.
  if (open && !wasOpen.current) previous.current = document.activeElement;
  wasOpen.current = open;
  useEffect(() => {
    if (!open) return;
    return () => {
      requestAnimationFrame(() => {
        const target = previous.current;
        if (document.activeElement !== document.body) return;
        if (target instanceof HTMLElement && target.isConnected) target.focus();
      });
    };
  }, [open]);
}

export function useCloseCommandPalette() {
  return useUIStore((s) => s.closeCommandPalette);
}

export function useCommandPaletteSearch() {
  return useUIStore((s) => s.commandPaletteSearch);
}

export function useSetCommandPaletteSearch() {
  return useUIStore((s) => s.setCommandPaletteSearch);
}
