import { $, h, bg } from "./dom.js";
import { store } from "./store.js";
import { withBase, fixPages } from "./paths.js";
import { setReaderBridge, notifyState } from "./screen.js";

let readerCleanup = null;

function homeIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML =
    '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>';
  return svg;
}

export function closeReader() {
  if (readerCleanup) {
    readerCleanup();
    readerCleanup = null;
  }
}

async function loadChapterPages(slug, chapterId) {
  const res = await fetch(
    withBase(`/api/series/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(chapterId)}`)
  );
  if (!res.ok) throw new Error(`chapter ${res.status}`);
  const data = await res.json();
  if (!data.pages?.length) throw new Error("no pages");
  return { ...data, pages: fixPages(data.pages) };
}

export async function renderReader(s, chapterId) {
  const idx = s.chapters.findIndex((c) => c.id === chapterId);
  if (idx < 0) {
    location.hash = `#/series/${s.slug}`;
    return;
  }
  const prev = s.chapters[idx - 1];
  const next = s.chapters[idx + 1];
  const go = (c) => (location.hash = `#/read/${s.slug}/${c.id}`);
  const chapterOf = (id) => s.chapters.find((c) => c.id === id);
  const root = $("#reader");
  const wantHash = `#/read/${s.slug}/${chapterId}`;

  let chap = s.chapters[idx];
  if (!chap.pages?.length) {
    root.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    root.replaceChildren(h("div", { class: "empty" }, "Loading chapter…"));
    readerCleanup = () => {
      root.classList.add("hidden");
      root.replaceChildren();
      document.body.style.overflow = "";
      readerCleanup = null;
    };
    try {
      const data = await loadChapterPages(s.slug, chapterId);
      if (location.hash !== wantHash) return;
      chap = { ...chap, ...data };
      s.chapters[idx] = chap;
    } catch {
      if (location.hash !== wantHash) return;
      root.replaceChildren(h("div", { class: "empty" }, "Could not load chapter."));
      return;
    }
    if (readerCleanup) {
      // Drop loading-only cleanup; full reader sets its own.
      readerCleanup = null;
    }
  }

  const pageEls = chap.pages.map((pg, i) => {
    const box = h("div", { class: "pg", style: pg.aspect ? { aspectRatio: pg.aspect } : null });
    box._pg = pg;
    box._n = i + 1;
    return box;
  });
  const strip = h("div", { class: "strip" }, pageEls);
  strip.style.maxWidth = store.readerWidth + "px";

  let scrollingProgrammatically = false;
  let ignoreScrollUntil = 0;
  let lastY = 0;
  let timer = null;
  let autoPlaying = false;
  let raf = 0;
  let lastTs = 0;
  let scrollPos = 0; // float accumulator — browsers truncate scrollTop to ints
  let speed = store.autoScrollSpeed(s.slug, chap.id);
  let chapterComplete = false;
  let resumeAt = 0; // saved fraction offered via the resume toast; 0 once taken/dismissed

  const progressFill = h("div", { class: "progress" });
  const progressTrack = h("div", { class: "progress-track" }, progressFill);
  const chrome = h("div", { class: "reader-chrome" });

  // body is created early so frac/autoplay can close over it
  const body = h("div", { class: "reader-body" });

  // 100% = endcard CTA in view (not absolute scroll bottom — that fired early while
  // unloaded pages still had collapsed height).
  function endMarkerY() {
    const r = endMarker.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    return r.top - b.top + body.scrollTop;
  }

  function completeAt() {
    const max = body.scrollHeight - body.clientHeight;
    if (max <= 0) return 0;
    // Match IntersectionObserver: ~half the CTA visible in the scrollport.
    const y = endMarkerY() - body.clientHeight + endMarker.offsetHeight * 0.5;
    return Math.max(1, Math.min(max, y));
  }

  function frac() {
    if (chapterComplete) return 1;
    const at = completeAt();
    if (at <= 0) return 0;
    return Math.min(1, Math.max(0, body.scrollTop / at));
  }

  function updateProgress() {
    progressFill.style.width = `${frac() * 100}%`;
  }

  function persistProgress(f = frac()) {
    // Opening at the top with a resume offer must not overwrite the saved spot.
    if (resumeAt > 0 && !chapterComplete) f = Math.max(f, resumeAt);
    store.saveProgress(s.slug, chap.id, f, chapterComplete);
  }

  // Bars are hidden by default; a tap on the page toggles them. Scrolling never shows them.
  function setChromeAway(away) {
    chrome.classList.toggle("away", away);
    foot.classList.toggle("away", away);
    playBtn.classList.toggle("away", away);
  }

  function toggleChrome() {
    setChromeAway(!chrome.classList.contains("away"));
  }


  function stopAutoplay() {
    if (autoPlaying) notifyState();
    autoPlaying = false;
    playBtn.textContent = "▶";
    playBtn.classList.remove("on");
    playBtn.title = "Auto-scroll";
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lastTs = 0;
  }

  function autoTick(ts) {
    if (!autoPlaying) return;
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;
    const max = body.scrollHeight - body.clientHeight;
    if (max <= 0) {
      raf = requestAnimationFrame(autoTick);
      return;
    }
    scrollingProgrammatically = true;
    scrollPos = Math.min(max, scrollPos + speed * dt);
    body.scrollTop = scrollPos;
    scrollingProgrammatically = false;
    updateProgress();
    if (scrollPos >= max - 1) {
      stopAutoplay();
      persistProgress();
      return;
    }
    raf = requestAnimationFrame(autoTick);
  }

  function startAutoplay() {
    speed = store.autoScrollSpeed(s.slug, chap.id);
    speedSlider.value = String(speed);
    speedVal.textContent = `${speed} px/s`;
    autoPlaying = true;
    playBtn.textContent = "❚❚";
    playBtn.classList.add("on");
    playBtn.title = "Pause auto-scroll";
    dismissResume();
    ignoreScrollUntil = performance.now() + 400;
    setChromeAway(true);
    scrollPos = body.scrollTop;
    lastY = body.scrollTop;
    lastTs = 0;
    raf = requestAnimationFrame(autoTick);
    notifyState();
  }

  function toggleAutoplay() {
    if (autoPlaying) stopAutoplay();
    else startAutoplay();
  }

  function loadPage(box, attempt = 0) {
    if (box._img) return;
    const img = h("img", { alt: `Page ${box._n}`, decoding: "async" });
    img.onload = () => {
      box.style.aspectRatio = `${img.naturalWidth}/${img.naturalHeight}`;
      box.classList.remove("failed");
      updateProgress();
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

  const persistSel = h(
    "select",
    {
      title: "Where to save speed",
      onchange: (e) => {
        store.setAutoScroll({ persist: e.target.value, speed, slug: s.slug, chapterId: chap.id });
        speed = store.autoScrollSpeed(s.slug, chap.id);
        speedSlider.value = String(speed);
        speedVal.textContent = `${speed} px/s`;
      },
    },
    ["global", "series", "chapter"].map((p) =>
      h(
        "option",
        { value: p, selected: store.autoScroll.persist === p },
        p === "global" ? "Global" : p === "series" ? "This series" : "This chapter"
      )
    )
  );
  const speedVal = h("span", { class: "speed-val" }, `${speed} px/s`);
  const speedSlider = h("input", {
    type: "range",
    min: 10,
    max: 200,
    step: 5,
    value: speed,
    title: "Auto-scroll speed",
    oninput: (e) => {
      speed = +e.target.value;
      speedVal.textContent = `${speed} px/s`;
      store.setAutoScroll({ speed, slug: s.slug, chapterId: chap.id });
    },
  });

  const morePanel = h(
    "div",
    { class: "more-panel hidden" },
    h("label", {}, "Page width"),
    widthSlider,
    h("label", { style: { marginTop: "12px" } }, "Auto-scroll speed ", speedVal),
    speedSlider,
    h("label", { style: { marginTop: "12px" } }, "Save speed for"),
    persistSel
  );
  const moreBtn = h(
    "button",
    {
      title: "Reader settings",
      onclick: (e) => {
        e.stopPropagation();
        morePanel.classList.toggle("hidden");
      },
    },
    "⚙"
  );
  const moreWrap = h("div", { class: "more-wrap" }, moreBtn, morePanel);

  const toSeries = () => (location.hash = `#/series/${s.slug}`);
  const bar = h(
    "div",
    { class: "rbar" },
    h("button", { class: "rhome", onclick: toSeries, title: "Back to series (Esc)", "aria-label": "Back to series" }, homeIcon()),
    h("button", {
      class: "rcover",
      style: s.poster ? { backgroundImage: bg(s.poster) } : null,
      onclick: toSeries,
      "aria-label": s.title,
      tabindex: "-1",
    }),
    h("div", { class: "ttl" }, h("small", {}, s.title), h("b", {}, `Chapter ${chap.id}`)),
    moreWrap
  );

  const foot = h(
    "div",
    { class: "reader-foot" },
    h("button", { class: "rnav prev", disabled: !prev, onclick: () => prev && go(prev), title: "Previous chapter (←)" }, "‹ Prev"),
    h(
      "label",
      { class: "rpick", title: "Jump to chapter" },
      h("span", { class: "ico", "aria-hidden": "true" }, "≡"),
      h(
        "select",
        { "aria-label": "Chapter", onchange: (e) => go(chapterOf(e.target.value)) },
        s.chapters.map((c) => h("option", { value: c.id, selected: c.id === chap.id }, `Chapter ${c.id}`))
      ),
      h("span", { class: "chev", "aria-hidden": "true" }, "⌄")
    ),
    h("button", { class: "rnav next", disabled: !next, onclick: () => next && go(next), title: "Next chapter (→)" }, "Next ›")
  );

  const resumeToast = h(
    "div",
    { class: "resume-toast hidden", role: "status" },
    h("button", { class: "go", onclick: () => jumpToResume() }, "↓ Continue where you left off"),
    h("button", { class: "x", "aria-label": "Dismiss", onclick: () => dismissResume() }, "✕")
  );

  function dismissResume() {
    resumeAt = 0;
    resumeToast.classList.add("hidden");
  }

  function jumpToResume() {
    const f = resumeAt;
    dismissResume();
    const apply = () => {
      const at = completeAt();
      if (at > 0) {
        ignoreScrollUntil = performance.now() + 300;
        body.scrollTop = f * at;
      }
      updateProgress();
    };
    apply();
    // Pages near the target load and resize after the jump; settle once more.
    requestAnimationFrame(apply);
  }

  // progress sits below the bar so it stays visible when the bar slides away
  chrome.append(bar, progressTrack);

  const playBtn = h(
    "button",
    {
      class: "autoplay-btn",
      title: "Auto-scroll",
      "aria-label": "Auto-scroll",
      onclick: (e) => {
        e.stopPropagation();
        toggleAutoplay();
      },
    },
    "▶"
  );

  const nextBtn = next
    ? h("button", { class: "btn play", onclick: () => go(next) }, "Next Chapter ›")
    : null;
  const allBtn = h("button", { class: "btn info", onclick: () => (location.hash = `#/series/${s.slug}`) }, "All Chapters");
  // Completion marker: Next Chapter play button when present, else All Chapters.
  const endMarker = nextBtn || allBtn;
  const end = h(
    "div",
    { class: "endcard" },
    h("h2", {}, next ? `Chapter ${chap.id} complete` : "You're all caught up"),
    h("p", {}, next ? `Up next: Chapter ${next.id}` : "No more chapters."),
    nextBtn,
    allBtn
  );

  body.append(strip, end);
  root.replaceChildren(chrome, body, foot, resumeToast, playBtn);
  setChromeAway(true);
  root.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  // Bars overlay the scroll pane: keep them clear of its scrollbar, and track the
  // footer height so the resume toast sits above it.
  const measureChrome = () => {
    root.style.setProperty("--foot-h", `${foot.offsetHeight}px`);
    root.style.setProperty("--sbw", `${body.offsetWidth - body.clientWidth}px`);
  };
  measureChrome();
  const chromeSizer = new ResizeObserver(measureChrome);
  chromeSizer.observe(chrome);
  chromeSizer.observe(foot);
  chromeSizer.observe(body);

  const loader = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        e.target._want = e.isIntersecting;
        if (e.isIntersecting) loadPage(e.target);
        else unloadPage(e.target);
      }
    },
    { root: body, rootMargin: "300% 0px" }
  );
  pageEls.forEach((b) => loader.observe(b));

  const endWatcher = new IntersectionObserver(
    ([e]) => {
      if (!e?.isIntersecting || chapterComplete) return;
      chapterComplete = true;
      updateProgress();
      persistProgress(1);
    },
    { root: body, threshold: 0.5 }
  );
  endWatcher.observe(endMarker);

  const saved = store.progress(s.slug);
  const alreadyDone = saved && (saved.read || []).includes(chap.id);
  const frac0 =
    saved && saved.chapter === chap.id && saved.frac > 0 && !alreadyDone ? Math.min(saved.frac, 0.99) : 0;
  body.scrollTop = 0;
  lastY = 0;
  updateProgress();
  // Open at the top and offer the saved spot instead of jumping there silently.
  if (frac0) {
    resumeAt = frac0;
    resumeToast.classList.remove("hidden");
  }

  const onScroll = () => {
    const y = body.scrollTop;
    if (!scrollingProgrammatically) scrollPos = y;
    const f = frac();
    updateProgress();
    const ignore = scrollingProgrammatically || performance.now() < ignoreScrollUntil;
    // Reading on from the top means the resume offer was declined.
    if (resumeAt && !ignore && y > 200) dismissResume();
    if (!ignore) {
      if (autoPlaying && Math.abs(y - lastY) > 2) stopAutoplay();
    }
    lastY = y;
    morePanel.classList.add("hidden");
    clearTimeout(timer);
    timer = setTimeout(() => persistProgress(f), 250);
    notifyState();
  };
  const onKey = (e) => {
    if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
    if (e.key === "Escape") location.hash = `#/series/${s.slug}`;
    else if (e.key === "ArrowRight" && next) go(next);
    else if (e.key === "ArrowLeft" && prev) go(prev);
    else if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      toggleAutoplay();
    }
  };
  // click (not pointerup) so the end of a touch scroll or drag never counts as a tap
  const onTap = (e) => {
    if (e.target.closest(".rbar, .reader-foot, .resume-toast, .endcard, .autoplay-btn, button, select, input, a")) return;
    toggleChrome();
  };

  const onDocClick = (e) => {
    if (!e.target.closest(".more-wrap")) morePanel.classList.add("hidden");
  };
  body.addEventListener("scroll", onScroll, { passive: true });
  body.addEventListener("click", onTap);
  window.addEventListener("keydown", onKey);
  document.addEventListener("click", onDocClick);
  persistProgress(frac0);

  // ---- remote control (see screen.js / remote.js) ----
  let flingV = 0;
  let flingRaf = 0;
  let flingTs = 0;
  function stopFling() {
    if (flingRaf) cancelAnimationFrame(flingRaf);
    flingRaf = 0;
    flingV = 0;
  }
  function flingTick(ts) {
    const dt = flingTs ? Math.min(0.05, (ts - flingTs) / 1000) : 0;
    flingTs = ts;
    body.scrollTop += flingV * dt;
    flingV *= Math.pow(0.03, dt); // glide decays to 3% per second
    if (Math.abs(flingV) < 15) return stopFling();
    flingRaf = requestAnimationFrame(flingTick);
  }
  // Remote drags arrive in bursts (network); ease them in over a few frames so motion
  // is continuous instead of stepping on every packet.
  let pendingDy = 0;
  let easeRaf = 0;
  let easeTs = 0;
  function easeTick(ts) {
    const dt = easeTs ? Math.min(0.05, (ts - easeTs) / 1000) : 1 / 60;
    easeTs = ts;
    const step = pendingDy * (1 - Math.exp(-dt / 0.06)); // ~60ms time constant
    body.scrollTop += step;
    pendingDy -= step;
    if (Math.abs(pendingDy) < 0.5) {
      body.scrollTop += pendingDy;
      pendingDy = 0;
      easeRaf = 0;
      easeTs = 0;
      return;
    }
    easeRaf = requestAnimationFrame(easeTick);
  }
  function stopEase() {
    if (easeRaf) cancelAnimationFrame(easeRaf);
    easeRaf = 0;
    easeTs = 0;
    pendingDy = 0;
  }
  function currentPage() {
    const y = body.scrollTop + body.clientHeight * 0.35;
    let i = 0;
    while (i < pageEls.length - 1 && pageEls[i + 1].offsetTop <= y) i++;
    return i;
  }
  function setSpeed(v) {
    speed = Math.max(10, Math.min(200, Math.round(v / 5) * 5));
    speedSlider.value = String(speed);
    speedVal.textContent = `${speed} px/s`;
    store.setAutoScroll({ speed, slug: s.slug, chapterId: chap.id });
    notifyState();
  }
  setReaderBridge({
    state: () => {
      const i = currentPage();
      return {
        frac: frac(),
        page: i + 1,
        pages: pageEls.length,
        pageSrc: pageEls[i]?._pg.src || null,
        autoplay: autoPlaying,
        speed,
        prev: prev?.id || null,
        next: next?.id || null,
      };
    },
    handle: (cmd) => {
      const vh = body.clientHeight;
      switch (cmd.type) {
        case "scroll": // dy in viewport heights (positive = further down)
          stopFling();
          pendingDy += (Number(cmd.dy) || 0) * vh;
          if (!easeRaf) easeRaf = requestAnimationFrame(easeTick);
          break;
        case "fling": // v in viewport heights per second; glides on after the eased drag
          stopFling();
          flingV = (Number(cmd.v) || 0) * vh;
          flingTs = 0;
          flingRaf = requestAnimationFrame(flingTick);
          break;
        case "page":
          stopFling();
          stopEase();
          body.scrollBy({ top: (cmd.dir < 0 ? -1 : 1) * vh * 0.85, behavior: "smooth" });
          break;
        case "seek": {
          stopFling();
          stopEase();
          const at = completeAt();
          if (at > 0) body.scrollTop = Math.max(0, Math.min(1, Number(cmd.frac) || 0)) * at;
          break;
        }
        case "autoplay":
          stopFling();
          stopEase();
          if (cmd.on && !autoPlaying) startAutoplay();
          else if (!cmd.on && autoPlaying) stopAutoplay();
          break;
        case "speed":
          setSpeed(Number(cmd.value) || speed);
          break;
        case "chapter": {
          const c = cmd.dir < 0 ? prev : next;
          if (c) go(c);
          break;
        }
      }
    },
  });

  readerCleanup = () => {
    stopFling();
    stopEase();
    setReaderBridge(null);
    stopAutoplay();
    loader.disconnect();
    chromeSizer.disconnect();
    endWatcher.disconnect();
    clearTimeout(timer);
    persistProgress();
    store.flush();
    body.removeEventListener("scroll", onScroll);
    body.removeEventListener("click", onTap);
    window.removeEventListener("keydown", onKey);
    document.removeEventListener("click", onDocClick);
    root.classList.add("hidden");
    root.replaceChildren();
    root.style.removeProperty("--sbw");
    root.style.removeProperty("--foot-h");
    document.body.style.overflow = "";
  };
}
