import { $ } from "./dom.js";
import { renderHome } from "./home.js";
import { renderDetail, hideSeriesPage, isMobileSeries } from "./detail.js";
import { closeReader, renderReader } from "./reader.js";
import { getIngestJobs, startIngest, toast } from "./ingest-ui.js";

export function createRouter({ getLibrary, refreshLibrary }) {
  function bySlug(slug) {
    return getLibrary().find((s) => s.slug === slug);
  }

  function route() {
    closeReader();
    const [, view, slug, chapter] = decodeURIComponent(location.hash).split("/");
    const s = slug && bySlug(slug);
    const modal = $("#modal");
    const seriesPage = $("#series");
    const pageMode = isMobileSeries();
    const keepScroll =
      view === "series" && s
        ? pageMode
          ? seriesPage?.dataset.slug === slug
            ? window.scrollY
            : 0
          : !modal.classList.contains("hidden") && modal.dataset.slug === slug
            ? modal.scrollTop
            : 0
        : 0;

    modal.classList.add("hidden");
    if (view === "series" && s) {
      if (pageMode) {
        renderDetail(s, keepScroll, { ingestJobs: getIngestJobs(), startIngest, toast, mode: "page" });
      } else {
        hideSeriesPage();
        renderHome(getLibrary());
        renderDetail(s, keepScroll, { ingestJobs: getIngestJobs(), startIngest, toast, mode: "modal" });
        document.body.style.overflow = "hidden";
      }
    } else if (view === "read" && s) {
      hideSeriesPage();
      renderReader(s, chapter);
      return;
    } else {
      hideSeriesPage();
      renderHome(getLibrary());
      document.body.style.overflow = "";
    }
  }

  window.addEventListener("hashchange", () => {
    route();
    if (!location.hash.startsWith("#/series")) {
      document.body.style.overflow = location.hash.startsWith("#/read") ? "hidden" : "";
    } else if (isMobileSeries()) {
      document.body.style.overflow = "";
    }
  });

  // Flip between page / modal when crossing the mobile breakpoint
  window.matchMedia("(max-width: 700px)").addEventListener("change", () => {
    if (location.hash.startsWith("#/series")) route();
  });

  return { route, refreshAndRoute: async () => { await refreshLibrary(); route(); } };
}
