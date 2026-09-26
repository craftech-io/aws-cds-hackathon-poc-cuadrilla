// Rules 7 to 10 of docs/design-brief.md §5.7: when a message may go, and in which form.
//
//   CP-QUIET-HOURS        21:00-07:00 (the world's window and zone): nothing proactive; safety, the
//                         messages of an open case and answers to an inbound are exempt. A denial
//                         defers the message to `nextAllowedAt` (`TIMER#DEFERRED_SEND`), never drops it
//   CP-ONE-DAYSTART       one `DAY_START` per installer and simulated day
//   CP-WA-24H             outside the 24 h window only templates
//   CP-TEMPLATE-APPROVED  a template goes out only APPROVED: the world's simulated state on the
//                         simulated transport, Meta's review state on the live one
//
// The clock of each rule comes from the recipient's route (windows.ts, ADR-0002), and every outcome
// records it.
import type { ContactRule } from "@cuadrilla/shared";
import { type RuleChecks, type RuleOutcome, fail, notApplicable, pass } from "./check";
import { ACK_KINDS, CASE_KINDS, SAFETY_KINDS, needsServiceWindow } from "./kinds";
import { localDateOf } from "../services/business-hours/zoned-time";
import type { PolicyFacts, PolicyInput, PolicyMessage } from "./types";
import { quietClockOf, quietStateOf, serviceWindowOf, windowClockOf } from "./windows";

type TimeRule = Extract<ContactRule, "CP-QUIET-HOURS" | "CP-ONE-DAYSTART" | "CP-WA-24H" | "CP-TEMPLATE-APPROVED">;

/** Why a WhatsApp message is not proactive, if it is not. */
function quietExemption(message: PolicyMessage, facts: PolicyFacts): string | undefined {
  if (SAFETY_KINDS.has(message.kind)) return "safety";
  const caseState = facts.caseState;
  if (CASE_KINDS.has(message.kind) && caseState !== undefined && caseState.caseId === message.caseId && caseState.status !== "CLOSED") return "open case";
  if (message.inResponseToInbound || ACK_KINDS.has(message.kind)) return "answers an inbound";
  return undefined;
}

function quietHoursRule({ message, recipient, facts }: PolicyInput): RuleOutcome {
  if (recipient.kind === "EMAIL") return notApplicable();
  const clock = quietClockOf(recipient.route);
  if (clock === "NOT_APPLICABLE_LEASE") return { result: "NOT_APPLICABLE_LEASE", detail: "phone bound by code to a guest world" };
  const exemption = quietExemption(message, facts);
  if (exemption !== undefined) return notApplicable({ clock, detail: `exempt: ${exemption}` });
  const state = quietStateOf(recipient.route, facts);
  if (!state.applies || !state.quiet) return pass({ clock });
  const { start, end } = facts.world.quietHours;
  return { result: "FAIL", reason: "QUIET_HOURS", clock, detail: `quiet ${start}-${end} ${facts.world.timezone}`, deferUntil: { at: state.nextAllowedAt, clock } };
}

function oneDayStart({ message, facts }: PolicyInput): RuleOutcome {
  if (message.kind !== "DAY_START") return notApplicable();
  const nowMs = Date.parse(facts.now.sim);
  const today = localDateOf(new Date(nowMs), facts.world.timezone);
  const sentToday = facts.dayStartsSentAtSim.some((at) => Date.parse(at) <= nowMs && localDateOf(new Date(at), facts.world.timezone) === today);
  return sentToday ? fail("DAY_START_ALREADY_SENT", { clock: "WORLD", detail: `already sent on ${today}` }) : pass({ clock: "WORLD", detail: today });
}

function serviceWindowRule({ message, recipient, facts }: PolicyInput): RuleOutcome {
  if (recipient.kind === "EMAIL") return notApplicable();
  if (!needsServiceWindow(message.form)) return notApplicable({ detail: "a template may go outside the window" });
  if (recipient.kind === "UNKNOWN_NUMBER") {
    const clock = windowClockOf(recipient.route);
    return message.inResponseToInbound ? pass({ clock, detail: "reply to its inbound" }) : fail("WINDOW_CLOSED", { clock, detail: "no inbound to answer" });
  }
  const window = serviceWindowOf(recipient, facts.now);
  const field = window.clock === "WORLD" ? "lastInboundAtSim" : "lastInboundAtReal";
  const detail = window.lastInboundAt === undefined ? `no ${field}` : `${field} ${window.lastInboundAt}`;
  return window.open ? pass({ clock: window.clock, detail }) : fail("WINDOW_CLOSED", { clock: window.clock, detail });
}

function templateApproved({ message, recipient, facts }: PolicyInput): RuleOutcome {
  if (message.form !== "TEMPLATE" || message.templateName === undefined) return notApplicable();
  const name = message.templateName;
  if (recipient.kind === "PERSON" && recipient.route !== "SIMULATED") {
    const status = facts.metaTemplateStatus[name] ?? "LOCAL_ONLY";
    return status === "APPROVED" ? pass({ detail: `${name} APPROVED by Meta` }) : fail("TEMPLATE_NOT_APPROVED", { detail: `${name} ${status} at Meta` });
  }
  // The simulated transport has no Meta: the world lists the templates it holds back (plan B).
  const status = facts.world.templateStatus[name] ?? "APPROVED";
  return status === "APPROVED" ? pass({ detail: `${name} APPROVED in the world` }) : fail("TEMPLATE_NOT_APPROVED", { detail: `${name} ${status} in the world` });
}

export const TIME_CHECKS: RuleChecks<TimeRule> = {
  "CP-QUIET-HOURS": quietHoursRule,
  "CP-ONE-DAYSTART": oneDayStart,
  "CP-WA-24H": serviceWindowRule,
  "CP-TEMPLATE-APPROVED": templateApproved,
};
