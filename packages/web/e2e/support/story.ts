/// <reference types="node" />
// What the specs of the field-work views find in a world besides the seed (docs/design-brief.md §4, the
// main story at the first visit): written through the connector, the way the worker and the tools leave
// it, so the views read it through the real routers. Order 24817 gets the voice note with its transcript
// and audio, the reply citing §DIAG-02, the step, the label photo rejected for glare, the meter photo the
// validator was unsure about, a decision held by the quiet hours and the turn's internal note; a case can
// be opened on any order. The photos and the audio are the repository's synthetic files. Test-only.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { UiApp } from "../../../../tests/ui-server/app";
import type { CaseReason, Rung } from "@cuadrilla/shared";

const ROOT = join(import.meta.dirname, "../../../..");

/** The ids of a world's copy of the story (`-g07` for the invited guest's world, none for the demo's). */
export interface StoryWorld {
  readonly ispId: string;
  readonly clockId: string;
  /** Suffix of the world's ids: `""` in the demo world, `-g07` in `isp-guest-07`. */
  readonly suffix: string;
}

export const DEMO_WORLD: StoryWorld = { ispId: "isp-demo", clockId: "GLOBAL#isp-demo", suffix: "" };
export const GUEST_07_WORLD: StoryWorld = { ispId: "isp-guest-07", clockId: "GUEST#isp-guest-07", suffix: "-g07" };

export const STORY_TRANSCRIPT = "Ya estoy con la señora Treviño, la ONU no prende la luz PON.";
export const STORY_REPLY = "Revisa que el cordón esté conectado a la roseta y a la ONU y limpia el conector SC/APC (Manual v1, §DIAG-02).";
export const STORY_NOTE = "Guie con el paso de diagnóstico citado y pedí las tres fotos.";

const at = (time: string) => `2026-10-13T${time}:00-06:00`;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface StoryIds {
  readonly workOrderId: string;
  readonly installerId: string;
  readonly voiceMessageId: string;
  readonly labelEvidenceId: string;
  readonly meterEvidenceId: string;
}

async function evidence(app: UiApp, world: StoryWorld, workOrderId: string, item: "ONU_LABEL_PHOTO" | "POWER_READING_PHOTO", photo: string, evidenceId: string, time: string): Promise<void> {
  const bytes = new Uint8Array(await readFile(join(ROOT, "scripts/seed/photos/out", `${photo}.jpg`)));
  const s3Key = `photos/${workOrderId}/${item}/${evidenceId}.jpg`;
  app.ports.objects.put("Evidence", s3Key, bytes, "image/jpeg");
  await app.memory.connector.workOrders.createEvidence({ evidenceId, workOrderId, clockId: world.clockId, worldEpoch: 1, item, sha256: sha256(bytes), s3Key, mime: "image/jpeg", bytes: bytes.length, receivedAtSim: at(time) });
}

/** The first visit of the main story on order 24817 of the world, up to the photos. */
export async function seedOrderStory(app: UiApp, world: StoryWorld): Promise<StoryIds> {
  const data = app.memory.connector;
  const ids: StoryIds = {
    workOrderId: `wo-24817${world.suffix}`,
    installerId: `inst-rogelio${world.suffix}`,
    voiceMessageId: `msg-story-voice${world.suffix}`,
    labelEvidenceId: "ev-01K7S7XRY000000000000000A1",
    meterEvidenceId: "ev-01K7S7XRY000000000000000A2",
  };
  const base = { personId: ids.installerId, ispId: world.ispId, clockId: world.clockId, channel: "WHATSAPP", workOrderId: ids.workOrderId, simulated: true } as const;

  const audio = new Uint8Array(await readFile(join(ROOT, "scripts/seed/audio/vn-01.ogg")));
  const audioKey = `audio/${ids.installerId}/${ids.voiceMessageId}.ogg`;
  app.ports.objects.put("Media", audioKey, audio, "audio/ogg");
  await data.conversations.appendMessage({
    ...base,
    messageId: ids.voiceMessageId,
    direction: "IN",
    content: "VOICE",
    media: { kind: "AUDIO", s3Key: audioKey, mime: "audio/ogg", bytes: audio.length, durationSec: 6 },
    transcript: { text: STORY_TRANSCRIPT, confidence: 0.94 },
    status: "RECEIVED",
    author: `PERSON:${ids.installerId}`,
    sentAtSim: at("09:20"),
  });
  await data.workOrders.appendStep({ workOrderId: ids.workOrderId, clockId: world.clockId, symptom: "NO_PON_LIGHT", stepRef: "DIAG-02", outcome: "FIXED", recordedAtSim: at("09:21") });
  await data.conversations.appendMessage({
    ...base,
    messageId: `msg-story-reply${world.suffix}`,
    direction: "OUT",
    content: "TEXT",
    kind: "REPLY",
    text: STORY_REPLY,
    status: "DELIVERED",
    author: "AGENT",
    policy: { decision: "ALLOW", ruleIds: ["CP-CITATION"] },
    refs: { policy: { form: "TEXT", author: "AGENT", route: "SIMULATED", citations: ["DIAG-02"], inResponseToInbound: true } },
    sentAtSim: at("09:21"),
  });
  await data.conversations.appendTurnNote({ turnId: `turn-story${world.suffix}`, personId: ids.installerId, clockId: world.clockId, workOrderId: ids.workOrderId, trigger: "INSTALLER_MESSAGE", note: STORY_NOTE, agentMode: "REAL", atSim: at("09:22") });

  await evidence(app, world, ids.workOrderId, "ONU_LABEL_PHOTO", "ph-label-02", ids.labelEvidenceId, "09:45");
  await data.workOrders.createValidation({ validationId: "val-01K7S7XRY000000000000000B1", workOrderId: ids.workOrderId, clockId: world.clockId, item: "ONU_LABEL_PHOTO", evidenceId: ids.labelEvidenceId, verdict: "REJECT", modelVerdict: "REJECT", reasonCode: "GLARE", confidence: 0.88, rubricVersion: "v001", source: "SCRIPTED", atSim: at("09:45") });
  await data.workOrders.updateChecklistItem(ids.workOrderId, "ONU_LABEL_PHOTO", { status: "REJECTED", addAttempts: 1, lastRejectReason: "GLARE", evidenceId: ids.labelEvidenceId, updatedAtSim: at("09:45") }, { actor: "AGENT", atSim: at("09:45") });

  await evidence(app, world, ids.workOrderId, "POWER_READING_PHOTO", "ph-meter-15", ids.meterEvidenceId, "09:47");
  await data.workOrders.createValidation({
    validationId: "val-01K7S7XRY000000000000000B2",
    workOrderId: ids.workOrderId,
    clockId: world.clockId,
    item: "POWER_READING_PHOTO",
    evidenceId: ids.meterEvidenceId,
    verdict: "UNSURE",
    modelVerdict: "PASS",
    readings: { readingDbm: -21.4, wavelengthNm: 1490 },
    checks: ["VAL-CONFIDENCE"],
    confidence: 0.41,
    rubricVersion: "v001",
    source: "SCRIPTED",
    atSim: at("09:47"),
  });
  await data.workOrders.updateChecklistItem(ids.workOrderId, "POWER_READING_PHOTO", { status: "IN_REVIEW", evidenceId: ids.meterEvidenceId, updatedAtSim: at("09:47") }, { actor: "AGENT", atSim: at("09:47") });

  await data.audit.append({ ispId: world.ispId, clockId: world.clockId, atSim: at("09:48"), decision: "DEFER", action: "SEND_WHATSAPP", ruleIds: ["CP-QUIET-HOURS"], actor: "AGENT", refs: { workOrderId: ids.workOrderId } });
  return ids;
}

export interface CaseInit {
  readonly caseId: string;
  readonly workOrderNumber: string;
  readonly reason: CaseReason;
  readonly status?: "OPEN" | "TAKEN";
  readonly rung?: Rung;
  readonly installer?: string;
}

/** An open case of the world on one of its orders, notified to the supervisor on shift. */
export async function seedCase(app: UiApp, world: StoryWorld, init: CaseInit): Promise<void> {
  const installerId = `${init.installer ?? "inst-rogelio"}${world.suffix}`;
  const notified = at("11:50");
  await app.memory.connector.cases.createCase({
    caseId: init.caseId,
    ispId: world.ispId,
    clockId: world.clockId,
    workOrderId: `wo-${init.workOrderNumber}${world.suffix}`,
    installerId,
    kind: init.reason === "SAFETY" ? "SAFETY" : "ESCALATION",
    reason: init.reason,
    status: init.status ?? "OPEN",
    rung: init.rung ?? "PRIMARY",
    rungVersion: 0,
    roster: { primaryId: `sup-adriana${world.suffix}`, secondaryId: `sup-hector${world.suffix}`, zoneChiefId: `zc-marisol${world.suffix}` },
    summary: "Potencia fuera de rango después de 3 pasos de diagnóstico.",
    ladder: [{ rung: "PRIMARY", outcome: "NOTIFIED", personId: `sup-adriana${world.suffix}`, channel: "TEMPLATE", atSim: notified }],
    ...(init.status === "TAKEN" ? { takenBy: `sup-hector${world.suffix}` } : {}),
    createdAtSim: notified,
  });
}
