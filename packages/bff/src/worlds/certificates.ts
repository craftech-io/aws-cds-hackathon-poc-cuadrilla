// The historical certificates of a world (docs/seed-spec.md §7, "Actas históricas"): no PDF of the seed
// is committed; the seed keeps each certificate's content (`WorkOrders/CERT.content`, without the
// operator) and the factory renders its PDF with the world's brand through the certificate writer
// (certificates/writer.ts `renderStoredCertificate`), with the photos of `Seed/photos/<photoId>.jpg`,
// and records its `sha256` and key. A brand change renders them all again (worlds/brand.ts), so no
// certificate ever carries another name than its world's.
//
// It writes `Evidence/[guest/<seg>/]certificates/…`: `seed:load` runs it with the operator's
// credentials; a function without that write leaves them `pdfPending` until the next load.
import { daysOfSpan, HISTORY_DAYS } from "../clock/world-items";
import type { Connector } from "../connector/ports";
import type { Certificate } from "../domain/work-orders";
import { certificateBrand } from "../certificates/render";
import type { CertificateObjects } from "../certificates/store";
import { renderStoredCertificate } from "../certificates/writer";
import type { Logger } from "../lib/log";
import type { BrandConfigValue } from "../lib/secret-schemas";

export type RenderScope = "PENDING" | "ALL";

export interface WorldRef {
  readonly clockId: string;
  readonly ispId: string;
}

export interface HistoricalCertificates {
  /** Renders the certificates of the world's orders: the pending ones, or all of them; how many. */
  render(world: WorldRef, scope: RenderScope): Promise<number>;
}

export interface CertificateRenderDeps {
  readonly connector: Pick<Connector, "workOrders" | "isps" | "runtime">;
  readonly objects: Pick<CertificateObjects, "putPdf">;
  /** Bytes of a photo of the catalog (`Seed/photos/<photoId>.jpg`); `undefined` leaves it out. */
  readonly photo: (photoId: string) => Promise<Uint8Array | undefined>;
  readonly brand: () => BrandConfigValue | undefined;
  readonly logger: Logger;
}

/** Simulated days after the start whose orders may have a certificate already. */
const DAYS_AHEAD = 4;

/** The certificates of a world, found from its orders of the history and the days around its start. */
export async function worldCertificates(connector: Pick<Connector, "workOrders" | "runtime">, world: WorldRef): Promise<Certificate[]> {
  const clock = await connector.runtime.getClock(world.clockId);
  if (clock === undefined) return [];
  const startSim = typeof clock.settings?.startAtSim === "string" ? clock.settings.startAtSim : clock.pausedSimNow;
  const from = new Date(Date.parse(startSim) - HISTORY_DAYS * 86_400_000).toISOString();
  const to = new Date(Date.parse(startSim) + DAYS_AHEAD * 86_400_000).toISOString();
  const certificates: Certificate[] = [];
  const seen = new Set<string>();
  for (const day of daysOfSpan(from, to)) {
    for (const order of await connector.workOrders.listIspDay(world.ispId, day)) {
      if (order.clockId !== world.clockId || seen.has(order.workOrderId)) continue;
      seen.add(order.workOrderId);
      const certificate = await connector.workOrders.getCertificate(order.workOrderId);
      if (certificate?.content !== undefined) certificates.push(certificate);
    }
  }
  return certificates;
}

export function historicalCertificates(deps: CertificateRenderDeps): HistoricalCertificates {
  return {
    async render(world, scope) {
      const isp = await deps.connector.isps.getIsp(world.ispId);
      const brand = certificateBrand(isp, deps.brand());
      let rendered = 0;
      for (const certificate of await worldCertificates(deps.connector, world)) {
        if (scope === "PENDING" && certificate.pdfPending !== true) continue;
        await renderStoredCertificate(
          {
            connector: deps.connector,
            objects: deps.objects,
            photo: async (photo) => (photo.photoId === undefined ? undefined : deps.photo(photo.photoId)),
            brand,
            logger: deps.logger,
          },
          certificate,
        );
        rendered += 1;
      }
      deps.logger.info("worlds.certificates_rendered", { clockId: world.clockId, scope, rendered, brandMode: brand.mode });
      return rendered;
    },
  };
}
