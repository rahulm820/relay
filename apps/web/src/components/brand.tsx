/** Relay mark: a hand-made baton hand-off, two nodes joined by an arrow. */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect width="24" height="24" rx="6" fill="var(--accent-solid)" />
      <circle cx="7.5" cy="12" r="2.4" fill="#fff" />
      <path d="M11.5 12h5.5m-2.6-3.1L17.6 12l-3.2 3.1" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 text-[15px] font-semibold tracking-tight text-t1">
      <Mark /> Relay
    </span>
  );
}
