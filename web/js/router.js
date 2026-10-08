import { $ } from "./dom.js";
import { renderHome } from "./home.js";
import { renderDetail, hideSeriesPage, isMobileSeries } from "./detail.js";
import { closeReader, renderReader } from "./reader.js";
import { getIngestJobs, startIngest, toast } from "./ingest-ui.js";
import { closeRemote, renderRemote } from "./remote.js";
import { closeDownloads, renderDownloads } from "./downloads.js";

export function createRouter({ getLibrary, refreshLibrary }) {
  function bySlug(slug) {
    return getLibrary().find((s) => s.slug === slug);
  }

  const detailOpts = (mode) => ({
    ingestJobs: getIngestJobs(),
    startIngest,
    toast,
    refreshLibrary,
    mode,
  });

  function route() {
    document.documentElement.classList.remove("boot-read");
    closeReader();
    closeRemote();
    closeDownloads();
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
    if (view === "downloads") {
      hideSeriesPage();
      renderDownloads($("#home"), getLibrary);
      document.body.style.overflow = "";
      return;
    }
    if (view === "remote") {
      hideSeriesPage();
      renderRemote(getLibrary, slug);
      return;
    }
    if (view === "series" && s) {
      if (pageMode) {
        renderDetail(s, keepScroll, detailOpts("page"));
      } else {
        hideSeriesPage();
        renderHome(getLibrary());
        renderDetail(s, keepScroll, detailOpts("modal"));
        document.body.style.overflow = "hidden";
      }
    } else if (view === "read" && s) {
      hideSeriesPage();
      void renderReader(s, chapter);
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
      document.body.style.overflow = /^#\/(read|remote)/.test(location.hash) ? "hidden" : "";
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
