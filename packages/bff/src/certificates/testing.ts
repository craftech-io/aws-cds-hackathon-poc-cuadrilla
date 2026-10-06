// Test support for the certificate (never imported by runtime code): order 24817 of the demo world
// (docs/seed-spec.md) ready to close, over the SES test world of channels/email/testing.ts, with the
// three validated photos of the synthetic set (`scripts/seed/photos/out/`), an in-memory `Evidence`
// bucket shared with the SES client, a scripted G3, timers in memory and a `CertificateSender` that
// decides with the real contact policy (policy/) and sends emails with the real SES client.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ToolError, type PhotoItem } from "@cuadrilla/shared";
import { evidencePhotoKey } from "@cuadrilla/shared/media/keys";
import type { ArmTimerRequest, TimerPort } from "../agent-tools/common/ports";
import { CUSTOMER, OPS_MAILBOX, emailWorld } from "../channels/email/testing";
import { CLOCK, EV_1, EV_2, ISP, installer, workOrder } from "../connector/testing";
import { DEFAULT_OPERATOR_NAME } from "../copy/brand";
import type { Timer } from "../domain/timers";
import { sha256Hex } from "../lib/crypto";
import { createLogger } from "../lib/log";
import { evaluateAt } from "../policy/as-of";
import type { PolicyDecision } from "../policy/engine";
import { loadPolicyRecords } from "../policy/records";
import type { G3Outcome, G3Port } from "./g3";
import type { CertificateSend, CertificateSendOutcome, CertificateSender } from "./sender";
import type { CertificateObjects } from "./store";
import type { WriterDeps } from "./writer";

export const EV_3 = "ev-01J9ZQX0000000000000000002";
export const VAL = { POWER_READING_PHOTO: "val-01J9ZQX0000000000000000010", ONU_LABEL_PHOTO: "val-01J9ZQX0000000000000000011", ROSETTE_PHOTO: "val-01J9ZQX0000000000000000012" } as const;
export const SEED_PHOTOS: Readonly<Record<PhotoItem, { readonly photoId: string; readonly evidenceId: string }>> = {
  POWER_READING_PHOTO: { photoId: "ph-meter-01", evidenceId: EV_1 },
  ONU_LABEL_PHOTO: { photoId: "ph-label-01", evidenceId: EV_2 },
  ROSETTE_PHOTO: { photoId: "ph-rosette-02", evidenceId: EV_3 },
};
/** CURP-shaped value (body of the seed's synthetic one, docs/seed-spec.md) and the customer's contacts. */
export const CURP = "SEPN000101MNESPR03";
export const CUSTOMER_PHONE = "+525509010421";
export const CLOSED_AT = "2026-10-13T16:05:00.000Z";
export const SUPERVISOR_USER = "usr-adriana";

/** "2026-10-13 10:05" in Mexico City as an ISO instant (UTC−6). */
export function mx(local: string): string {
  return new Date(`${local.replace(" ", "T")}:00-06:00`).toISOString();
}

export function seedPhoto(photoId: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../../scripts/seed/photos/out/${photoId}.jpg`, import.meta.url))));
}

export type CertWorld = Awaited<ReturnType<typeof emailWorld>>;

export interface ClosableOptions {
  /** The rosette validated by hand by the supervisor, with this reason. */
  readonly overrideReason?: string;
  readonly addressLine?: string;
  readonly opsMailbox?: string | null;
  readonly displayName?: string;
  readonly lastInboundAtSim?: string;
}

/** Order 24817 IN_PROGRESS with its five items done, its three photos stored and the ONU read in range. */
export async function seedClosableOrder(world: CertWorld, options: ClosableOptions = {}): Promise<void> {
  const { isps, people, workOrders } = world.connector;
  await isps.putIsp({ ispId: ISP, kind: "DEMO", clockId: CLOCK, displayName: options.displayName ?? DEFAULT_OPERATOR_NAME, ...(options.opsMailbox === null ? {} : { opsMailbox: options.opsMailbox ?? OPS_MAILBOX }) });
  await isps.updateSettings(ISP, { templateStatus: { acta_instalacion: "APPROVED" } });
  await isps.putZone({ ispId: ISP, clockId: CLOCK, zoneId: "zone-norte", name: "Norte", opticalClass: "B+", acceptanceRange: { minDbm: -27, maxDbm: -8 }, zoneChiefId: "zc-marisol" });
  await isps.putUser({ ispId: ISP, userId: SUPERVISOR_USER, role: "SUPERVISOR", name: "Adriana Robles" });
  await people.createPerson(installer(options.lastInboundAtSim === undefined ? {} : { lastInboundAtSim: options.lastInboundAtSim }));
  await people.grantConsent({ personId: "inst-rogelio", clockId: CLOCK, medium: "SEED", textVersion: "v001" }, { actor: "SEED", atSim: mx("2026-10-01 08:00") });
  await people.putCustomer({
    customerId: "cust-10421",
    ispId: ISP,
    clockId: CLOCK,
    firstName: "Lucía",
    lastName: "Treviño",
    addressLine: options.addressLine ?? "Calle Jacaranda 214",
    neighborhood: "Las Lomitas",
    phone: CUSTOMER_PHONE,
    email: CUSTOMER,
    note: `Titular confirmó sus datos por teléfono; CURP registrada en el alta: ${CURP}. Tel. ${CUSTOMER_PHONE}`,
  });
  await workOrders.createWorkOrder(
    workOrder({ status: "IN_PROGRESS", lastOnuReading: { operState: "ONLINE", rxPowerDbm: -21.4, inRange: true, observedAtSim: mx("2026-10-13 10:00"), source: "AGENT" } }),
  );
  const done = { actor: "AGENT" as const, atSim: mx("2026-10-13 10:00") };
  await workOrders.updateChecklistItem("wo-24817", "ONU_ONLINE", { status: "PASSED", updatedAtSim: mx("2026-10-13 09:55") }, done);
  await workOrders.updateChecklistItem("wo-24817", "CUSTOMER_OK", { status: "PASSED", updatedAtSim: mx("2026-10-13 10:03") }, done);
  for (const [item, { photoId, evidenceId }] of Object.entries(SEED_PHOTOS) as Array<[PhotoItem, (typeof SEED_PHOTOS)[PhotoItem]]>) {
    const bytes = seedPhoto(photoId);
    const s3Key = evidencePhotoKey(CLOCK, 1, "wo-24817", item, evidenceId);
    world.objects.set(s3Key, bytes);
    await workOrders.createEvidence({ evidenceId, workOrderId: "wo-24817", clockId: CLOCK, worldEpoch: 1, item, sha256: sha256Hex(bytes), s3Key, mime: "image/jpeg", bytes: bytes.byteLength, receivedAtSim: mx("2026-10-13 09:40") });
    const manual = item === "ROSETTE_PHOTO" && options.overrideReason !== undefined;
    await workOrders.updateChecklistItem(
      "wo-24817",
      item,
      manual
        ? { status: "OVERRIDDEN", evidenceId, override: { userId: SUPERVISOR_USER, reason: options.overrideReason ?? "", atSim: mx("2026-10-13 09:58") }, updatedAtSim: mx("2026-10-13 09:58") }
        : { status: "PASSED", evidenceId, validationId: VAL[item], updatedAtSim: mx("2026-10-13 09:45") },
      done,
    );
  }
}

/** The `Evidence` bucket in memory: the same map the SES client attaches the PDF from. */
export function memoryObjects(objects: Map<string, Uint8Array>): CertificateObjects & { readonly puts: string[] } {
  const puts: string[] = [];
  return {
    puts,
    async readPhoto(key) {
      const bytes = objects.get(key);
      if (bytes === undefined) throw new Error(`no object ${key}`);
      return bytes;
    },
    async putPdf(key, bytes) {
      puts.push(key);
      objects.set(key, bytes);
    },
  };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /\+?\d[\d .-]{8,}\d/g;

/** G3 as a test sees it: anonymizes emails and phones like the managed entities, or blocks everything. */
export function scriptedG3(mode: "ANONYMIZE" | "BLOCK" = "ANONYMIZE"): G3Port & { readonly calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async apply(texts): Promise<G3Outcome> {
      calls.push([...texts]);
      if (mode === "BLOCK") return { action: "BLOCKED", entities: ["CREDIT_DEBIT_CARD_NUMBER"] };
      const out = texts.map((text) => text.replace(EMAIL, "{EMAIL}").replace(PHONE, "{PHONE}"));
      return { action: out.some((text, index) => text !== texts[index]) ? "ANONYMIZED" : "NONE", texts: out };
    },
  };
}

export function testLogger(lines: string[] = []) {
  return createLogger({ level: "debug", sink: (line) => lines.push(line) });
}

export function writerDeps(world: CertWorld, overrides: Partial<WriterDeps> = {}): WriterDeps & { readonly objects: ReturnType<typeof memoryObjects> } {
  return { connector: world.connector, objects: memoryObjects(world.objects), g3: scriptedG3(), brand: () => undefined, logger: testLogger(world.lines), ...overrides } as WriterDeps & {
    readonly objects: ReturnType<typeof memoryObjects>;
  };
}

/** Timers in memory: arming the same timer twice returns the first (TimerPort's contract). */
export function memoryTimers(): Pick<TimerPort, "arm"> & { readonly armed: ArmTimerRequest[] } {
  const armed: ArmTimerRequest[] = [];
  return {
    armed,
    async arm(request) {
      const existing = armed.find((timer) => timer.timerId === request.timerId && timer.kind === request.kind);
      if (existing === undefined) armed.push(request);
      const kept = existing ?? request;
      return { ...kept, status: "SCHEDULED", payload: kept.payload ?? {}, entity: "Timer", createdAt: CLOSED_AT, updatedAt: CLOSED_AT, version: 1, synthetic: false } as Timer;
    },
  };
}

export interface SentRecord {
  readonly send: CertificateSend;
  readonly decision?: PolicyDecision;
  readonly outcome: CertificateSendOutcome;
}

/**
 * A `CertificateSender` that decides a WhatsApp send with the real contact policy over the world's
 * records (synthetic identity, the world's clock) and sends an email with the real SES client (fence,
 * outbox, attachment checked against its `sha256`). `failNext` makes the next sends fail transiently.
 */
export function policySender(world: CertWorld, realNow: string): CertificateSender & { readonly sent: SentRecord[]; failNext: number } {
  const state = { sent: [] as SentRecord[], failNext: 0 };
  const sender = {
    get sent() {
      return state.sent;
    },
    get failNext() {
      return state.failNext;
    },
    set failNext(value: number) {
      state.failNext = value;
    },
    async send(send: CertificateSend): Promise<CertificateSendOutcome> {
      if (state.failNext > 0) {
        state.failNext -= 1;
        const outcome: CertificateSendOutcome = { status: "FAILED", retryable: true, reason: "ThrottlingException" };
        state.sent.push({ send, outcome });
        return outcome;
      }
      if (send.channel === "EMAIL") {
        const result = await world.client.send({ clockId: send.clockId, kind: send.kind, toRole: send.toRole, to: send.to, subject: send.subject, bodyText: send.bodyText, workOrderId: send.workOrderId, attachment: send.attachment, sentAtSim: send.sentAtSim, mailId: send.mailId, actor: "SYSTEM" });
        const outcome: CertificateSendOutcome = result.ok ? { status: "SENT", mailId: result.mailId } : { status: "DENIED", ruleIds: [], reason: result.reason };
        state.sent.push({ send, outcome });
        return outcome;
      }
      const at = { sim: send.sentAtSim, real: realNow };
      const records = await loadPolicyRecords(world.connector, { ispId: send.ispId, personId: send.personId, route: "SIMULATED", workOrderId: send.workOrderId, certificate: true, at });
      const message = { kind: "CERTIFICATE" as const, channel: "WHATSAPP" as const, form: send.form, author: "SYSTEM" as const, workOrderId: send.workOrderId, attachmentSha256: send.document.sha256, inResponseToInbound: send.inResponseToInbound, ...(send.templateName === undefined ? {} : { templateName: send.templateName }) };
      const decision = evaluateAt(message, { kind: "PERSON", route: "SIMULATED" }, records, at);
      const outcome: CertificateSendOutcome = decision.allowed ? { status: "SENT", messageId: `msg-${send.idempotencyKey}` } : decision.outcome === "DEFER" ? { status: "DEFERRED", ...(decision.nextAllowedAt === undefined ? {} : { nextAllowedAt: decision.nextAllowedAt }) } : { status: "DENIED", ruleIds: [...decision.ruleIds] };
      state.sent.push({ send, decision, outcome });
      return outcome;
    },
  };
  return sender;
}

/** Throws unless `fn` rejects with a `ToolError` of `code`. */
export async function toolErrorOf(fn: () => Promise<unknown>): Promise<ToolError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error("expected a ToolError");
}

export interface PdfReading {
  readonly text: string;
  readonly pages: number;
  /** Images painted on the pages (pdf.js `paintImageXObject` operations). */
  readonly images: number;
  readonly info: Readonly<Record<string, unknown>>;
}

/** What a reader sees in the PDF: its text, pages, painted images and information dictionary (unpdf / pdf.js). */
export async function readPdf(bytes: Uint8Array): Promise<PdfReading> {
  const { extractText, getDocumentProxy, getMeta, getResolvedPDFJS } = await import("unpdf");
  const { OPS } = await getResolvedPDFJS();
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  const meta = await getMeta(pdf);
  let images = 0;
  for (let page = 1; page <= pdf.numPages; page += 1) {
    const operators = await (await pdf.getPage(page)).getOperatorList();
    images += operators.fnArray.filter((fn) => fn === OPS.paintImageXObject).length;
  }
  return { text, pages: pdf.numPages, images, info: (meta.info ?? {}) as Record<string, unknown> };
}
