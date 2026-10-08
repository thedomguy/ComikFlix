import { useEffect, useState } from "react";

/** iOS-style compact title: fades in once the page's large title scrolls away. Also paints
 *  the status-bar area so content never shows through under it (installed app). */
export function MobileTitle({ title }: { title: string | null }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const on = () => setShown(scrollY > 56);
    on();
    addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, [title]);
  return (
    <div className={`mtitle${shown && title ? " shown" : ""}`} aria-hidden={!shown}>
      <span>{title}</span>
    </div>
  );
}
