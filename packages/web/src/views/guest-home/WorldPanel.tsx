// The card of the guest's world in each of its four states (docs/landing-spec.md §7.6) and, once it is
// ready, what was seeded and when it expires. Only controls that work are shown: "Reintentar" only when
// the BFF says a retry can help, the deletion only for a guest of the own sign-up.
import type { ReactNode } from "react";
import { Button } from "../../components/Button";
import { StatGrid, StatTile } from "../../components/StatTile";
import type { GuestHomeCopy } from "./copy";
import { type GuestWorld, cardOf, formatDate, formatWorldTime } from "./guest-home-model";

function ContactLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-semibold text-cyan-deep underline underline-offset-2">
      {children}
    </a>
  );
}

function Spinner({ label }: { readonly label: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-slate">
      <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-mist border-t-cyan-deep motion-reduce:animate-none" />
      {label}
    </span>
  );
}

function Summary({ world, copy }: { readonly world: GuestWorld; readonly copy: GuestHomeCopy }) {
  const summary = world.summary;
  if (summary === undefined) return null;
  const text = copy.ready;
  return (
    <div className="mt-5 space-y-4">
      <h2 className="text-base font-semibold text-navy">{text.summaryTitle}</h2>
      <StatGrid>
        <StatTile label={text.operator} value={<span className="text-base">{summary.operatorName}</span>} />
        <StatTile label={text.installers} value={summary.installers.length} hint={summary.installers.join(" · ")} />
        <StatTile label={text.supervisors} value={summary.supervisors} />
        <StatTile label={text.workOrders} value={summary.workOrders} />
        <StatTile label={text.simNow} value={<span className="text-base">{formatWorldTime(summary.simNow, copy.weekdays)}</span>} />
        {world.createdAtReal === undefined ? null : <StatTile label={text.createdAt} value={<span className="text-base">{formatDate(world.createdAtReal, copy)}</span>} />}
      </StatGrid>
    </div>
  );
}

interface WorldPanelProps {
  readonly world: GuestWorld;
  readonly copy: GuestHomeCopy;
  readonly longWait: boolean;
  readonly retrying: boolean;
  readonly retryNotice?: string | undefined;
  readonly onRetry: () => void;
}

export function WorldPanel({ world, copy, longWait, retrying, retryNotice, onRetry }: WorldPanelProps) {
  const card = cardOf(world, copy);
  const expiry = world.origin === "SIGNUP" && world.expiresAtReal !== undefined ? copy.ready.expiry(formatDate(world.expiresAtReal, copy)) : undefined;
  return (
    <section aria-labelledby="guest-world-title" className="rounded-card border border-mist bg-white p-6 shadow-card">
      <h2 id="guest-world-title" className="font-display text-xl font-semibold text-navy">
        {card.title}
      </h2>
      {card.lead === "" ? null : <p className="mt-2 text-sm text-slate">{card.lead}</p>}
      {world.status === "PROVISIONING" ? (
        <div className="mt-4 space-y-3">
          <Spinner label={copy.provisioning.working} />
          {longWait ? (
            <p className="text-sm text-slate">
              {copy.provisioning.longWait.before}
              <ContactLink href={copy.contactUrl}>{copy.provisioning.longWait.link}</ContactLink>
              {copy.provisioning.longWait.after}
            </p>
          ) : null}
        </div>
      ) : null}
      {world.status === "READY" ? <Summary world={world} copy={copy} /> : null}
      {expiry === undefined || world.status !== "READY" ? null : <p className="mt-4 text-sm text-ink">{expiry}</p>}
      {card.retry ? (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={onRetry} disabled={retrying}>
            {retrying ? copy.retrying : copy.retry}
          </Button>
          {card.talk ? (
            <p className="text-sm text-slate">
              <ContactLink href={copy.contactUrl}>{copy.capFull.talk.link}</ContactLink>
              {copy.capFull.talk.after}
            </p>
          ) : null}
        </div>
      ) : null}
      {retryNotice === undefined ? null : (
        <p role="status" className="mt-3 text-sm text-warning">
          {retryNotice}
        </p>
      )}
    </section>
  );
}
