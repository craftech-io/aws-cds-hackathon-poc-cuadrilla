// Stand-in for a public page that a later work package builds (`/join`, docs/build-plan.md WP-44):
// its title and what it is for, branded like the login, with the way to the landing.
import { FullScreenMessage } from "../../components/FullScreenMessage";
import { copy } from "../../copy/console";
import { Link } from "../../lib/router";
import { LANDING_PATH, type PublicPageId } from "../../routes";

export function PublicPlaceholder({ id }: { readonly id: PublicPageId }) {
  const page = copy.public[id];
  return (
    <FullScreenMessage title={page.title} lead={page.lead}>
      <Link to={LANDING_PATH} className="text-sm font-semibold text-cyan-deep underline">
        {copy.errors.backHome}
      </Link>
    </FullScreenMessage>
  );
}
