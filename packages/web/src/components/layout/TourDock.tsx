// The guided-tour panel of the shell (docs/design-brief.md §6 and §15): a column docked beside the
// view, not a modal, so a judge reads the step and works the simulator at the same time. Its content
// is the panel of the tour view (`views/tour/panel.tsx`, lib/view-registry.ts); until that exists the
// dock says what is coming.
import { Suspense } from "react";
import { copy } from "../../copy/console";
import { PANELS } from "../../lib/view-registry";
import { EmptyState } from "../EmptyState";
import { LoadingBlock } from "../RemoteBlock";

export const TOUR_DOCK_ID = "tour-dock";

export function TourDock({ onClose }: { readonly onClose: () => void }) {
  const Panel = PANELS.component("tour");
  return (
    <aside id={TOUR_DOCK_ID} aria-label={copy.tour.title} className="w-full shrink-0 border-t border-mist bg-white lg:w-96 lg:border-l lg:border-t-0">
      <header className="flex items-center justify-between border-b border-mist px-4 py-3">
        <h2 className="text-base font-semibold text-navy">{copy.tour.title}</h2>
        <button type="button" className="rounded-md px-2 py-1 text-sm text-slate hover:bg-mist" onClick={onClose}>
          {copy.tour.close}
        </button>
      </header>
      <div className="px-4 py-4">
        {Panel ? (
          <Suspense fallback={<LoadingBlock />}>
            <Panel />
          </Suspense>
        ) : (
          <EmptyState title={copy.tour.placeholderTitle} lead={copy.tour.placeholderLead} />
        )}
      </div>
    </aside>
  );
}
