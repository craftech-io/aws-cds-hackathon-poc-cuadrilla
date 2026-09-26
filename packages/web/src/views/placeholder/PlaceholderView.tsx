// Stand-in for a console view that a later work package builds (docs/build-plan.md, wave 5): the
// title and description of the route until `views/<route id>/view.tsx` exists, so the shell, the
// navigation and the role guards work end to end before the data does.
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { copy } from "../../copy/console";
import type { RouteId } from "../../routes";

export function PlaceholderView({ id }: { readonly id: RouteId }) {
  const view = copy.views[id];
  return (
    <div>
      <PageHeader title={view.title} description={view.description} />
      <EmptyState title={copy.placeholder.title} lead={copy.placeholder.lead} />
    </div>
  );
}
