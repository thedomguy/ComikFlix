// Inline SVG icons (stroke = currentColor), 24x24 viewBox.
const P = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const IconSearch = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" {...P} /><path d="M16 16l4.5 4.5" {...P} /></svg>
);
export const IconLibrary = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="4.5" height="16" rx="1" {...P} /><rect x="10" y="4" width="4.5" height="16" rx="1" {...P} /><path d="M17 5.2l3.4 14.4" {...P} /></svg>
);
export const IconCalendar = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2" {...P} /><path d="M3.5 10h17M8 3v4M16 3v4" {...P} /></svg>
);
export const IconDownload = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 20h16" {...P} /></svg>
);
export const IconRemote = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="3" {...P} /><circle cx="12" cy="8" r="2" fill="currentColor" /><path d="M10 14h4M10 17h4" {...P} /></svg>
);
export const IconHome = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" {...P} /></svg>
);
export const IconEye = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" {...P} />
    <circle cx="12" cy="12" r="3" {...P} />
    {!open && <path d="M4 4l16 16" {...P} />}
  </svg>
);
