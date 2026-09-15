import { useDrawingShutdown } from "./hooks/use-drawing-shutdown";
import { AppLayout } from "./components/app-layout";
import { CommandPalette } from "./components/command-palette";
import { TelemetryConsentDialog } from "./components/telemetry-consent-dialog";
import { WindowTitle } from "./components/window-title";
import { useIsStartupResolved } from "./hooks/use-workspace";
import { useFileWatcher } from "./hooks/use-file-watcher";
import { useKeyboardShortcuts } from "./hooks/use-keyboard-shortcuts";
import { useMenuEvents } from "./hooks/use-menu-events";
import { useMcpRequests } from "./hooks/use-mcp-requests";
import { useOpenDrop } from "./hooks/use-open-drop";
import "./lib/global-recents";
import "./lib/standalone-watch";
import "./App.css";

function App() {
  const shutdownReady = useDrawingShutdown();
  const isStartupResolved = useIsStartupResolved();

  useFileWatcher();
  useKeyboardShortcuts();
  useMenuEvents();
  useMcpRequests();
  useOpenDrop();

  if (!isStartupResolved || !shutdownReady) {
    return null;
  }

  return (
    <>
      <WindowTitle />
      <AppLayout />
      <CommandPalette />
      <TelemetryConsentDialog />
    </>
  );
}

export default App;
