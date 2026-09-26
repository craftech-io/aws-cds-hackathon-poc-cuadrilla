// Stand-in for the views that later work packages build (docs/build-plan.md, waves 1 and 5): the
// title and description of the route, so the shell, the navigation and the role guards can be
// tested end to end before the data exists.
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
