// Crops of the operator's console for the scenes (docs/landing-spec.md §1.6): the evidence review of a
// rejected photo (S3), the order's checklist without a close button (S4) and the outbox with its
// deliveries (S4, S6). Built with the console's own components (Badge, Table) and the texts of copy/
// and the main story, in a fixed state; WP-44 replaces each one with a capture of the real view.
import { Badge } from "../../../components/Badge";
import type { ReactNode } from "react";
import { CHECKLIST, CONSOLE_EYEBROW, type OutboxRow, VIEW_TEXTS, orderLabel, photoItemLabel, photoSource, storyEntry } from "./sources";

/** A window of the console: its eyebrow, the view's title and what it shows. */
export function ConsoleCrop({ title, subtitle, children, className = "" }: { readonly title: string; readonly subtitle?: string; readonly children: ReactNode; readonly className?: string }) {
  return (
    <div className={`overflow-hidden rounded-card border border-mist bg-white text-left shadow-float ${className}`}>
      <div className="flex items-center gap-2 border-b border-mist bg-paper px-3 py-2">
        <span aria-hidden="true" className="flex gap-1">
          <span className="h-2 w-2 rounded-full bg-mist" />
          <span className="h-2 w-2 rounded-full bg-mist" />
          <span className="h-2 w-2 rounded-full bg-mist" />
        </span>
        <span className="truncate text-2xs font-semibold uppercase tracking-wide text-slate">{CONSOLE_EYEBROW}</span>
      </div>
      <div className="p-3 sm:p-4">
        <p className="text-sm font-semibold text-navy">{title}</p>
        {subtitle ? <p className="text-xs text-slate">{subtitle}</p> : null}
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

const GLARE_PHOTO = storyEntry("s3-label-glare-photo");
const GLARE_REASON = storyEntry("s3-glare-reason");

/** S3: the rejected photo in the evidence review, with the validator's reason (no region drawn on it). */
export function EvidenceInset({ className }: { readonly className?: string }) {
  if (GLARE_PHOTO.kind !== "PHOTO") return null;
  const src = photoSource(GLARE_PHOTO);
  return (
    <ConsoleCrop title={VIEW_TEXTS.evidence.title} subtitle={orderLabel(GLARE_PHOTO.workOrderNumber)} className={className}>
      <div className="flex items-start gap-3">
        {src ? (
          <img src={src} alt={GLARE_PHOTO.text} width={480} height={360} loading="lazy" className="h-14 w-18 shrink-0 rounded-md object-cover" />
        ) : (
          <span role="img" aria-label={GLARE_PHOTO.text} className="h-14 w-18 shrink-0 rounded-md bg-mist" />
        )}
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-ink">
            {photoItemLabel(GLARE_PHOTO)} <Badge tone="danger">{GLARE_PHOTO.reaction}</Badge>
          </p>
          <p className="text-xs text-slate">{GLARE_REASON.text}</p>
        </div>
      </div>
    </ConsoleCrop>
  );
}

/** S4: the checklist of order 24817 complete, every item validated; the console has no close action. */
export function ChecklistInset({ className }: { readonly className?: string }) {
  const order = storyEntry("s4-certificate").workOrderNumber;
  return (
    <ConsoleCrop title={VIEW_TEXTS["order-detail"].title} subtitle={orderLabel(order)} className={className}>
      <p className="flex items-center justify-between gap-2 text-xs font-semibold text-navy">
        {CHECKLIST.title}
        <span className="shrink-0 whitespace-nowrap">
          <Badge tone="success">
            <span>{CHECKLIST.passed}</span>&nbsp;
            <span className="tabular-nums">
              {CHECKLIST.items.length}/{CHECKLIST.items.length}
            </span>
          </Badge>
        </span>
      </p>
      <ul className="mt-2 space-y-1.5">
        {CHECKLIST.items.map((item) => (
          <li key={item} className="flex items-center gap-2 text-xs text-ink">
            <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success text-white">
              <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.5 6.5l2.5 2.5 4.5-6" />
              </svg>
            </span>
            <span className="sentence-case min-w-0 flex-1">{item}</span>
          </li>
        ))}
      </ul>
    </ConsoleCrop>
  );
}

function Delivered() {
  return (
    <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-success-soft text-success">
      <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 6.5l2.5 2.5 4.5-6" />
      </svg>
    </span>
  );
}

/** The outbox: each email as it went out, with its attachment, and its delivery. */
export function OutboxInset({ rows, className }: { readonly rows: readonly OutboxRow[]; readonly className?: string }) {
  return (
    <ConsoleCrop title={VIEW_TEXTS.outbox.title} className={className}>
      <ul className="divide-y divide-mist">
        {rows.map((row) => (
          <li key={row.key} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
            <span className="pt-0.5 font-mono text-2xs tabular-nums text-slate">{row.time}</span>
            <span className="block min-w-0 flex-1 text-xs">
              <span className="block font-semibold text-ink">{row.recipient}</span>
              <span className="block text-slate">{row.subject ?? row.sender}</span>
              {row.attachment ? <span className="mt-0.5 inline-block rounded bg-paper px-1.5 font-mono text-2xs text-navy">{row.attachment}</span> : null}
            </span>
            <Delivered />
          </li>
        ))}
      </ul>
    </ConsoleCrop>
  );
}
