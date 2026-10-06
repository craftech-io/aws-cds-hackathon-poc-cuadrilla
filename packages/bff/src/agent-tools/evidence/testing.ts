// Test support of the `evidence` target (never imported by runtime code): the tool test kit of
// common/testing.ts plus the demo operator's settings, zones and rubrics, a world clock, the scripted
// photo model, objects and orchestrator in memory, and recording fakes of the case opener and the
// outbound pipeline. `sendPhoto` stores a photo the way the inbound channel does (a `Message IN` with
// its media in `Media`) and returns the candidate id of the turn's envelope.
import { CLOCK, ISP } from "../../connector/testing";
import type { IspSettings } from "../../domain/isps";
import type { NewEntity } from "../../domain/common";
import { candidateIdOf } from "../../evidence/candidate";
import type { PhotoAttemptsCaseRequest, PhotoNoticeRequest, VerdictReactionRequest } from "../../evidence/ports";
import { demoZones, fakeNetwork, memoryObjects, scriptedModel, seedRubrics } from "../../evidence/testing";
import { type ToolTestKit, gatewayContext, seedDay, toolTestKit } from "../common/testing";
import type { ToolResponse } from "../common/handler";
import { createEvidenceTarget } from "./index";
import type { EvidenceToolRuntime } from "./runtime";

export const GLOBAL_CAPS = { turnsPerDay: 1000, validationsPerDay: 100, transcribeSecondsPerDay: 3600 };

export function demoSettings(ispId = ISP, clockId = CLOCK, overrides: Partial<NewEntity<typeof IspSettings>> = {}): NewEntity<typeof IspSettings> {
  return {
    ispId,
    clockId,
    quietHours: { start: "21:00", end: "07:00" },
    caseTimeoutSec: 600,
    demoMode: true,
    demoCaseTimeoutSec: 60,
    whatsappMode: "simulated",
    turnCaps: { perHour: 200, perDay: 1000 },
    simulatorCaps: { turnsPerHour: 60, turnsPerDay: 300, validationsPerDay: 100, transcribeSecPerDay: 1800, emailsPerDay: 20, messagesPerRealHourPerIdentity: 20 },
    ...overrides,
  };
}

export interface EvidenceKit extends ToolTestKit {
  readonly model: ReturnType<typeof scriptedModel>;
  readonly objects: ReturnType<typeof memoryObjects>;
  readonly network: ReturnType<typeof fakeNetwork>;
  readonly readings: Map<string, number | undefined>;
  readonly casesOpened: PhotoAttemptsCaseRequest[];
  readonly reactions: VerdictReactionRequest[];
  readonly notices: PhotoNoticeRequest[];
  /** Makes the next case openings or sends fail. */
  readonly failing: { cases: boolean; outbound: boolean };
  readonly evidenceRuntime: EvidenceToolRuntime;
  readonly target: ReturnType<typeof createEvidenceTarget>;
  /** A photo the installer sent on an order: `Message IN` with its media in `Media`; returns its candidate id. */
  sendPhoto(bytes: Uint8Array, options?: { readonly messageId?: string; readonly installerId?: string; readonly workOrderId?: string; readonly clockId?: string; readonly ispId?: string; readonly mime?: string }): Promise<string>;
  /** A Gateway call of the Harness on Rogelio's turn over wo-24817 (or the session overrides). */
  gateway(tool: string, args: Record<string, unknown>, session?: Parameters<ToolTestKit["openSession"]>[0]): Promise<ToolResponse>;
}

/** The demo world of common/testing.ts with what the evidence needs around it. */
export async function evidenceKit(): Promise<EvidenceKit> {
  const kit = toolTestKit();
  await seedDay(kit);
  const { connector } = kit.memory;
  await connector.isps.putSettings(demoSettings());
  for (const zone of demoZones(ISP, CLOCK)) await connector.isps.putZone(zone);
  for (const rubric of seedRubrics()) await connector.reference.put("Rubric", rubric);
  await connector.runtime.createClock({ clockId: CLOCK, ispId: ISP, kind: "DEMO", mode: "PAUSED", offsetMs: 0, pausedSimNow: "2026-10-13T10:30:00-06:00", worldEpoch: 1 });
  const readings = new Map<string, number | undefined>([["DEMO3F2C19A0", -21.4]]);
  const casesOpened: PhotoAttemptsCaseRequest[] = [];
  const reactions: VerdictReactionRequest[] = [];
  const notices: PhotoNoticeRequest[] = [];
  const failing = { cases: false, outbound: false };
  const model = scriptedModel();
  const objects = memoryObjects();
  const network = fakeNetwork(readings);
  const evidenceRuntime: EvidenceToolRuntime = {
    ...kit.runtime,
    photoModel: model,
    objects,
    network,
    capStore: kit.store,
    globalCaps: () => GLOBAL_CAPS,
    cases: {
      async openPhotoAttemptsCase(request) {
        if (failing.cases) throw new Error("ladder down");
        casesOpened.push(request);
        return { caseId: "case-01J9ZQX0000000000000000009", reason: "PHOTO_ATTEMPTS" };
      },
    },
    outbound: {
      async reactToPhoto(request) {
        if (failing.outbound) throw new Error("pipeline down");
        reactions.push(request);
      },
      async photoNotice(request) {
        if (failing.outbound) throw new Error("pipeline down");
        notices.push(request);
      },
    },
  };
  const target = createEvidenceTarget(() => evidenceRuntime);
  let sequence = 0;
  return {
    ...kit,
    model,
    objects,
    network,
    readings,
    casesOpened,
    reactions,
    notices,
    failing,
    evidenceRuntime,
    target,
    async sendPhoto(bytes, options = {}) {
      sequence += 1;
      const messageId = options.messageId ?? `wamid.SIM.photo-${sequence}`;
      const key = `sim/test/${sequence}`;
      objects.media.set(key, bytes);
      const installerId = options.installerId ?? "inst-rogelio";
      await connector.conversations.appendMessage({
        messageId,
        personId: installerId,
        ispId: options.ispId ?? ISP,
        clockId: options.clockId ?? CLOCK,
        direction: "IN",
        channel: "WHATSAPP",
        content: "IMAGE",
        status: "RECEIVED",
        author: `PERSON:${installerId}`,
        simulated: true,
        sentAtSim: `2026-10-13T10:${String(sequence).padStart(2, "0")}:00-06:00`,
        workOrderId: options.workOrderId ?? "wo-24817",
        media: { kind: "IMAGE", s3Key: key, mime: options.mime ?? "image/jpeg", bytes: bytes.length },
      });
      return candidateIdOf(messageId);
    },
    async gateway(tool, args, session) {
      const token = await kit.openSession(session);
      return target.handler({ sessionToken: token, ...args }, gatewayContext(`evidence___${tool}`));
    },
  };
}
