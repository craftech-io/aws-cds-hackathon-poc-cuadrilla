// The 12 orders closed on 12/10 (docs/seed-spec.md §7): per order, its closing checklist, the evidence
// photos with their validations (the historical renders `ph-hist-<nn>` of WP-18, never a photo of the
// set, invariant 21), the rejections behind the installer profiles and the content of the certificate
// without its PDF (invariant 24: the world factory renders it with the brand of the world and fills
// `sha256`). wo-24805 keeps two items the validator was unsure of, validated by hand by the supervisor.
import { PhotoItem } from "@cuadrilla/shared";
import { validatedBy } from "../../../packages/bff/src/copy/es-MX-documents";
import type { PhotoEntry } from "../photos/schema";
import type { SeedItem } from "../lib/tables";
import { staff, zoneOfOrder, type OrderDef } from "./catalog";
import { row, ulidAt } from "./context";
import type { OrderHistoryPhotos } from "./media";
import { closedAt, isClosedHistory, windowOf } from "./orders";
import type { CustomerDef, ProfileEvent } from "./people";
import { addMinutes } from "./time";
import { supervisorUser, type WorldSpec } from "./world";

/** Minutes after the window starts when each photo item was taken (rejected attempts come a few minutes earlier). */
const ITEM_OFFSET_MIN: Readonly<Record<PhotoItem, number>> = { POWER_READING_PHOTO: 40, ONU_LABEL_PHOTO: 55, ROSETTE_PHOTO: 70 };

const OVERRIDE_REASONS: Readonly<Partial<Record<PhotoItem, string>>> = {
  POWER_READING_PHOTO: "Valor y 1490 nm legibles al ampliar la foto; coincide con la lectura del sistema.",
  ROSETTE_PHOTO: "Roseta fijada y conector visible al aclarar la foto.",
};

export interface HistoryOutput {
  readonly items: SeedItem[];
  readonly profileEvents: ProfileEvent[];
  /** Validations per closed order, for the metrics. */
  readonly validations: ReadonlyMap<string, number>;
}

interface Shot {
  readonly photo: PhotoEntry;
  readonly at: string;
  readonly evidenceId: string;
  readonly validationId: string;
}

function readingsOf(photo: PhotoEntry, orderSerial: string): Record<string, unknown> {
  const drawn = photo.drawn;
  if (drawn.template === "meter") return { readingDbm: drawn.readingDbm, wavelengthNm: drawn.wavelengthNm };
  if (drawn.template === "label") return { serial: drawn.serial, serialMatches: drawn.serial === orderSerial };
  return {};
}

function evidenceAndValidation(world: WorldSpec, workOrderId: string, order: OrderDef, shot: Shot): SeedItem[] {
  const { photo } = shot;
  const verdict = photo.expectedVerdict;
  const evidence = row("Evidence", {
    evidenceId: shot.evidenceId,
    workOrderId,
    clockId: world.clockId,
    item: photo.item,
    sha256: photo.sha256,
    s3Key: `photos/${workOrderId}/${photo.item}/${shot.evidenceId}.jpg`,
    mime: "image/jpeg",
    bytes: photo.bytes,
    photoId: photo.photoId,
    receivedAtSim: shot.at,
  });
  const validation = row("PhotoValidation", {
    validationId: shot.validationId,
    workOrderId,
    clockId: world.clockId,
    item: photo.item,
    evidenceId: shot.evidenceId,
    sha256: photo.sha256,
    verdict,
    ...(verdict === "UNSURE" ? {} : { modelVerdict: verdict }),
    ...(photo.expectedReason === null ? {} : { reasonCode: photo.expectedReason }),
    readings: readingsOf(photo, order.serial),
    checks: [],
    confidence: verdict === "UNSURE" ? 0.45 : 0.92,
    rubricVersion: "v001",
    source: "SEED",
    atSim: addMinutes(shot.at, 1),
  });
  return [evidence, validation];
}

function shotsOf(workOrderId: string, order: OrderDef, photos: OrderHistoryPhotos): Map<PhotoItem, { accepted: Shot; rejected: Shot[] }> {
  const start = windowOf(order).startSim;
  const shots = new Map<PhotoItem, { accepted: Shot; rejected: Shot[] }>();
  for (const item of PhotoItem.options) {
    const accepted = photos.accepted.get(item);
    if (accepted === undefined) throw new RangeError(`no accepted historical photo of ${item} for ${workOrderId}`);
    const rejected = photos.rejected.get(item) ?? [];
    const acceptedAt = addMinutes(start, ITEM_OFFSET_MIN[item]);
    const shot = (photo: PhotoEntry, at: string, attempt: number): Shot => ({
      photo,
      at,
      evidenceId: `ev-${ulidAt(at, "evidence", workOrderId, item, attempt)}`,
      validationId: `val-${ulidAt(at, "validation", workOrderId, item, attempt)}`,
    });
    shots.set(item, {
      rejected: rejected.map((photo, index) => shot(photo, addMinutes(acceptedAt, -4 * (rejected.length - index)), index + 1)),
      accepted: shot(accepted, acceptedAt, rejected.length + 1),
    });
  }
  return shots;
}

function checklistItems(world: WorldSpec, workOrderId: string, order: OrderDef, shots: Map<PhotoItem, { accepted: Shot; rejected: Shot[] }>): SeedItem[] {
  const closed = closedAt(order);
  const supervisor = supervisorUser(world);
  const items: SeedItem[] = [row("ChecklistItem", { workOrderId, clockId: world.clockId, item: "ONU_ONLINE", status: "PASSED", attempts: 0, updatedAtSim: addMinutes(closed, -2) })];
  for (const [item, { accepted, rejected }] of shots) {
    const lastReject = rejected.at(-1)?.photo.expectedReason ?? undefined;
    const common = {
      workOrderId,
      clockId: world.clockId,
      item,
      attempts: rejected.length,
      ...(lastReject === undefined ? {} : { lastRejectReason: lastReject }),
      validationId: accepted.validationId,
      evidenceId: accepted.evidenceId,
    };
    if (accepted.photo.expectedVerdict === "PASS") {
      items.push(row("ChecklistItem", { ...common, status: "PASSED", updatedAtSim: addMinutes(accepted.at, 1) }));
      continue;
    }
    const at = addMinutes(closed, -20);
    const reason = OVERRIDE_REASONS[item] ?? "Evidencia revisada y validada en la consola.";
    const actor = `USER:${supervisor.userId}`;
    items.push(
      row("ChecklistItem", {
        ...common,
        status: "OVERRIDDEN",
        override: { userId: supervisor.userId, reason, atSim: at },
        updatedAtSim: at,
        history: [
          { field: "status", from: "PENDING", to: "IN_REVIEW", atSim: addMinutes(accepted.at, 1), atReal: addMinutes(accepted.at, 1), actor: "SYSTEM", reason: "UNSURE" },
          { field: "status", from: "IN_REVIEW", to: "OVERRIDDEN", atSim: at, atReal: at, actor, reason },
        ],
      }),
    );
  }
  items.push(row("ChecklistItem", { workOrderId, clockId: world.clockId, item: "CUSTOMER_OK", status: "PASSED", attempts: 0, updatedAtSim: addMinutes(closed, -8) }));
  return items;
}

/** What the certificate shows (docs/architecture.md §11), without the operator: the factory adds the brand. */
function certificateItem(world: WorldSpec, workOrderId: string, order: OrderDef, customer: CustomerDef, shots: Map<PhotoItem, { accepted: Shot; rejected: Shot[] }>): SeedItem {
  const installer = staff(order.installerId);
  const zone = zoneOfOrder(order);
  const closed = closedAt(order);
  const supervisor = supervisorUser(world);
  const photoItems = [...shots].map(([item, { accepted }]) => {
    const manual = accepted.photo.expectedVerdict !== "PASS";
    return {
      item,
      status: manual ? "OVERRIDDEN" : "PASSED",
      validatedBy: manual
        ? validatedBy({ by: "PERSON", name: supervisor.name, reason: OVERRIDE_REASONS[item] ?? "Evidencia revisada y validada en la consola." })
        : validatedBy({ by: "VALIDATOR" }),
      evidenceId: accepted.evidenceId,
      photoId: accepted.photo.photoId,
      sha256: accepted.photo.sha256,
    };
  });
  const delivered = addMinutes(closed, 2);
  return row("Certificate", {
    workOrderId,
    clockId: world.clockId,
    certificateId: `cert-${workOrderId}-1`,
    n: 1,
    issuedAtSim: closed,
    content: {
      workOrderNumber: order.number,
      closedAtSim: closed,
      installerName: `${installer.firstName} ${installer.lastName}`,
      customer: { firstName: customer.firstName, addressLine: customer.addressLine, neighborhood: customer.neighborhood },
      plan: order.plan,
      onuSerial: order.serial,
      rxPowerDbm: order.rxDbm,
      opticalClass: zone.opticalClass,
      acceptanceRange: { ...zone.acceptanceRange },
      items: [{ item: "ONU_ONLINE", status: "PASSED" }, ...photoItems.map(({ item, status, validatedBy: by }) => ({ item, status, validatedBy: by })), { item: "CUSTOMER_OK", status: "PASSED" }],
      photos: photoItems.map(({ item, evidenceId, photoId, sha256 }) => ({ item, evidenceId, photoId, sha256 })),
    },
    deliveries: [
      { to: "CUSTOMER", channel: "EMAIL", status: "DELIVERED", updatedAtSim: delivered, detail: "historical delivery of 12/10 (seed)" },
      { to: "OPS_MAILBOX", channel: "EMAIL", status: "DELIVERED", updatedAtSim: delivered, detail: "historical delivery of 12/10 (seed)" },
      { to: "INSTALLER", channel: "WHATSAPP", status: "DELIVERED", updatedAtSim: delivered, detail: "historical delivery of 12/10 (seed)" },
    ],
  });
}

export function historyItems(world: WorldSpec, photosByOrder: ReadonlyMap<string, OrderHistoryPhotos>, customers: ReadonlyMap<number, CustomerDef>): HistoryOutput {
  const items: SeedItem[] = [];
  const profileEvents: ProfileEvent[] = [];
  const validations = new Map<string, number>();
  for (const order of world.orders.filter(isClosedHistory)) {
    const workOrderId = world.workOrderId(order.number);
    const photos = photosByOrder.get(order.number);
    const customer = customers.get(order.customer);
    if (photos === undefined || customer === undefined) throw new RangeError(`missing photos or customer of ${workOrderId}`);
    const shots = shotsOf(workOrderId, order, photos);
    for (const { accepted, rejected } of shots.values()) {
      for (const shot of [...rejected, accepted]) items.push(...evidenceAndValidation(world, workOrderId, order, shot));
      for (const shot of rejected) {
        profileEvents.push({ installerId: world.personId(order.installerId), code: shot.photo.expectedReason ?? "UNREADABLE", atSim: addMinutes(shot.at, 1), workOrderId });
      }
    }
    validations.set(workOrderId, [...shots.values()].reduce((total, { rejected }) => total + rejected.length + 1, 0));
    items.push(...checklistItems(world, workOrderId, order, shots), certificateItem(world, workOrderId, order, customer, shots));
  }
  return { items, profileEvents, validations };
}

/** Manual validations of the history, as audit decisions of the supervisor's console actions. */
export function overrideDecisions(items: readonly SeedItem[], ispId: string): SeedItem[] {
  return items
    .filter((item) => item.entity === "ChecklistItem" && item.status === "OVERRIDDEN")
    .map((item) => {
      const override = item.override as { userId: string; reason: string; atSim: string };
      return row("Decision", {
        decisionId: ulidAt(override.atSim, "override", String(item.workOrderId), String(item.item)),
        ispId,
        clockId: item.clockId,
        ts: override.atSim,
        atSim: override.atSim,
        atReal: override.atSim,
        decision: "ACTION",
        action: "EVIDENCE_OVERRIDDEN",
        actor: `USER:${override.userId}`,
        refs: { workOrderId: item.workOrderId },
        reason: "manual validation (12/10 history)",
        detail: { item: item.item },
      });
    });
}
