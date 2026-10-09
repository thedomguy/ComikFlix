import { useEffect, useState, type FormEvent } from "react";
import { startIngest } from "../../lib/ingest";

/** "Add a comic": series slug/URL + start chapter (+ optional last chapter) -> background ingest. */
export function AddComicModal({ onClose }: { onClose: () => void }) {
  const [series, setSeries] = useState("");
  // Prefilled: only changed when earlier chapters were already read elsewhere.
  const [start, setStart] = useState("1");
  const [upto, setUpto] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const s = series.trim();
    const first = start.trim() ? parseInt(start, 10) : 1;
    if (!s) return setErr("Enter a series slug or URL.");
    if (!Number.isFinite(first) || first < 1) return setErr("Start chapter must be a whole number ≥ 1.");
    const last = upto ? parseInt(upto, 10) : null;
    if (last != null && (!Number.isFinite(last) || last < first)) return setErr("“Up to” must be at least the start chapter.");
    setBusy(true);
    setErr("");
    try {
      await startIngest({ series: s, start_chapter: first, latest: last });
      onClose();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not start the download");
      setBusy(false);
    }
  }

  return (
    <div className="modal ingest-modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet ingest" role="dialog" aria-modal="true" aria-labelledby="ing-title">
        <button className="close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <h2 id="ing-title">Add a comic</h2>
        <p className="hint">
          Reads the series info and indexes chapter page URLs from the start chapter onward (optionally up to a latest
          chapter). Images load from Asura CDN; chapters you already have are skipped.
        </p>
        <form onSubmit={submit} noValidate>
          <div className="full">
            <label htmlFor="ing-series">Series slug or URL</label>
            <input
              id="ing-series"
              placeholder="series slug or asurascans.com comic URL"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={series}
              onChange={(e) => setSeries(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="ing-start">Start chapter</label>
            <input
              id="ing-start"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              placeholder="1"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="ing-upto">Up to chapter (optional)</label>
            <input
              id="ing-upto"
              type="number"
              inputMode="numeric"
              min={1}
              placeholder="all"
              value={upto}
              onChange={(e) => setUpto(e.target.value)}
            />
          </div>
          <button className="btn play" type="submit" disabled={busy}>
            {busy ? "Starting…" : "Add & download"}
          </button>
        </form>
        <div className="err" role="alert">
          {err}
        </div>
      </div>
    </div>
  );
}
