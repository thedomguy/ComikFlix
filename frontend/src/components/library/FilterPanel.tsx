import type { ReactNode } from "react";
import { READ_STATES, type LibraryView } from "../../lib/filters";

export interface Facet {
  id: string;
  label: string;
  n: number;
}

interface Props {
  v: LibraryView;
  facets: { statuses: Facet[]; types: Facet[]; genres: Facet[] };
  onChange: (patch: Partial<LibraryView>) => void;
}

const cap = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/** Ensure a selected value the data no longer has stays visible (so it can be turned off). */
function withSelected(list: Facet[], selected: string[]) {
  const missing = selected.filter((id) => !list.some((f) => f.id === id));
  return [...list, ...missing.map((id) => ({ id, label: id, n: 0 }))];
}

/** Library filters: reading state, status, type (single choice) and genres (all must match). */
export function FilterPanel({ v, facets, onChange }: Props) {
  const single = (title: string, key: "status" | "type", list: Facet[]) => {
    const set = (val: string) => onChange(key === "status" ? { status: val } : { type: val });
    if (!list.length) return null;
    return (
      <fieldset className="lib-fs">
        <legend>{title}</legend>
        <div className="lib-chips">
          <Chip on={!v[key]} onClick={() => set("")}>
            All
          </Chip>
          {withSelected(list, v[key] ? [v[key]] : []).map((f) => (
            <Chip key={f.id} on={v[key] === f.id} n={f.n} onClick={() => set(v[key] === f.id ? "" : f.id)}>
              {cap(f.label)}
            </Chip>
          ))}
        </div>
      </fieldset>
    );
  };

  return (
    <>
      <fieldset className="lib-fs">
        <legend>Reading</legend>
        <div className="lib-chips">
          {READ_STATES.map((r) => (
            <Chip key={r.id || "all"} on={v.state === r.id} onClick={() => onChange({ state: r.id })}>
              {r.label}
            </Chip>
          ))}
        </div>
      </fieldset>
      {single("Status", "status", facets.statuses)}
      {single("Type", "type", facets.types)}
      {facets.genres.length > 0 && (
        <fieldset className="lib-fs">
          <legend>
            Genres{v.genres.length > 1 && <small> · all of</small>}
            {v.genres.length > 0 && (
              <button type="button" className="lib-linkbtn" onClick={() => onChange({ genres: [] })}>
                Clear
              </button>
            )}
          </legend>
          <div className="lib-chips">
            {withSelected(facets.genres, v.genres).map((g) => {
              const on = v.genres.includes(g.id);
              return (
                <Chip
                  key={g.id}
                  on={on}
                  n={g.n}
                  onClick={() => onChange({ genres: on ? v.genres.filter((x) => x !== g.id) : [...v.genres, g.id] })}
                >
                  {g.label}
                </Chip>
              );
            })}
          </div>
        </fieldset>
      )}
    </>
  );
}

function Chip({ on, n, onClick, children }: { on: boolean; n?: number; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`lib-chip${on ? " on" : ""}`} aria-pressed={on} onClick={onClick}>
      {children}
      {n != null && n > 0 && <span className="n">{n}</span>}
    </button>
  );
}
