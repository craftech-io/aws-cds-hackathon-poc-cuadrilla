// The visible control of the hero's loop (M0, WCAG 2.2.2): pause while it plays, play once it is paused
// or has finished. Its labels come from the landing's copy.
export function PlayPause({ paused, onToggle, pauseLabel, playLabel }: { readonly paused: boolean; readonly onToggle: () => void; readonly pauseLabel: string; readonly playLabel: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex min-h-11 items-center gap-2 rounded-full border border-navy-soft bg-navy-deep/60 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-navy-soft"
    >
      <span aria-hidden="true" className="flex h-4 w-4 items-center justify-center">
        {paused ? (
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor">
            <path d="M3 1.5v9l7-4.5z" />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor">
            <path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" />
          </svg>
        )}
      </span>
      {paused ? playLabel : pauseLabel}
    </button>
  );
}
