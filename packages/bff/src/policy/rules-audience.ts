// Rules 1 to 6 of docs/design-brief.md §5.7: may this kind of message go to this recipient at all.
//
//   CP-KIND-CHANNEL  the matrix of §3 (kinds.ts): channel, audience, form, author, template
//   CP-ALLOWLIST     WhatsApp only to active people of the allow list; a number outside it gets one
//                    fixed notice a day, and on the live transport none beyond the global daily cap
//   CP-OPTIN         an opt-in in force, except the invitation to send ALTA and its welcome
//   CP-OPTOUT        after BAJA nothing but its confirmation
//   CP-BRIDGE        with a case TAKEN on the order the agent does not write to the installer
//   CP-ROSTER        case requests, safety alerts and briefs only to the supervisors of the roster
//                    the case copied when it was opened (FL-007: open cases keep theirs)
import type { ContactRule } from "@cuadrilla/shared";
import { type RuleChecks, type RuleOutcome, fail, notApplicable, pass } from "./check";
import { type Audience, KIND_CHANNEL_MATRIX, ROSTER_KINDS } from "./kinds";
import { OPT_IN_EXEMPT_NOTICES, OPT_OUT_EXEMPT_NOTICES, type PolicyInput, type PolicyMessage, type PolicyRecipient, UNKNOWN_NUMBER_NOTICES } from "./types";

/** Replies the live number may send to unknown numbers per real day (`UNKNOWN#GLOBAL#<realDay>`). */
export const UNKNOWN_SENDER_DAILY_CAP = 20;

type AudienceRule = Extract<ContactRule, "CP-KIND-CHANNEL" | "CP-ALLOWLIST" | "CP-OPTIN" | "CP-OPTOUT" | "CP-BRIDGE" | "CP-ROSTER">;

function audienceOf(recipient: PolicyRecipient): Audience {
  if (recipient.kind === "EMAIL") return recipient.role;
  if (recipient.kind === "UNKNOWN_NUMBER") return "UNKNOWN_NUMBER";
  // A zone chief on WhatsApp matches no kind: the only kind for zone chiefs goes by email.
  return recipient.role;
}

function isNotice(message: PolicyMessage, notices: readonly string[]): boolean {
  return message.kind === "SYSTEM_NOTICE" && message.notice !== undefined && notices.includes(message.notice);
}

function kindChannel({ message, recipient }: PolicyInput): RuleOutcome {
  const rule = KIND_CHANNEL_MATRIX[message.kind];
  const recipientChannel = recipient.kind === "EMAIL" ? "EMAIL" : "WHATSAPP";
  if (message.channel !== rule.channel || recipientChannel !== rule.channel) {
    return fail("KIND_WRONG_CHANNEL", { detail: `${message.kind} goes by ${rule.channel}` });
  }
  const audience = audienceOf(recipient);
  if (!rule.audiences.includes(audience)) return fail("KIND_WRONG_RECIPIENT", { detail: `${message.kind} is not for ${audience}` });
  const authors = rule.forms[message.form];
  if (authors === undefined) return fail("KIND_WRONG_FORM", { detail: `${message.kind} is never ${message.form}` });
  if (!authors.includes(message.author)) return fail("KIND_WRONG_AUTHOR", { detail: `${message.kind} ${message.form} is never written by ${message.author}` });
  if (message.form === "TEMPLATE") {
    if (message.templateName === undefined || !(rule.templates ?? []).includes(message.templateName)) {
      return fail("KIND_WRONG_TEMPLATE", { detail: `${message.kind} is not rendered by ${message.templateName ?? "no template"}` });
    }
  } else if (message.templateName !== undefined) {
    return fail("KIND_WRONG_TEMPLATE", { detail: `a ${message.form} message renders no template` });
  }
  if (message.kind === "SYSTEM_NOTICE" && message.notice === undefined) return fail("KIND_NOTICE_MISSING", { detail: "a system notice is a fixed text of copy/" });
  return pass({ detail: `${message.kind} ${message.form} to ${audience}` });
}

function allowList({ message, recipient }: PolicyInput): RuleOutcome {
  if (recipient.kind === "EMAIL") return notApplicable();
  if (recipient.kind === "UNKNOWN_NUMBER") {
    if (!isNotice(message, UNKNOWN_NUMBER_NOTICES)) return fail("UNKNOWN_SENDER", { detail: "an unknown number gets only its fixed notices" });
    if (recipient.repliesToday > 0) return fail("UNKNOWN_SENDER", { detail: "already answered this number today" });
    if (recipient.route === "LIVE_WORLD" && recipient.globalRepliesToday >= UNKNOWN_SENDER_DAILY_CAP) {
      return fail("UNKNOWN_SENDER_CAP", { detail: `global cap ${UNKNOWN_SENDER_DAILY_CAP} of the real day reached` });
    }
    return pass({ detail: "first reply of the day to an unknown number" });
  }
  if (!recipient.hasPhone) return fail("NO_PHONE", { detail: "no registered phone" });
  if (!recipient.active) return fail("NOT_ALLOWLISTED", { detail: "person not active" });
  return pass();
}

function optIn({ message, recipient }: PolicyInput): RuleOutcome {
  if (recipient.kind !== "PERSON") return notApplicable();
  if (recipient.consent === "GRANTED") return pass();
  if (recipient.consent === "REVOKED") return notApplicable({ detail: "revoked: CP-OPTOUT decides" });
  if (isNotice(message, OPT_IN_EXEMPT_NOTICES)) return pass({ detail: `exempt notice ${message.notice ?? ""}` });
  return fail("NO_OPT_IN", { detail: "no opt-in (ALTA) yet" });
}

function optOut({ message, recipient }: PolicyInput): RuleOutcome {
  if (recipient.kind !== "PERSON") return notApplicable();
  if (recipient.consent !== "REVOKED") return pass();
  if (isNotice(message, OPT_OUT_EXEMPT_NOTICES)) return pass({ detail: "confirmation of BAJA" });
  return fail("OPTED_OUT", { detail: "opt-out (BAJA) in force" });
}

function bridge({ message, facts }: PolicyInput): RuleOutcome {
  if (message.author !== "AGENT") return notApplicable();
  return facts.bridgeActive ? fail("BRIDGE_ACTIVE", { detail: "the order has a case TAKEN" }) : pass();
}

function roster({ message, recipient, facts }: PolicyInput): RuleOutcome {
  if (!ROSTER_KINDS.has(message.kind)) return notApplicable();
  if (facts.roster === undefined) return fail("NO_ROSTER", { detail: "no shift roster for the case" });
  const personId = recipient.kind === "PERSON" ? recipient.personId : undefined;
  const rung = personId === undefined ? undefined : personId === facts.roster.primaryId ? "PRIMARY" : personId === facts.roster.secondaryId ? "SECONDARY" : undefined;
  return rung === undefined ? fail("NOT_ON_ROSTER", { detail: "recipient is not a supervisor of the roster" }) : pass({ detail: rung });
}

export const AUDIENCE_CHECKS: RuleChecks<AudienceRule> = {
  "CP-KIND-CHANNEL": kindChannel,
  "CP-ALLOWLIST": allowList,
  "CP-OPTIN": optIn,
  "CP-OPTOUT": optOut,
  "CP-BRIDGE": bridge,
  "CP-ROSTER": roster,
};
