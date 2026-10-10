import { useState } from "react";
import { toast } from "../../lib/toast";
import type { Series, WatchStatus } from "../../lib/types";
import { STATUSES, STATUS_LABEL, canComplete, entryForSlug, suggestFor, updateEntry, useWatchlist } from "../../lib/watchlist";
import { IconList } from "../icons";
import { Stars } from "../Stars";
import { EditEntry, NewEntry } from "./EntryEditor";

/** Series page: add this series to the watch list, or change its status/rating in place. */
export function WatchControl({ s }: { s: Series }) {
  useWatchlist(); // re-render on list changes
  const entry = entryForSlug(s.slug);
  const [sheet, setSheet] = useState<"new" | "edit" | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = async (data: { status?: WatchStatus; rating?: number | null }) => {
    if (!entry) return;
    setBusy(true);
    try {
      await updateEntry(entry.id, data);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save");
    }
    setBusy(false);
  };

  const suggestion = entry && suggestFor(entry, s);
  return (
    <div className="wl-ctl">
      {entry ? (
        <>
          <span className="wl-ctl-label">Watch List</span>
          <select value={entry.status} disabled={busy} onChange={(e) => patch({ status: e.target.value as WatchStatus })} aria-label="Watch list status">
            {STATUSES.map((st) => (
              <option key={st} value={st} disabled={st === "completed" && !canComplete(entry, s) && entry.status !== "completed"}>
                {STATUS_LABEL[st]}
              </option>
            ))}
          </select>
          <Stars value={entry.rating} onChange={(r) => patch({ rating: r })} size={24} label="Your rating" />
          <button className="wl-small" onClick={() => setSheet("edit")}>
            Notes & more
          </button>
          {suggestion && (
            <div className="wl-suggest">
              <span>{suggestion.reason}</span>
              <button disabled={busy} onClick={() => patch({ status: suggestion.status })}>
                Move to {STATUS_LABEL[suggestion.status]}
              </button>
            </div>
          )}
        </>
      ) : (
        <button className="wl-small" onClick={() => setSheet("new")}>
          <IconList /> Add to Watch List
        </button>
      )}
      {sheet === "new" && (
        <NewEntry
          draft={{ asura: s.slug, title: s.title, cover: s.poster, series_status: s.status, in_library: true }}
          onClose={() => setSheet(null)}
          onDone={() => setSheet(null)}
        />
      )}
      {sheet === "edit" && entry && <EditEntry key={entry.id} entry={entry} onClose={() => setSheet(null)} />}
    </div>
  );
}
