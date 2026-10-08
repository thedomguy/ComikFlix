import { $, h, bg, fmtSize } from "./dom.js";
import { store } from "./store.js";

export function totalPages(s) {
  if (s.page_total != null) return s.page_total;
  return s.chapters.reduce((n, c) => n + (c.page_count || c.pages?.length || 0), 0);
}

export function resumeTarget(s) {
  const p = store.progress(s.slug);
  if (!p) return { chapter: s.chapters[0].id, label: "Read" };
  const idx = s.chapters.findIndex((c) => c.id === p.chapter);
  if (idx >= 0 && (p.read || []).includes(p.chapter) && idx < s.chapters.length - 1) {
    return { chapter: s.chapters[idx + 1].id, label: "Continue" };
  }
  return { chapter: p.chapter, label: "Continue" };
}

function card(s) {
  const p = store.progress(s.slug);
  const el = h(
    "div",
    { class: "card", style: { backgroundImage: bg(s.poster) }, onclick: () => (location.hash = `#/series/${s.slug}`) },
    h("div", { class: "cap" }, h("b", {}, s.title), h("span", {}, `${s.chapters.length} chapter${s.chapters.length === 1 ? "" : "s"}`))
  );
  if (p) el.append(h("div", { class: "bar", style: { width: `${Math.round(100 * (p.read.length / s.chapters.length))}%` } }));
  return el;
}

function row(title, items) {
  return h("section", { class: "row" }, h("h2", {}, title), h("div", { class: "track" }, items.map(card)));
}

export function renderHome(library) {
  const home = $("#home");
  home.replaceChildren();
  const q = $("#search").value.trim().toLowerCase();
  let list = library;
  if (q) list = library.filter((s) => (s.title + " " + s.genres.join(" ")).toLowerCase().includes(q));

  if (!library.length) {
    home.append(
      h(
        "div",
        { class: "empty" },
        h("h2", {}, "Your library is empty"),
        h("p", {}, "Download a chapter with ", h("code", {}, "./download.py"), " and refresh.")
      )
    );
    return;
  }

  if (!q) {
    const recent = store.get().progress;
    const hero = [...library].sort((a, b) => ((recent[b.slug]?.at) || 0) - ((recent[a.slug]?.at) || 0))[0];
    const r = resumeTarget(hero);
    home.append(
      h(
        "header",
        { class: "hero", style: { backgroundImage: bg(hero.backdrop) } },
        h(
          "div",
          {},
          h("h1", {}, hero.title),
          h(
            "div",
            { class: "meta" },
            h("span", { class: "pill" }, hero.status || "Ongoing"),
            h("span", {}, `${hero.chapters.length} chapters`),
            h("span", {}, `${totalPages(hero)} pages`),
            hero.size ? h("span", {}, fmtSize(hero.size)) : null
          ),
          hero.description ? h("p", {}, hero.description) : null,
          h("button", { class: "btn play", onclick: () => (location.hash = `#/read/${hero.slug}/${r.chapter}`) }, `▶ ${r.label}`),
          h("button", { class: "btn info", onclick: () => (location.hash = `#/series/${hero.slug}`) }, "ⓘ More Info")
        )
      )
    );
  }

  const rows = h("div", { class: "rows", style: q ? { marginTop: "90px" } : null });
  if (!q) {
    const cont = library
      .filter((s) => store.progress(s.slug))
      .sort((a, b) => store.progress(b.slug).at - store.progress(a.slug).at);
    if (cont.length) rows.append(row("Continue Reading", cont));
  }
  if (list.length) rows.append(row(q ? `Results for “${q}”` : "All Comics", list));
  else rows.append(h("div", { class: "empty", style: { padding: "40px 4%" } }, `No titles match “${q}”.`));
  if (!q) {
    const genres = [...new Set(library.flatMap((s) => s.genres))].sort();
    for (const g of genres) rows.append(row(g, library.filter((s) => s.genres.includes(g))));
  }
  home.append(rows);
}
