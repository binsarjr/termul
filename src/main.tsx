import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { initLaunchDir } from "./lib/launchDir";
import { USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";
import { initSessionRestore } from "./modules/tabs/lib/sessionStore";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

// Reap PTY sessions orphaned by a prior webview load before any tab spawns,
// seed the launch dir before first paint so the default tab mounts at the
// target cwd (no flicker), and decide whether the previous session's tabs
// come back (useTabs hydrates synchronously from this during first render).
await Promise.all([
  invoke("pty_close_all").catch(() => {}),
  initLaunchDir(),
  initSessionRestore(),
]);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);

// Window close (confirm dialog + session flush) is handled by App's
// onCloseRequested listener — it needs React state for the dialog.

// Window starts hidden (per tauri.conf.json) so users never see a transparent
// shadow-only frame before React paints. Use setTimeout — rAF is throttled
// while the window is hidden and would never fire.
const showWindow = () => {
  getCurrentWindow()
    .show()
    .catch((e) => console.error("window.show failed:", e));
};
setTimeout(showWindow, 50);
// Safety net: if the first show somehow fails to take effect, force again.
setTimeout(showWindow, 500);
