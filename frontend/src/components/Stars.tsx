import type { KeyboardEvent } from "react";

const STAR = "M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.1l-5.7 3.2 1.2-6.4-4.7-4.4 6.4-.8z";

function Row({ size }: { size: number }) {
  return (
    <>
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
          <path d={STAR} />
        </svg>
      ))}
    </>
  );
}

/** Five stars in half steps. With `onChange` it's an input: tap a star's left or right half,
 *  tap the current value again to clear; arrow keys step by half a star. */
export function Stars({
  value,
  onChange,
  size = 16,
  label = "Rating",
}: {
  value: number | null;
  onChange?: (v: number | null) => void;
  size?: number;
  label?: string;
}) {
  const v = value || 0;
  const fill = (
    <span className="stars-fill" style={{ width: `${(v / 5) * 100}%` }}>
      <Row size={size} />
    </span>
  );
  if (!onChange) {
    return (
      <span className="stars" role="img" aria-label={v ? `${v} of 5 stars` : "Not rated"}>
        <Row size={size} />
        {fill}
      </span>
    );
  }
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 0.5 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -0.5 : 0;
    if (!step) return;
    e.preventDefault();
    const next = Math.min(5, Math.max(0, v + step));
    onChange(next || null);
  };
  return (
    <span
      className="stars input"
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={5}
      aria-valuenow={v}
      aria-valuetext={v ? `${v} stars` : "Not rated"}
      onKeyDown={onKey}
    >
      <Row size={size} />
      {fill}
      <span className="stars-hit">
        {Array.from({ length: 10 }, (_, i) => {
          const val = (i + 1) / 2;
          return (
            <button
              key={i}
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              onClick={(e) => {
                e.stopPropagation();
                onChange(val === v ? null : val);
              }}
            />
          );
        })}
      </span>
    </span>
  );
}
