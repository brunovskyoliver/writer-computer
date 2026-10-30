import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { gitActions } from "@/hooks/use-git";
import { onFileSaved } from "@/lib/save";

const REFRESH_DEBOUNCE_MS = 800;

/** Keep the panel current: on mount, after saves, on tree changes and on focus.
 *  Passive: this never touches the network, so behind counts date from the last fetch. */
export function useGitStatusUpdates() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void gitActions().refresh();
      }, REFRESH_DEBOUNCE_MS);
    };
    void gitActions().refresh();
    const stopSaved = onFileSaved(schedule);
    const stopFiles = listen("fs:file-changed", schedule);
    const stopDirs = listen("fs:directory-changed", schedule);
    window.addEventListener("focus", schedule);
    return () => {
      if (timer !== null) clearTimeout(timer);
      stopSaved();
      void stopFiles.then((stop) => stop());
      void stopDirs.then((stop) => stop());
      window.removeEventListener("focus", schedule);
    };
  }, []);
}
