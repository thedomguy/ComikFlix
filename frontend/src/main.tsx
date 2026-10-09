import { createRoot } from "react-dom/client";
import App from "./App";
import { preloadLibrary } from "./lib/library";
import "./styles/app.css";
import "./styles/shell.css";

// Library + settings/progress requests go out now, alongside App's /api/me check.
preloadLibrary();

createRoot(document.getElementById("root")!).render(<App />);

// Service worker: network-first app shell (offline fallback), cache-first assets + media.
if ("serviceWorker" in navigator && (location.protocol === "https:" || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
}
