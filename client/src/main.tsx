import { createRoot } from "react-dom/client";
import App from "./App";
import { normalizeInitialHashRoute } from "./lib/hashRouteSearch";
import "./index.css";

// wouter's hash router expects the path in location.hash and the query in
// location.search. Normalize deep links like #/logs?level=info before mount,
// and preserve legacy dashboard anchors like #dashboard-errors.
let initialAnchorId: string | null = null;
{
  const normalized = normalizeInitialHashRoute(window.location.href);
  if (normalized) {
    initialAnchorId = normalized.anchorId;
    history.replaceState(history.state, "", normalized.href);
  }
}

if (!window.location.hash) {
  window.location.hash = "#/";
}

createRoot(document.getElementById("root")!).render(<App />);

if (initialAnchorId) {
  const startedAt = Date.now();
  const scrollWhenReady = () => {
    const target = document.getElementById(initialAnchorId);
    if (target) {
      target.scrollIntoView({ block: "start" });
      return;
    }

    if (Date.now() - startedAt < 2_000) {
      window.setTimeout(scrollWhenReady, 50);
    }
  };

  window.requestAnimationFrame(scrollWhenReady);
}
