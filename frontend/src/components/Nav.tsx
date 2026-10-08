import { useEffect, useState, type ReactNode } from "react";
import { go, useRoute } from "../lib/route";
import { IconCalendar, IconDownload, IconLibrary, IconRemote, IconSearch } from "./icons";
import { InstallButton } from "./InstallButton";

/** Top bar on browse pages (hidden in the reader, remote, and the mobile series page).
 *  Search jumps to #/search; the global search page owns the results. */
export function Nav({ onAdd }: { onAdd: () => void }) {
  const route = useRoute();
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const on = () => setSolid(scrollY > 40);
    on();
    addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, []);

  const link = (hash: string, view: string, label: string, icon: ReactNode) => (
    <a className={`iconbtn${route.view === view ? " on" : ""}`} href={hash} title={label} aria-label={label}>
      {icon}
    </a>
  );

  return (
    <nav className={`nav${solid || route.view !== "" ? " solid" : ""}`}>
      <a className="logo" href="#/">COMICFLIX</a>
      <div className="nav-links">
        <a className={`navtext${route.view === "" ? " on" : ""}`} href="#/">Home</a>
        <a className={`navtext${route.view === "library" ? " on" : ""}`} href="#/library">Library</a>
        <a className={`navtext${route.view === "calendar" ? " on" : ""}`} href="#/calendar">Calendar</a>
      </div>
      <div className="nav-right">
        <button className={`iconbtn${route.view === "search" ? " on" : ""}`} onClick={() => go("#/search")} title="Search (/)" aria-label="Search">
          <IconSearch />
        </button>
        <span className="nav-mobile-only">
          {link("#/library", "library", "Library", <IconLibrary />)}
          {link("#/calendar", "calendar", "Calendar", <IconCalendar />)}
        </span>
        {link("#/downloads", "downloads", "Downloads", <IconDownload />)}
        {link("#/remote", "remote", "Remote control", <IconRemote />)}
        <InstallButton />
        <button className="addbtn" onClick={onAdd}>+ Add</button>
      </div>
    </nav>
  );
}
