import { $, h, bg, fmtSize, fmtDate } from "./dom.js";
import { store } from "./store.js";
import { resumeTarget, totalPages } from "./home.js";

export const isMobileSeries = () => window.matchMedia("(max-width: 700px)").matches;

function sortedChapters(s) {
  const list = [...s.chapters].sort((a, b) => parseFloat(a.id) - parseFloat(b.id));
  return store.sortNewest ? list.reverse() : list;
}

function nextReleaseLabel(nr) {
  const t = Date.parse(nr.next_expected);
  if (isNaN(t)) return null;
  const days = Math.round((t - Date.now()) / 864e5);
  const when = fmtDate(nr.next_expected);
  const rel = days > 1 ? `in ${days} days` : days === 1 ? "tomorrow" : days === 0 ? "today" : "overdue";
  return `~${when} (${rel}) · about every ${nr.interval_days} days`;
}

function chapterRows(s, query = "") {
  const p = store.progress(s.slug);
  const q = query.trim().toLowerCase();
  const idq = q.replace(/^ch(apter)?\.?\s*/, "");
  const match = (c) =>
    !q || c.id.startsWith(idq) || (/[a-z]/.test(q) && c.date && fmtDate(c.date).toLowerCase().includes(q));
  return sortedChapters(s)
    .filter(match)
    .map((c) => {
      const done = p?.read.includes(c.id);
      const cur = p?.chapter === c.id && !done;
      const when = c.date ? fmtDate(c.date) : "";
      return h(
        "li",
        { onclick: () => (location.hash = `#/read/${s.slug}/${c.id}`) },
        h("div", { class: "num" }, c.id),
        h(
          "div",
          { class: "t" },
          `Chapter ${c.id}`,
          h("small", {}, [`${c.pages.length} pages`, c.size ? fmtSize(c.size) : null, when].filter(Boolean).join(" · "))
        ),
        h("div", { class: `badge${done ? " done" : ""}` }, done ? "✓ Read" : cur ? `${Math.round(p.frac * 100)}%` : "")
      );
    });
}

export function renderDetail(s, keepScroll, { ingestJobs = [], startIngest, toast, mode = "modal" } = {}) {
  const pageMode = mode === "page";
  const r = resumeTarget(s);
  const close = () => (location.hash = "#/");
  const updating = ingestJobs.some((j) => j.slug === s.slug && j.state === "running");
  const missing = s.remote_total != null ? Math.max(0, s.remote_total - s.chapters.length) : 0;
  const list = h("ul", { class: "chapters" });
  const count = h("h3");
  const search = h("input", {
    class: "chsearch",
    type: "search",
    placeholder: "Search chapters...",
    autocomplete: "off",
    "aria-label": "Search chapters",
  });
  const sortBtn = h("button", {
    class: "sortbtn",
    title: "Toggle sort order",
    onclick: () => {
      store.setSortNewest(!store.sortNewest);
      refreshList();
    },
  });
  function refreshList() {
    const rows = chapterRows(s, search.value);
    list.replaceChildren(...(rows.length ? rows : [h("li", { class: "none" }, "No chapters match")]));
    count.textContent = search.value.trim()
      ? `${rows.length} of ${s.chapters.length} Chapters`
      : `${s.chapters.length} Chapters`;
    sortBtn.textContent = store.sortNewest ? "↓ Newest" : "↑ Oldest";
  }
  search.addEventListener("input", refreshList);
  refreshList();
  const nextRel = (s.status || "").toLowerCase() === "ongoing" && s.next_release ? nextReleaseLabel(s.next_release) : null;
  const alts = (s.alt_titles || []).slice(0, 3).join(" • ");
  const sheet = h(
    "div",
    { class: "sheet" },
    h("button", { class: "close", onclick: close, "aria-label": pageMode ? "Back" : "Close" }, pageMode ? "← Back" : "✕"),
    h(
      "div",
      { class: "banner", style: { backgroundImage: bg(s.backdrop) } },
      h(
        "div",
        {},
        h("h1", {}, s.title),
        h(
          "button",
          { class: "btn play", onclick: () => (location.hash = `#/read/${s.slug}/${r.chapter}`) },
          `▶ ${r.label}${r.label === "Continue" ? ` Ch. ${r.chapter}` : ""}`
        ),
        h(
          "button",
          {
            class: "btn info",
            disabled: updating,
            onclick: async () => {
              const res = await startIngest(s.slug);
              if (res.error) toast(res.error);
              else toast("Checking for new chapters in the background");
            },
          },
          updating ? "⟳ Updating…" : missing ? `⟳ Update (${missing} new)` : "⟳ Check for new chapters"
        )
      )
    ),
    h(
      "div",
      { class: "body" },
      h(
        "div",
        { class: "cols" },
        h(
          "div",
          {},
          h(
            "div",
            { class: "meta" },
            h("span", { class: "pill" }, (s.status || "ongoing").replace(/^./, (c) => c.toUpperCase())),
            h("span", {}, `${s.chapters.length} chapters`),
            h("span", {}, `${totalPages(s)} pages`),
            s.size ? h("span", {}, fmtSize(s.size)) : null,
            s.rating ? h("span", {}, `★ ${Number(s.rating).toFixed(1)}`) : null
          ),
          h("p", { class: "desc" }, s.description || "No description yet. Use Update to fetch it from the source.")
        ),
        h(
          "div",
          { class: "facts" },
          s.author ? h("div", {}, "Author: ", h("span", {}, s.author)) : null,
          s.artist ? h("div", {}, "Artist: ", h("span", {}, s.artist)) : null,
          s.type ? h("div", {}, "Type: ", h("span", {}, s.type)) : null,
          s.genres.length ? h("div", {}, "Genres: ", h("span", {}, s.genres.join(", "))) : null,
          nextRel ? h("div", {}, "Next chapter: ", h("span", {}, nextRel)) : null,
          alts ? h("div", {}, "Also known as: ", h("span", {}, alts)) : null,
          s.source_url
            ? h("div", {}, "Source: ", h("a", { href: s.source_url, target: "_blank", rel: "noreferrer" }, new URL(s.source_url).hostname))
            : null
        )
      ),
      h("div", { class: "chhead" }, count, sortBtn),
      search,
      list
    )
  );

  const home = $("#home");
  const seriesPage = $("#series");
  const modal = $("#modal");

  if (pageMode) {
    modal.classList.add("hidden");
    modal.replaceChildren();
    home.classList.add("hidden");
    home.replaceChildren();
    seriesPage.replaceChildren(sheet);
    seriesPage.classList.remove("hidden");
    seriesPage.dataset.slug = s.slug;
    document.body.classList.add("series-open");
    document.body.style.overflow = "";
    requestAnimationFrame(() => window.scrollTo(0, keepScroll || 0));
  } else {
    seriesPage.classList.add("hidden");
    seriesPage.replaceChildren();
    document.body.classList.remove("series-open");
    modal.replaceChildren(sheet);
    modal.onclick = (e) => {
      if (e.target === modal) close();
    };
    modal.classList.remove("hidden");
    modal.dataset.slug = s.slug;
    modal.scrollTop = keepScroll || 0;
  }
}

export function hideSeriesPage() {
  const seriesPage = $("#series");
  const home = $("#home");
  if (seriesPage) {
    seriesPage.classList.add("hidden");
    seriesPage.replaceChildren();
    delete seriesPage.dataset.slug;
  }
  home?.classList.remove("hidden");
  document.body.classList.remove("series-open");
}
