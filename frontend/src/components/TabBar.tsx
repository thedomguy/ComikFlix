import { useEffect, useState } from "react";
import type { Route } from "../lib/route";
import { IconCalendar, IconDownload, IconHome, IconLibrary, IconList, IconRemote, IconSearch } from "./icons";
import { InstallButton } from "./InstallButton";

const IconMore = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="5" cy="12" r="1.8" fill="currentColor" />
    <circle cx="12" cy="12" r="1.8" fill="currentColor" />
    <circle cx="19" cy="12" r="1.8" fill="currentColor" />
  </svg>
);
const IconPlus = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const TABS = [
  { view: "", hash: "#/", label: "Home", icon: <IconHome /> },
  { view: "library", hash: "#/library", label: "Library", icon: <IconLibrary /> },
  { view: "list", hash: "#/list", label: "My List", icon: <IconList /> },
  { view: "search", hash: "#/search", label: "Search", icon: <IconSearch /> },
  { view: "calendar", hash: "#/calendar", label: "Calendar", icon: <IconCalendar /> },
];
const MORE_VIEWS = new Set(["downloads", "remote"]);

/** Mobile bottom navigation (replaces the top nav at ≤700px), with a "More" action sheet. */
export function TabBar({ route, onAdd }: { route: Route; onAdd: () => void }) {
  const [sheet, setSheet] = useState(false);
  useEffect(() => setSheet(false), [route.view, route.parts.join("/")]);

  // Series pages belong to the tab you came from; treat them as Home's/Library's children.
  const active = MORE_VIEWS.has(route.view) ? "more" : route.view === "series" ? "" : route.view;

  return (
    <>
      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <a
            key={t.label}
            className={`tab${active === t.view ? " on" : ""}`}
            href={t.hash}
            onClick={(e) => {
              // Tapping the active tab scrolls to top, like native apps.
              if (active === t.view && route.view === t.view) {
                e.preventDefault();
                window.scrollTo({ top: 0, behavior: "smooth" });
              }
            }}
          >
            {t.icon}
            <span>{t.label}</span>
          </a>
        ))}
        <button className={`tab${active === "more" ? " on" : ""}`} onClick={() => setSheet(true)}>
          <IconMore />
          <span>More</span>
        </button>
      </nav>
      {sheet && (
        <div className="sheet-backdrop" onClick={() => setSheet(false)}>
          <div className="action-sheet" role="menu" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grip" />
            <a className="sheet-item" href="#/downloads" role="menuitem">
              <IconDownload /> Downloads
            </a>
            <a className="sheet-item" href="#/remote" role="menuitem">
              <IconRemote /> Remote control
            </a>
            <button
              className="sheet-item"
              role="menuitem"
              onClick={() => {
                setSheet(false);
                onAdd();
              }}
            >
              <IconPlus /> Add a comic
            </button>
            <div className="sheet-install">
              <InstallButton />
            </div>
            <button className="sheet-cancel" onClick={() => setSheet(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
