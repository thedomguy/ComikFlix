import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, LOGIN_EVENT } from "./lib/api";
import { LibraryProvider, LibraryRefSync, libraryRef, useLibrary } from "./lib/library";
import { isMobile, useRoute } from "./lib/route";
import { initScreen } from "./lib/screen";
import { Nav } from "./components/Nav";
import { Toast } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TabBar } from "./components/TabBar";
import { MobileTitle } from "./components/MobileTitle";
import IngestHost from "./components/IngestHost";
import HomePage from "./pages/HomePage";
import LibraryPage from "./pages/LibraryPage";
import SearchPage from "./pages/SearchPage";
import CalendarPage from "./pages/CalendarPage";
import SeriesPage from "./pages/SeriesPage";
import ReaderPage from "./pages/ReaderPage";
import RemotePage from "./pages/RemotePage";
import DownloadsPage from "./pages/DownloadsPage";
import LoginPage from "./pages/LoginPage";

interface Me {
  auth: boolean;
  authed: boolean;
  pin: number;
}

/** Signed-in gate: shows the PIN login when the server requires it (or any call gets a 401). */
export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [needLogin, setNeedLogin] = useState(false);

  useEffect(() => {
    api<Me>("/api/me")
      .then((m) => {
        setMe(m);
        setNeedLogin(m.auth && !m.authed);
      })
      .catch(() => setMe({ auth: false, authed: true, pin: 0 })); // offline: try the cached app
    const on = () => setNeedLogin(true);
    addEventListener(LOGIN_EVENT, on);
    return () => removeEventListener(LOGIN_EVENT, on);
  }, []);

  if (!me) return null;
  if (needLogin) {
    document.documentElement.classList.remove("boot-read");
    return <LoginPage pinLength={me.pin} />;
  }
  return (
    <LibraryProvider>
      <LibraryRefSync />
      <Shell />
      <Toast />
    </LibraryProvider>
  );
}

function Shell() {
  const route = useRoute();
  const { ready, error, bySlug } = useLibrary();
  const [addOpen, setAddOpen] = useState(false);
  const [mobile, setMobile] = useState(isMobile);

  useEffect(() => {
    const mq = matchMedia("(max-width: 700px)");
    const on = () => setMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    if (ready) initScreen(() => libraryRef.current); // this tab can be driven by a remote
  }, [ready]);

  useEffect(() => {
    if (ready) document.documentElement.classList.remove("boot-read");
  }, [ready]);

  // "/" opens search from anywhere outside a text field.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && route.view !== "read") {
        e.preventDefault();
        location.hash = "#/search";
      }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [route.view]);

  // ---- native-style navigation on phones: screen depth drives the transition ----
  const key = `${route.view}/${route.parts.join("/")}`;
  const depth = DEPTH[route.view] ?? 0;
  // Decided once per screen change, so re-renders (e.g. progress saves) don't restart it.
  const nav = useRef({ key, depth, anim: "" });
  if (nav.current.key !== key) {
    const from = nav.current.depth;
    nav.current = { key, depth, anim: !mobile ? "" : depth > from ? "push" : depth < from ? "pop" : "fade" };
  }
  const anim = nav.current.anim;

  // Each screen remembers its scroll position (tabs keep their place, like an app).
  const scrolls = useRef(new Map<string, number>());
  const current = useRef(key);
  useEffect(() => {
    const on = () => scrolls.current.set(current.current, scrollY);
    addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, []);
  useLayoutEffect(() => {
    current.current = key;
    window.scrollTo(0, scrolls.current.get(key) ?? 0);
  }, [key]);

  const tabs = mobile && route.view !== "read" && route.view !== "remote";
  useEffect(() => {
    document.body.classList.toggle("has-tabs", tabs);
  }, [tabs]);

  if (!ready) return null;
  if (error) return <div className="empty">Could not load the library.</div>;

  const { view, parts, query } = route;
  const series = view === "series" || view === "read" ? bySlug(parts[0]) : undefined;
  const fullscreen = view === "read" || view === "remote" || (view === "series" && mobile);

  let page;
  if (view === "read" && series) page = <ReaderPage key={`${series.slug}/${parts[1]}`} slug={series.slug} chapter={parts[1]} />;
  else if (view === "remote") page = <RemotePage key={parts[0] || "list"} screen={parts[0]} />;
  else if (view === "series" && series && mobile) page = <SeriesPage slug={series.slug} mode="page" />;
  else if (view === "series" && series)
    page = (
      <>
        <HomePage />
        <SeriesPage slug={series.slug} mode="modal" />
      </>
    );
  else if (view === "library") page = <LibraryPage query={query} />;
  else if (view === "search") page = <SearchPage q={query.get("q") || ""} />;
  else if (view === "calendar") page = <CalendarPage month={parts[0]} />;
  else if (view === "downloads") page = <DownloadsPage />;
  else page = <HomePage />;

  return (
    <>
      {!fullscreen && !mobile && <Nav onAdd={() => setAddOpen(true)} />}
      {mobile && !fullscreen && <MobileTitle title={TITLES[view] ?? null} />}
      <ErrorBoundary key={key}>
        <div className={`screen${anim ? ` anim-${anim}` : ""}`} key={key}>
          {page}
        </div>
      </ErrorBoundary>
      {tabs && <TabBar route={route} onAdd={() => setAddOpen(true)} />}
      <IngestHost addOpen={addOpen} onCloseAdd={() => setAddOpen(false)} />
    </>
  );
}

/** How deep a screen sits (tabs = 0): deeper slides in from the right, shallower slides back. */
const DEPTH: Record<string, number> = { "": 0, library: 0, search: 0, calendar: 0, series: 1, downloads: 1, remote: 1, read: 2 };
/** Compact title shown on phones once the page's large title scrolls away. */
const TITLES: Record<string, string> = { library: "Library", calendar: "Calendar", downloads: "Downloads" };
