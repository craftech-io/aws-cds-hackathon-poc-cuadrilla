import { describe, expect, it } from "vitest";
import type { ApiError } from "../../lib/api-error";
import { simulatorCopy } from "./copy";
import type { Bubble, SimIdentity } from "./simulator-api";
import {
  byDay,
  capNoticeOf,
  defaultIdentity,
  durationText,
  isTyping,
  nameOf,
  phoneItems,
  photoExpectation,
  photoLabel,
  photoProblem,
  textOf,
  ticksOf,
  timeOf,
  unreadCount,
  voiceLabel,
} from "./simulator-model";

const WEEKDAYS = { MON: "lun", TUE: "mar", WED: "mié", THU: "jue", FRI: "vie", SAT: "sáb", SUN: "dom" } as const;

function bubble(overrides: Partial<Bubble> & Pick<Bubble, "messageId">): Bubble {
  return {
    direction: "OUT",
    content: "TEXT",
    kind: "REPLY",
    text: "Hola",
    templateName: null,
    buttons: [],
    buttonAction: null,
    mediaKind: null,
    mediaUrl: null,
    fileName: null,
    reaction: null,
    status: "DELIVERED",
    sentAtSim: "2026-10-13T09:20:00-06:00",
    providerMessageId: null,
    ...overrides,
  };
}

function person(identity: string, firstName: string | null, role: SimIdentity["role"] = "INSTALLER"): SimIdentity {
  return { identity, firstName, lastName: firstName === null ? null : "Méndez", role, active: true };
}

function apiError(overrides: Partial<ApiError>): ApiError {
  return { kind: "unavailable", code: "TOO_MANY_REQUESTS", httpStatus: 429, reason: null, correlationId: null, message: "", ...overrides };
}

describe("phone simulator model [FL-082]", () => {
  const identities = [person("inst-karina-g07", "Karina"), person("inst-rogelio-g07", "Rogelio"), person("sup-adriana-g07", "Adriana", "SUPERVISOR"), person("UNKNOWN", null, null)];

  it("[FL-082] opens as the identity asked for (by id or by the story's party), else the story's installer, else the first person", () => {
    expect(defaultIdentity(identities, "sup-adriana-g07")).toBe("sup-adriana-g07");
    expect(defaultIdentity(identities, "sup-adriana")).toBe("sup-adriana-g07");
    expect(defaultIdentity(identities, "UNKNOWN")).toBe("UNKNOWN");
    expect(defaultIdentity(identities, "nobody")).toBe("inst-rogelio-g07");
    expect(defaultIdentity(identities, null)).toBe("inst-rogelio-g07");
    expect(defaultIdentity([person("inst-karina-g07", "Karina"), person("UNKNOWN", null, null)], null)).toBe("inst-karina-g07");
    expect(defaultIdentity([], null)).toBe("UNKNOWN");
    expect(nameOf(identities[1])).toBe("Rogelio Méndez");
    expect(nameOf(identities[3])).toBe(simulatorCopy.identity.unknown);
  });

  it("[FL-082] shows only what reached the phone, oldest first, with each reaction on the bubble it reacts to", () => {
    const items = phoneItems([
      bubble({ messageId: "m3", direction: "OUT", content: "REACTION", text: "🔁", reaction: { emoji: "🔁", to: "wamid.photo" }, sentAtSim: "2026-10-13T09:41:00-06:00" }),
      bubble({ messageId: "m2", direction: "IN", content: "IMAGE", text: null, mediaKind: "IMAGE", mediaUrl: "https://x/photo", status: "READ", providerMessageId: "wamid.photo", sentAtSim: "2026-10-13T09:40:00-06:00" }),
      bubble({ messageId: "m1", direction: "OUT", text: "Antes", sentAtSim: "2026-10-13T09:39:00-06:00" }),
      bubble({ messageId: "m4", direction: "OUT", text: "Retenido", status: "DEFERRED", sentAtSim: "2026-10-13T09:42:00-06:00" }),
      bubble({ messageId: "m5", direction: "OUT", text: "Negado", status: "DENIED", sentAtSim: "2026-10-13T09:42:00-06:00" }),
      bubble({ messageId: "m6", direction: "OUT", content: "READ_ACK", text: null, sentAtSim: "2026-10-13T09:40:01-06:00" }),
      bubble({ messageId: "m7", direction: "OUT", content: "REACTION", reaction: { emoji: "✅", to: "wamid.photo" }, status: "DENIED", sentAtSim: "2026-10-13T09:43:00-06:00" }),
    ]);
    expect(items.map((item) => item.bubble.messageId)).toEqual(["m1", "m2"]);
    expect(items[1]?.reactions).toEqual(["🔁"]);
    expect(items[0]?.reactions).toEqual([]);
  });

  it("[FL-082] within one simulated minute (a paused clock) the reply goes below the installer's message", () => {
    const items = phoneItems([
      bubble({ messageId: "a-reply", direction: "OUT", text: "Va", sentAtSim: "2026-10-13T09:40:00-06:00", sentAtReal: "2026-10-25T12:00:09.000Z" }),
      bubble({ messageId: "wamid.SIM.z", direction: "IN", text: "¿Qué sigue?", status: "READ", sentAtSim: "2026-10-13T09:40:00-06:00", sentAtReal: "2026-10-25T12:00:01.000Z" }),
    ]);
    expect(items.map((item) => item.bubble.messageId)).toEqual(["wamid.SIM.z", "a-reply"]);
  });

  it("[FL-082] groups by simulated day and tells the hour in the world's own time", () => {
    const items = phoneItems([
      bubble({ messageId: "a", sentAtSim: "2026-10-12T07:30:00-06:00" }),
      bubble({ messageId: "b", sentAtSim: "2026-10-13T09:20:00-06:00" }),
      bubble({ messageId: "c", sentAtSim: "2026-10-13T09:21:00-06:00" }),
    ]);
    expect(byDay(items, WEEKDAYS).map((group) => [group.day, group.items.length])).toEqual([
      ["lun 12/10", 1],
      ["mar 13/10", 2],
    ]);
    expect(timeOf({ sentAtSim: "2026-10-13T09:20:00-06:00" })).toBe("09:20");
  });

  it("[FL-102] ticks: ✓ sent, ✓✓ delivered, ✓✓ highlighted once read, ! failed; the person's own message ✓✓ and highlighted once Cuadrilla read it", () => {
    expect(ticksOf({ direction: "OUT", status: "SENT" })).toMatchObject({ symbol: "✓", read: false });
    expect(ticksOf({ direction: "OUT", status: "DELIVERED" })).toMatchObject({ symbol: "✓✓", read: false });
    expect(ticksOf({ direction: "OUT", status: "READ" })).toMatchObject({ symbol: "✓✓", read: true });
    expect(ticksOf({ direction: "OUT", status: "FAILED" })).toMatchObject({ symbol: "!" });
    expect(ticksOf({ direction: "OUT", status: "QUEUED" })).toBeUndefined();
    expect(ticksOf({ direction: "IN", status: "RECEIVED" })).toEqual({ symbol: "✓✓", read: false, label: simulatorCopy.ticks.RECEIVED });
    expect(ticksOf({ direction: "IN", status: "READ" })).toEqual({ symbol: "✓✓", read: true, label: simulatorCopy.ticks.READ_BY_CUADRILLA });
  });

  it("[FL-102] 'El agente está escribiendo…' only after a message Cuadrilla read, unanswered, while the world works on it", () => {
    const read = phoneItems([bubble({ messageId: "in", direction: "IN", status: "READ" })]);
    const turn = [{ kind: "TURN" as const, sinceReal: "2026-10-20T15:00:00.000Z" }];
    expect(isTyping(read, true, turn)).toBe(true);
    expect(isTyping(read, false, [])).toBe(false);
    expect(isTyping(read, true, [{ kind: "MAIL" as const, sinceReal: "2026-10-20T15:00:00.000Z" }])).toBe(false);
    expect(isTyping(phoneItems([bubble({ messageId: "in", direction: "IN", status: "RECEIVED" })]), true, turn)).toBe(false);
    const answered = phoneItems([bubble({ messageId: "in", direction: "IN", status: "READ" }), bubble({ messageId: "out", sentAtSim: "2026-10-13T09:21:00-06:00" })]);
    expect(isTyping(answered, true, turn)).toBe(false);
    expect(isTyping([], true, turn)).toBe(false);
  });

  it("[FL-082] a tapped button reads as its label; unread messages of Cuadrilla are counted for 'Marcar como leídos'", () => {
    expect(textOf({ text: null, buttonAction: "VIEW_ORDERS", direction: "IN" })).toBe("Ver órdenes");
    expect(textOf({ text: "Hola", buttonAction: null, direction: "IN" })).toBe("Hola");
    expect(textOf({ text: null, buttonAction: null, direction: "OUT" })).toBeNull();
    const items = phoneItems([bubble({ messageId: "a", status: "SENT" }), bubble({ messageId: "b", status: "DELIVERED" }), bubble({ messageId: "c", status: "READ" }), bubble({ messageId: "d", direction: "IN", status: "RECEIVED" })]);
    expect(unreadCount(items)).toBe(2);
  });

  it("[FL-082] the synthetic set is named by family and number with the expected outcome, never by its id", () => {
    expect(photoLabel({ photoId: "ph-meter-03" })).toBe("Medidor 03");
    expect(photoLabel({ photoId: "ph-label-12" })).toBe("Etiqueta de la ONU 12");
    expect(photoLabel({ photoId: "ph-whatever-01" })).toBe("Foto 01");
    expect(photoExpectation({ expectedVerdict: "PASS", expectedReason: null })).toBe(simulatorCopy.photos.pass);
    expect(photoExpectation({ expectedVerdict: "REJECT", expectedReason: "GLARE" })).toBe("se espera rechazo: con reflejo");
    expect(photoExpectation({ expectedVerdict: "UNSURE", expectedReason: null })).toBe(simulatorCopy.photos.unsure);
    expect(voiceLabel({ durationSec: 3.188 }, 0)).toBe("Nota 1 · 0:03");
    expect(durationText(65)).toBe("1:05");
    for (const label of [photoLabel({ photoId: "ph-adv-04" }), voiceLabel({ durationSec: 12 }, 9)]) expect(label).not.toMatch(/\b(?:ph|vn)-/);
  });

  it("[FL-082] only a JPEG of at most 3.5 MB is uploaded", () => {
    expect(photoProblem({ type: "image/jpeg", size: 1000, name: "a.jpg" })).toBeUndefined();
    expect(photoProblem({ type: "", size: 1000, name: "a.JPEG" })).toBeUndefined();
    expect(photoProblem({ type: "image/png", size: 1000, name: "a.png" })).toBe("notJpeg");
    expect(photoProblem({ type: "image/jpeg", size: 0, name: "a.jpg" })).toBe("empty");
    expect(photoProblem({ type: "image/jpeg", size: 3.5 * 1024 * 1024 + 1, name: "a.jpg" })).toBe("tooLarge");
    expect(photoProblem({ type: "image/jpeg", size: 3.5 * 1024 * 1024, name: "a.jpg" })).toBeUndefined();
  });
});

describe("phone simulator caps [FL-083]", () => {
  it("[FL-083] a cap says which one and when it frees; the paused simulator says so; any other error is not a cap", () => {
    const rate = capNoticeOf(apiError({ reason: "RATE_LIMIT", message: "at most 80 messages per hour from one identity, until 2026-10-20T16:00:00.000Z" }));
    expect(rate).toEqual({ text: simulatorCopy.caps.reasons.RATE_LIMIT, untilIso: "2026-10-20T16:00:00.000Z" });
    expect(capNoticeOf(apiError({ reason: "SIMULATOR", message: "the turns cap is reached until 2026-10-21T00:00:00Z" }))).toEqual({ text: simulatorCopy.caps.reasons.SIMULATOR, untilIso: "2026-10-21T00:00:00Z" });
    expect(capNoticeOf(apiError({ reason: "GLOBAL", message: "no date" }))).toEqual({ text: simulatorCopy.caps.reasons.GLOBAL });
    expect(capNoticeOf(apiError({ reason: "SOMETHING_NEW" }))).toEqual({ text: simulatorCopy.caps.fallback });
    expect(capNoticeOf(apiError({ code: "SERVICE_UNAVAILABLE", reason: "KILL_SWITCH_ACTIVE" }))).toEqual({ text: simulatorCopy.caps.reasons.KILL_SWITCH_ACTIVE });
    expect(capNoticeOf(apiError({ code: "FORBIDDEN", kind: "forbidden", reason: "UPLOAD_NOT_YOURS" }))).toBeUndefined();
  });
});
