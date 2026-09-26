// Who gets past the channel (docs/design-brief.md §5.7, CP-ALLOWLIST, CP-OPTIN, CP-OPTOUT; FL-003,
// FL-004, FL-101):
//
//   - A number outside the allow list never reaches the agent and its body is never stored (only its
//     hash and the time, in the audit log). In a simulated world it gets one fixed reply per number and
//     simulated day; live, at most one per number and real day and never more than 20 a day for the
//     whole stage (`UNKNOWN#GLOBAL`), so nobody can make our number write to many phones.
//   - "ALTA <código>" from a real phone binds it to a person of a guest's world (lease.ts); its replies
//     to a phone that is not bound yet count against the same limits as any unknown number.
//   - Staff without opt-in get "Para activar Cuadrilla envía ALTA"; staff who opted out get nothing.
import { ispIdOfClock } from "@cuadrilla/shared";
import { esMX } from "../../copy/es-MX";
import { COUNTER_KEYS, dayKey } from "../../connector/keys";
import type { Connector, CounterReservation } from "../../connector/ports";
import { type Clock, systemClock } from "../../lib/clock";
import { localDateOf } from "../../services/business-hours/zoned-time";
import { UNKNOWN_REPLIES_PER_DAY } from "./config";
import { type StaffDeps, type StaffMessage, noticeTo } from "./context";
import type { SenderIdentity } from "./identity";
import { type LeaseDeps, LEASE_HOURS, bindPhoneLease } from "./lease";
import type { MetricSink, NoticeKey, NoticeSender, WorldTime } from "./ports";

export interface GateDeps {
  readonly connector: Pick<Connector, "runtime" | "audit">;
  readonly notices: NoticeSender;
  readonly metrics: MetricSink;
  readonly realClock?: Clock;
}

export type UnknownOutcome = "REPLIED" | "SILENT";

/** Counters a reply to an unknown number takes; all or nothing. */
function unknownReplyCounters(sender: SenderIdentity, clockId: string, world: WorldTime, realNow: Date): CounterReservation[] {
  if (sender.transport === "simulated") {
    return [{ counterKey: COUNTER_KEYS.rateSim(clockId, sender.phoneHash, `unknown-${localDateOf(world.simNow, world.timeZone)}`), kind: "RATE", by: 1, max: 1 }];
  }
  const realDay = dayKey(realNow);
  return [
    { counterKey: COUNTER_KEYS.rateReal(clockId, sender.phoneHash, `unknown-${realDay}`), kind: "RATE", by: 1, max: 1 },
    { counterKey: COUNTER_KEYS.unknownReplies(realDay), kind: "UNKNOWN", by: 1, max: UNKNOWN_REPLIES_PER_DAY },
  ];
}

/** A fixed reply to a number that is not staff of the world, within the limits above. */
async function replyToUnknown(sender: SenderIdentity, world: WorldTime | undefined, wamid: string, notice: NoticeKey, text: string, deps: GateDeps): Promise<boolean> {
  const clockId = sender.clockId;
  if (clockId === undefined || world === undefined) return false;
  const realNow = await (deps.realClock ?? systemClock).now();
  const reserved = await deps.connector.runtime.reserve(unknownReplyCounters(sender, clockId, world, realNow));
  if (!reserved.ok) return false;
  await deps.notices.send({
    clockId,
    ispId: ispIdOfClock(clockId),
    recipient: { phone: sender.phone, phoneHash: sender.phoneHash, transport: sender.transport },
    notice,
    text,
    replyToWamid: wamid,
  });
  if (sender.transport === "live") deps.metrics.count("UnknownSenderReplies");
  return true;
}

/** FL-004: an unknown number (or an inactive or ambiguous one). No body kept, no media fetched. */
export async function answerUnknownSender(sender: SenderIdentity, world: WorldTime | undefined, wamid: string, deps: GateDeps): Promise<UnknownOutcome> {
  const replied = await replyToUnknown(sender, world, wamid, "unknownNumber", esMX.unknownNumber, deps);
  if (sender.clockId !== undefined) {
    await deps.connector.audit.append({
      ispId: ispIdOfClock(sender.clockId),
      clockId: sender.clockId,
      ...(world === undefined ? {} : { atSim: world.simNow.toISOString() }),
      decision: "DENY",
      action: "UNKNOWN_SENDER",
      actor: "CHANNEL",
      ruleIds: ["CP-ALLOWLIST"],
      detail: { phoneHash: sender.phoneHash, replied },
    });
  }
  return replied ? "REPLIED" : "SILENT";
}

export type BindReply = "BOUND" | "CODE_INVALID" | "LEASE_CONFLICT";

/** FL-101: "ALTA <código>" from a real phone. */
export async function bindFromLivePhone(sender: SenderIdentity, world: WorldTime | undefined, code: string, wamid: string, deps: GateDeps & { readonly leases: LeaseDeps }): Promise<BindReply> {
  const outcome = await bindPhoneLease({ code, phoneHash: sender.phoneHash }, deps.leases);
  if (!outcome.ok) {
    const [notice, text] = outcome.reason === "CODE_INVALID" ? (["joinCodeInvalid", esMX.joinCodeInvalid] as const) : (["leaseInUse", esMX.leaseInUse] as const);
    await replyToUnknown(sender, world, wamid, notice, text, deps);
    return outcome.reason;
  }
  const { lease, person } = outcome;
  await deps.notices.send({
    clockId: lease.clockId,
    ispId: ispIdOfClock(lease.clockId),
    recipient: { personId: person.personId, phone: sender.phone, phoneHash: sender.phoneHash, transport: "live" },
    notice: "leaseBound",
    text: esMX.leaseBound(person.firstName, LEASE_HOURS),
    replyToWamid: wamid,
  });
  return "BOUND";
}

export type ConsentState = "GRANTED" | "MISSING" | "REVOKED";

export async function consentState(personId: string, connector: Pick<Connector, "people">): Promise<ConsentState> {
  const consent = await connector.people.getConsent(personId);
  if (consent === undefined) return "MISSING";
  return consent.status === "GRANTED" ? "GRANTED" : "REVOKED";
}

/** FL-003: no turn without opt-in. The reply goes only to who never opted in; an opt-out gets nothing. */
export async function refuseWithoutConsent(staff: StaffMessage, state: Exclude<ConsentState, "GRANTED">, deps: Pick<StaffDeps, "connector" | "notices">): Promise<void> {
  if (state === "MISSING") await deps.notices.send(noticeTo(staff, "optInRequired", esMX.optInRequired));
  await deps.connector.audit.append({
    ispId: staff.ispId,
    clockId: staff.clockId,
    atSim: staff.simNow.toISOString(),
    decision: "DENY",
    action: "AGENT_TURN",
    actor: "CHANNEL",
    trigger: "INSTALLER_MESSAGE",
    ruleIds: [state === "MISSING" ? "CP-OPTIN" : "CP-OPTOUT"],
    messageId: staff.message.messageId,
    refs: { personId: staff.person.personId },
  });
}
