import { $, h } from "./dom.js";
import { store } from "./store.js";

let readerCleanup = null;

export function closeReader() {
  if (readerCleanup) {
    readerCleanup();
    readerCleanup = null;
  }
}

export function renderReader(s, chapterId) {
  const idx = s.chapters.findIndex((c) => c.id === chapterId);
  if (idx < 0) {
    location.hash = `#/series/${s.slug}`;
    return;
  }
  const chap = s.chapters[idx];
  const prev = s.chapters[idx - 1];
  const next = s.chapters[idx + 1];
  const go = (c) => (location.hash = `#/read/${s.slug}/${c.id}`);
  const chapterOf = (id) => s.chapters.find((c) => c.id === id);
  const root = $("#reader");

  const pageEls = chap.pages.map((pg, i) => {
    const box = h("div", { class: "pg", style: pg.aspect ? { aspectRatio: pg.aspect } : null });
    box._pg = pg;
    box._n = i + 1;
    return box;
  });
  const strip = h("div", { class: "strip" }, pageEls);
  strip.style.maxWidth = store.readerWidth + "px";

  function loadPage(box, attempt = 0) {
    if (box._img) return;
    const img = h("img", { alt: `Page ${box._n}`, decoding: "async" });
    img.onload = () => {
      if (!box.style.aspectRatio) box.style.aspectRatio = `${img.naturalWidth}/${img.naturalHeight}`;
      box.classList.remove("failed");
    };
    img.onerror = () => {
      box._img = null;
      img.remove();
      if (attempt < 3) setTimeout(() => { if (box._want) loadPage(box, attempt + 1); }, 800 * (attempt + 1));
      else {
        box.classList.add("failed");
        box.replaceChildren(
          h("button", { class: "retry", onclick: () => { box.replaceChildren(); loadPage(box); } }, `Page ${box._n} failed to load. Click to retry`)
        );
      }
    };
    img.src = attempt ? `${box._pg.src}?r=${attempt}` : box._pg.src;
    box._img = img;
    box.append(img);
  }
  function unloadPage(box) {
    if (!box._img) return;
    box._img.removeAttribute("src");
    box._img.remove();
    box._img = null;
  }
  const loader = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        e.target._want = e.isIntersecting;
        if (e.isIntersecting) loadPage(e.target);
        else unloadPage(e.target);
      }
    },
    { root, rootMargin: "300% 0px" }
  );
  pageEls.forEach((b) => loader.observe(b));

  const progress = h("div", { class: "progress" });
  const widthSlider = h("input", {
    type: "range",
    min: 400,
    max: 1400,
    step: 50,
    value: store.readerWidth,
    title: "Page width",
    oninput: (e) => {
      strip.style.maxWidth = store.setReaderWidth(e.target.value) + "px";
    },
  });
  const morePanel = h(
    "div",
    { class: "more-panel hidden" },
    h("label", {}, "Page width"),
    widthSlider
  );
  const moreBtn = h("button", {
    title: "Reader settings",
    onclick: (e) => {
      e.stopPropagation();
      morePanel.classList.toggle("hidden");
    },
  }, "⚙");
  const moreWrap = h("div", { class: "more-wrap" }, moreBtn, morePanel);

  const bar = h(
    "div",
    { class: "rbar" },
    h("button", { onclick: () => (location.hash = `#/series/${s.slug}`) }, "← Back"),
    h("div", { class: "ttl" }, `${s.title} · Chapter ${chap.id}`),
    h("button", { disabled: !prev, onclick: () => prev && go(prev), title: "Previous chapter (←)" }, "‹ Prev"),
    h(
      "select",
      { onchange: (e) => go(chapterOf(e.target.value)) },
      s.chapters.map((c) => h("option", { value: c.id, selected: c.id === chap.id }, `Ch. ${c.id}`))
    ),
    h("button", { disabled: !next, onclick: () => next && go(next), title: "Next chapter (→)" }, "Next ›"),
    moreWrap
  );

  const end = h(
    "div",
    { class: "endcard" },
    h("h2", {}, next ? `Chapter ${chap.id} complete` : "You're all caught up"),
    h("p", {}, next ? `Up next: Chapter ${next.id}` : "No more downloaded chapters."),
    next ? h("button", { class: "btn play", onclick: () => go(next) }, "Next Chapter ›") : null,
    h("button", { class: "btn info", onclick: () => (location.hash = `#/series/${s.slug}`) }, "All Chapters")
  );

  root.replaceChildren(progress, bar, strip, end);
  root.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  const saved = store.progress(s.slug);
  const frac0 = saved && saved.chapter === chap.id && saved.frac < 0.97 ? saved.frac : 0;
  root.scrollTop = 0;
  const restore = () => {
    root.scrollTop = frac0 * (root.scrollHeight - root.clientHeight);
  };
  if (frac0) {
    restore();
    requestAnimationFrame(restore);
  }

  let lastY = 0;
  let timer = null;
  let lastTap = 0;
  const showControls = () => {
    bar.classList.remove("away");
    lastY = root.scrollTop;
  };
  const frac = () => {
    const m = root.scrollHeight - root.clientHeight;
    return m > 0 ? Math.min(1, root.scrollTop / m) : 1;
  };
  const onScroll = () => {
    const y = root.scrollTop;
    const f = frac();
    bar.classList.toggle("away", y > lastY && y > 120);
    if (y < lastY) bar.classList.remove("away");
    lastY = y;
    progress.style.width = f * 100 + "%";
    morePanel.classList.add("hidden");
    clearTimeout(timer);
    timer = setTimeout(() => store.saveProgress(s.slug, chap.id, f, f > 0.97), 250);
  };
  const onKey = (e) => {
    if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
    if (e.key === "Escape") location.hash = `#/series/${s.slug}`;
    else if (e.key === "ArrowRight" && next) go(next);
    else if (e.key === "ArrowLeft" && prev) go(prev);
  };
  const onPointer = (e) => {
    if (e.target.closest(".rbar, .endcard, button, select, input, a")) return;
    const now = Date.now();
    if (now - lastTap < 350) {
      showControls();
      lastTap = 0;
      e.preventDefault();
    } else lastTap = now;
  };
  const onDocClick = (e) => {
    if (!e.target.closest(".more-wrap")) morePanel.classList.add("hidden");
  };
  root.addEventListener("scroll", onScroll, { passive: true });
  root.addEventListener("pointerup", onPointer);
  window.addEventListener("keydown", onKey);
  document.addEventListener("click", onDocClick);
  store.saveProgress(s.slug, chap.id, frac0, false);
  readerCleanup = () => {
    loader.disconnect();
    clearTimeout(timer);
    // Flush any pending scroll progress before leaving the reader.
    store.saveProgress(s.slug, chap.id, frac(), frac() > 0.97);
    store.flush();
    root.removeEventListener("scroll", onScroll);
    root.removeEventListener("pointerup", onPointer);
    window.removeEventListener("keydown", onKey);
    document.removeEventListener("click", onDocClick);
    root.classList.add("hidden");
    root.replaceChildren();
    document.body.style.overflow = "";
  };
}
