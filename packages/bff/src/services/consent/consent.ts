// `record_consent` and `revoke_consent` (docs/tool-catalog.md; FL-002, FL-005, FL-006): a person's
// WhatsApp opt-in with its dated history (`People/PERSON#…/CONSENT#WHATSAPP`), which `CP-OPTIN`,
// `CP-OPTOUT`, the ladder and `PolicyAudit` read at any past instant.
//
//   record   channel: "ALTA" from a number of the allow list (medium `WHATSAPP_KEYWORD`, the poster's
//            text version, at the message's simulated instant); console and QA: the operator records
//            an opt-in given another way (medium `CONSOLE` / `QA`, at the world's now). Only active
//            people opt in. The same opt-in again (same text version) writes nothing.
//            `ACTION CONSENT_GRANTED`.
//   revoke   channel: "BAJA"; console and QA: an opt-out given another way. A person without an opt-in
//            in force is left as is. `ACTION CONSENT_REVOKED`. A supervisor who opts out leaves the
//            ladder (`advance_ladder` skips it, `OPTED_OUT`).
//
// The medium comes from the caller, never from the input; the fixed welcome and the opt-out
// confirmation are the channel's (channels/whatsapp/keywords.ts).
import { z } from "zod";
import { IsoInstant, PersonId, ToolError } from "@cuadrilla/shared";
import { OPT_IN_TEXT_VERSION } from "../../copy/es-MX";
import { type Actor, personActor } from "../../domain/common";
import type { Consent, ConsentMedium } from "../../domain/people";
import { ACTING_ROLES, type DirectCall, type ServiceDeps, inWorld, openCall, parseInput, recordDecision, worldNow } from "../people/direct-call";

/** Versions of the opt-in poster's text a consent may name (`copy/es-MX.ts`). */
export const OPT_IN_TEXT_VERSIONS: readonly string[] = [OPT_IN_TEXT_VERSION];

const MessageId = z.string().min(1).max(256);

export const RecordConsentInput = z
  .object({
    personId: PersonId,
    /** The version of the text the person saw; the current poster's by default. */
    textVersion: z.string().min(1).max(32).optional(),
    /** Channel only: the simulated instant and the `wamid` of the "ALTA" message. */
    atSim: IsoInstant.optional(),
    sourceMessageId: MessageId.optional(),
  })
  .strict();
export type RecordConsentInput = z.input<typeof RecordConsentInput>;

export const RevokeConsentInput = z
  .object({
    personId: PersonId,
    reason: z.string().trim().min(1).max(200).optional(),
    /** Channel only: the simulated instant and the `wamid` of the "BAJA" message. */
    atSim: IsoInstant.optional(),
    sourceMessageId: MessageId.optional(),
  })
  .strict();
export type RevokeConsentInput = z.input<typeof RevokeConsentInput>;

export const CONSENT_REASON = {
  UNKNOWN_TEXT_VERSION: "UNKNOWN_TEXT_VERSION",
  PERSON_INACTIVE: "PERSON_INACTIVE",
  CHANNEL_ONLY_FIELD: "CHANNEL_ONLY_FIELD",
} as const;

export interface ConsentView {
  readonly personId: string;
  readonly status: "GRANTED" | "REVOKED" | "NONE";
  readonly medium?: ConsentMedium;
  readonly textVersion?: string;
  readonly grantedAtSim?: string;
  readonly revokedAtSim?: string;
  /** Dated changes the consent keeps. */
  readonly changes: number;
}

export interface ConsentResult {
  /** Whether this call wrote anything. */
  readonly changed: boolean;
  readonly consent: ConsentView;
}

function consentView(personId: string, consent: Consent | undefined): ConsentView {
  if (consent === undefined) return { personId, status: "NONE", changes: 0 };
  return {
    personId,
    status: consent.status,
    medium: consent.medium,
    textVersion: consent.textVersion,
    changes: consent.history.length,
    ...(consent.grantedAtSim === undefined ? {} : { grantedAtSim: consent.grantedAtSim }),
    ...(consent.revokedAtSim === undefined ? {} : { revokedAtSim: consent.revokedAtSim }),
  };
}

const MEDIUM_OF: Readonly<Record<DirectCall["kind"], ConsentMedium | undefined>> = { CHANNEL: "WHATSAPP_KEYWORD", CONSOLE: "CONSOLE", QA: "QA", WORKER: undefined, SCHEDULER: undefined };

/** The instant of the change: the channel's message, or the world's now. */
async function changeInstant(deps: ServiceDeps, call: DirectCall, input: { atSim?: string | undefined; sourceMessageId?: string | undefined }): Promise<string> {
  if (call.kind !== "CHANNEL") {
    if (input.atSim !== undefined || input.sourceMessageId !== undefined) throw new ToolError("INVALID", "only the channel brings the message's instant", CONSENT_REASON.CHANNEL_ONLY_FIELD);
    return (await worldNow(deps, call)).atSim;
  }
  return input.atSim ?? (await worldNow(deps, call)).atSim;
}

/** Over WhatsApp the person decides (`PERSON:<id>`); elsewhere the user or the QaDriver records it. */
function transitionActor(call: DirectCall, personId: string): Actor {
  return call.kind === "CHANNEL" ? personActor(personId) : call.actor;
}

const CONSENT_CALLERS = { callers: ["CHANNEL", "CONSOLE", "QA"], consoleRoles: ACTING_ROLES } as const;

export async function recordConsent(deps: ServiceDeps, caller: unknown, raw: unknown): Promise<ConsentResult> {
  const call = openCall(caller, CONSENT_CALLERS);
  const input = parseInput(RecordConsentInput, raw);
  const atSim = await changeInstant(deps, call, input);
  const person = inWorld(call, await deps.connector.people.getPerson(input.personId), "person");
  if (!person.active) throw new ToolError("INVALID", "only people on the allow list opt in", CONSENT_REASON.PERSON_INACTIVE);
  const textVersion = input.textVersion ?? OPT_IN_TEXT_VERSION;
  if (!OPT_IN_TEXT_VERSIONS.includes(textVersion)) throw new ToolError("INVALID", "unknown version of the opt-in text", CONSENT_REASON.UNKNOWN_TEXT_VERSION);
  const medium = MEDIUM_OF[call.kind] ?? "QA";

  const current = await deps.connector.people.getConsent(person.personId);
  if (current?.status === "GRANTED" && current.textVersion === textVersion) return { changed: false, consent: consentView(person.personId, current) };
  const consent = await deps.connector.people.grantConsent(
    { personId: person.personId, clockId: call.clockId, medium, textVersion },
    { actor: transitionActor(call, person.personId), atSim, reason: medium },
  );
  await recordDecision(deps, call, {
    decision: "ACTION",
    action: "CONSENT_GRANTED",
    atSim,
    refs: { personId: person.personId },
    ...(input.sourceMessageId === undefined ? {} : { messageId: input.sourceMessageId }),
    detail: { medium, textVersion },
  });
  return { changed: true, consent: consentView(person.personId, consent) };
}

export async function revokeConsent(deps: ServiceDeps, caller: unknown, raw: unknown): Promise<ConsentResult> {
  const call = openCall(caller, CONSENT_CALLERS);
  const input = parseInput(RevokeConsentInput, raw);
  const atSim = await changeInstant(deps, call, input);
  const person = inWorld(call, await deps.connector.people.getPerson(input.personId), "person");
  const current = await deps.connector.people.getConsent(person.personId);
  if (current?.status !== "GRANTED") return { changed: false, consent: consentView(person.personId, current) };
  const via = call.kind === "CHANNEL" ? "WHATSAPP_KEYWORD" : (MEDIUM_OF[call.kind] ?? "QA");
  const consent = await deps.connector.people.revokeConsent(person.personId, { actor: transitionActor(call, person.personId), atSim, reason: input.reason ?? via });
  await recordDecision(deps, call, {
    decision: "ACTION",
    action: "CONSENT_REVOKED",
    atSim,
    refs: { personId: person.personId },
    ...(input.sourceMessageId === undefined ? {} : { messageId: input.sourceMessageId }),
    detail: { via },
  });
  return { changed: true, consent: consentView(person.personId, consent) };
}
