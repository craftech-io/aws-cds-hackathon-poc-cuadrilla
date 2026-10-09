// The detail of a work order (`/app/orders/:workOrderId`, docs/design-brief.md §6; FL-080, FL-044): the
// summary, the closing checklist with the manual validation (supervisors and guests, sign-in of the last
// 15 minutes, reason required), the ONU live from the simulated network, the unified timeline, the
// order's cases and the certificate with its deliveries and download. Everything refreshes with the
// shell's clock poll; every id of the request is fenced by the BFF (an order of another operator or
// world reads as refused or missing, never shown).
import { useState } from "react";
import { Badge } from "../../components/Badge";
import { Callout } from "../../components/Callout";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { Section, SectionNav } from "../../components/Section";
import { usePrincipal } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { Link } from "../../lib/router";
import { dataOf, useAction } from "../../lib/use-remote";
import type { ViewProps } from "../../lib/view-registry";
import { pathOf } from "../../routes";
import { workOrderStatusLabel, workOrderStatusTone } from "../orders/labels";
import { useConsoleApi, useLiveQuery } from "../orders/use-field-data";
import { detailCopy as copy } from "./copy";
import { CertificateLink, DETAIL_PROCEDURES, OrderDetail, Timeline as TimelineSchema, canValidate } from "./order-detail-model";
import { CertificateBlock, Checklist, OnuLive, OrderCases, Summary } from "./sections";
import { Timeline } from "./Timeline";

const SECTION_IDS = { summary: "orden-resumen", checklist: "orden-checklist", onu: "orden-onu", timeline: "orden-linea-de-tiempo", cases: "orden-casos", certificate: "orden-acta" } as const;

function Detail({ workOrderId, order, reload }: { readonly workOrderId: string; readonly order: OrderDetail; readonly reload: () => void }) {
  const { role } = usePrincipal();
  const { tick } = useWorldClock();
  const [notice, setNotice] = useState<string | null>(null);
  const api = useConsoleApi();
  const timeline = useLiveQuery(DETAIL_PROCEDURES.timeline, { workOrderId }, TimelineSchema);
  const download = useAction(async () => {
    const link = await api.query(DETAIL_PROCEDURES.certificateUrl, { workOrderId }, CertificateLink);
    window.location.assign(link.url);
    return link;
  });
  const links = (Object.keys(SECTION_IDS) as (keyof typeof SECTION_IDS)[]).map((key) => ({ id: SECTION_IDS[key], label: copy.sections[key] }));

  return (
    <div className="flex flex-col gap-6">
      <SectionNav label={copy.sectionsNav} links={links} />
      {order.onHoldSafety ? <Callout tone="danger">{copy.onHoldSafety}</Callout> : null}
      <Section id={SECTION_IDS.summary} title={copy.sections.summary}>
        <Summary order={order} />
      </Section>
      <Section id={SECTION_IDS.checklist} title={copy.sections.checklist} description={copy.checklist.description}>
        <Checklist
          order={order}
          canValidate={canValidate(role)}
          notice={notice}
          onChanged={(text) => {
            setNotice(text);
            reload();
          }}
        />
      </Section>
      <Section id={SECTION_IDS.onu} title={copy.sections.onu} description={copy.onu.description}>
        <OnuLive workOrderId={workOrderId} tick={tick} />
      </Section>
      <Section id={SECTION_IDS.timeline} title={copy.sections.timeline} description={copy.timeline.description}>
        <RemoteBlock state={timeline.state} onRetry={timeline.reload}>
          {(data) => <Timeline data={data} installerId={order.installer.personId} />}
        </RemoteBlock>
      </Section>
      <Section id={SECTION_IDS.cases} title={copy.sections.cases} description={copy.cases.description}>
        <OrderCases order={order} />
      </Section>
      <Section id={SECTION_IDS.certificate} title={copy.sections.certificate} description={copy.certificate.description}>
        <CertificateBlock order={order} download={download.state} onDownload={() => void download.run(undefined)} />
        {download.state.status === "error" ? <p className="mt-2 text-sm text-danger">{copy.timeline.mediaFailed}</p> : null}
      </Section>
    </div>
  );
}

export default function OrderDetailView({ params }: ViewProps) {
  const workOrderId = params.workOrderId ?? "";
  const remote = useLiveQuery(DETAIL_PROCEDURES.get, { workOrderId }, OrderDetail, workOrderId !== "");
  const order = dataOf(remote.state);
  return (
    <div>
      <Link to={pathOf("orders")} className="mb-3 inline-block text-sm font-semibold text-cyan-deep underline">
        {copy.back}
      </Link>
      <PageHeader
        title={order ? copy.title(order.workOrderNumber) : copy.fallbackTitle}
        {...(order ? { description: `${order.plan} · ${workOrderStatusLabel[order.status]}` } : {})}
        actions={
          order ? (
            <>
              {order.mainStory ? <Badge tone="brand">{copy.mainStory}</Badge> : null}
              <Badge tone={workOrderStatusTone[order.status]}>{workOrderStatusLabel[order.status]}</Badge>
            </>
          ) : undefined
        }
      />
      <RemoteBlock state={remote.state} onRetry={remote.reload}>
        {(data) => <Detail workOrderId={workOrderId} order={data} reload={remote.reload} />}
      </RemoteBlock>
    </div>
  );
}
