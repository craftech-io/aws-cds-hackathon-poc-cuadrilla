// Buzón de salida (`/app/outbox`, docs/design-brief.md §6; FL-048, FL-061, FL-090): every email the world
// sent (the certificate to the customer and to operations, the zone chief's alert) as it left, newest
// first, with its SES events. The detail shows the body in plain text (never HTML) and, for the
// certificate, a 5-minute link to download the PDF. The list follows the shell's clock poll, so a delivery
// event shows up on its own.
import { useState } from "react";
import { Badge } from "../../components/Badge";
import { DataTable } from "../../components/DataTable";
import { Drawer } from "../../components/Drawer";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { useSession } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { copy as consoleCopy } from "../../copy/console";
import { codeLabel } from "../../lib/code-label";
import { useRemote, useRemoteInput } from "../../lib/use-remote";
import type { ViewProps } from "../../lib/view-registry";
import { formatSimTime } from "../../lib/world-clock";
import { outboxCopy as copy } from "./copy";
import { type MailDetail, type MailRow, eventsInOrder, lastEvent, realClock, recipientText, statusTone } from "./outbox-model";

const simTime = (iso: string) => formatSimTime(iso, consoleCopy.clock.weekdays);

function Detail({ mail }: { readonly mail: MailDetail }) {
  const events = eventsInOrder(mail.events);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <dl className="grid grid-cols-1 gap-2">
        {[
          [copy.detail.from, mail.from],
          [copy.detail.to, recipientText(mail)],
          [copy.detail.subject, mail.subject],
          [copy.detail.sentAt, simTime(mail.sentAtSim)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{label}</dt>
            <dd className="text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center gap-2">
        <Badge tone={statusTone(mail.status)}>{codeLabel(copy.statuses, mail.status)}</Badge>
        <span className="text-xs text-slate">{codeLabel(copy.kinds, mail.kind)}</span>
      </div>
      <section aria-labelledby="mail-body-title">
        <h3 id="mail-body-title" className="text-xs font-semibold uppercase tracking-wide text-slate">
          {copy.detail.body}
        </h3>
        <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-mist bg-paper p-3 font-mono text-xs text-ink">{mail.bodyText}</pre>
      </section>
      {mail.attachment ? (
        <section aria-labelledby="mail-attachment-title">
          <h3 id="mail-attachment-title" className="text-xs font-semibold uppercase tracking-wide text-slate">
            {copy.detail.attachment}
          </h3>
          <p className="mt-1 text-ink">{mail.attachment.fileName}</p>
          <a href={mail.attachment.url} download={mail.attachment.fileName} className="mt-2 inline-flex rounded-md bg-cyan px-4 py-2 text-sm font-semibold text-navy-deep hover:bg-cyan-deep hover:text-white">
            {copy.detail.download}
          </a>
          <p className="mt-1 text-xs text-slate">{copy.detail.downloadHint}</p>
        </section>
      ) : null}
      <section aria-labelledby="mail-events-title">
        <h3 id="mail-events-title" className="text-xs font-semibold uppercase tracking-wide text-slate">
          {copy.detail.events}
        </h3>
        {events.length === 0 ? (
          <p className="mt-1 text-slate">{copy.detail.noEvents}</p>
        ) : (
          <ol className="mt-1 space-y-1">
            {events.map((event) => (
              <li key={`${event.type}:${event.atReal}`} className="flex gap-3">
                <span className="tabular-nums text-slate">{realClock(event.atReal)}</span>
                <span className="text-ink">{codeLabel(copy.events, event.type)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

export default function OutboxView(_props: ViewProps) {
  const { trpc } = useSession();
  const { tick } = useWorldClock();
  const [mailId, setMailId] = useState<string | undefined>(undefined);
  const list = useRemote(`outbox.list:${tick}`, (signal) => trpc.outbox.list.query(undefined, { signal }));
  const detail = useRemoteInput("outbox.get", mailId === undefined ? undefined : { mailId }, (input, signal) => trpc.outbox.get.query(input, { signal }));

  const columns = [
    { id: "sent", header: copy.table.sent, cell: (mail: MailRow) => <span className="tabular-nums">{simTime(mail.sentAtSim)}</span> },
    { id: "kind", header: copy.table.kind, cell: (mail: MailRow) => codeLabel(copy.kinds, mail.kind) },
    { id: "to", header: copy.table.to, cell: (mail: MailRow) => <span className="text-xs">{recipientText(mail)}</span> },
    { id: "subject", header: copy.table.subject, cell: (mail: MailRow) => mail.subject },
    { id: "status", header: copy.table.status, cell: (mail: MailRow) => <Badge tone={statusTone(mail.status)}>{codeLabel(copy.statuses, mail.status)}</Badge> },
    {
      id: "events",
      header: copy.table.events,
      cell: (mail: MailRow) => {
        const last = lastEvent(mail.events);
        return <span className="text-xs">{last ? `${codeLabel(copy.events, last.type)} · ${copy.eventCount(mail.events.length)}` : copy.eventCount(0)}</span>;
      },
    },
    { id: "attachment", header: copy.table.attachment, cell: (mail: MailRow) => (mail.hasAttachment ? copy.yes : copy.no) },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={consoleCopy.views.outbox.title} description={consoleCopy.views.outbox.description} />
      <RemoteBlock state={list.state} onRetry={list.reload}>
        {(mails) => (
          <DataTable
            caption={copy.table.caption}
            columns={columns}
            rows={mails}
            keyOf={(mail) => mail.mailId}
            emptyTitle={copy.table.empty}
            emptyLead={copy.table.emptyLead}
            onRowClick={(mail) => setMailId(mail.mailId)}
            {...(mailId === undefined ? {} : { activeKey: mailId })}
          />
        )}
      </RemoteBlock>
      <Drawer open={mailId !== undefined} title={copy.detail.title} onClose={() => setMailId(undefined)} closeLabel={copy.detail.close}>
        <RemoteBlock state={detail.state} onRetry={detail.reload}>
          {(mail) => <Detail mail={mail} />}
        </RemoteBlock>
      </Drawer>
    </div>
  );
}
