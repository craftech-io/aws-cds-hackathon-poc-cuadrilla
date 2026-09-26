import { useEffect, type ReactNode } from "react";

interface DrawerProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly closeLabel: string;
  readonly children: ReactNode;
}

/** Right-hand side panel for details and forms; closes on Escape and on the backdrop. */
export function Drawer({ open, title, onClose, closeLabel, children }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button type="button" aria-label={closeLabel} className="flex-1 bg-navy-deep/40" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label={title} className="flex h-full w-full max-w-lg flex-col bg-white shadow-card">
        <header className="flex items-center justify-between border-b border-mist px-6 py-4">
          <h2 className="text-lg font-semibold text-navy">{title}</h2>
          <button type="button" className="rounded-md px-2 py-1 text-sm text-slate hover:bg-mist" onClick={onClose}>
            {closeLabel}
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
      </aside>
    </div>
  );
}
