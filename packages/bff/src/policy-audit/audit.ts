// `policy_audit` (docs/architecture.md §12, docs/tool-catalog.md; FL-077): what was sent in a world is
// checked again after the fact, daily and on demand (`policyAudit.run` of the QaDriver). Three checks:
//
//   (a) ALLOW_DECISION   every message and email that left has its `ALLOW` decision with the same id
//   (b) REEVALUATION     the contact policy, re-evaluated with the records as they were at the instant it
//                        left (policy/as-of.ts: history after that instant is undone, so an opt-out that
//                        came later never counts), allows it too
//   (c) CERTIFICATE      every certificate has all its items PASSED or OVERRIDDEN with its photo evidence
//                        in place, and the PDF's sha256 is the one stored
//
// A failed check writes `AuditLog VIOLATION` (`POLICY_VIOLATION`, reason = the check, detail = what it
// is about) once per check and subject, and the log line carries `PolicyViolations`. Reads only
// otherwise. Ids and codes only: never a message, an address or the PDF.
import { createHash } from "node:crypto";
import { type ChecklistItem, ispIdOfClock } from "@cuadrilla/shared";
import type { Connector } from "../connector/ports";
import type { Decision } from "../domain/audit";
import type { Message, OutboundEmail } from "../domain/conversations";
import type { Logger } from "../lib/log";
import { acceptsDemoRecipients, fenceEmailRecipient } from "../outbound/recipient-fence";
import { POLICY_REFS_KEY, PolicyRefs, evaluateMailAsOf, evaluateSentAsOf } from "../policy/as-of";
import { loadPolicyRecords } from "../policy/records";
import type { FenceVerdict, WhatsAppRoute } from "../policy/types";

export type AuditCheck = "ALLOW_DECISION" | "REEVALUATION" | "CERTIFICATE_EVIDENCE" | "CERTIFICATE_SHA256";

export interface Violation {
  readonly check: AuditCheck;
  /** The message, email or certificate the check is about. */
  readonly subject: string;
  readonly ruleIds: readonly string[];
  readonly workOrderId?: string;
}

export interface AuditReport {
  readonly clockId: string;
  readonly messages: number;
  readonly emails: number;
  readonly certificates: number;
  readonly violations: readonly Violation[];
  /** Checks that could not run (a record that failed to load): logged, never counted as clean. */
  readonly errors: number;
}

export interface PolicyAuditDeps {
  readonly connector: Connector;
  /** The bytes of a certificate's PDF (`Evidence`), or `undefined` when the object is missing. */
  readonly readCertificate: (key: string) => Promise<Uint8Array | undefined>;
  readonly logger?: Logger;
}

const LEFT = new Set<Message["status"]>(["SENT", "DELIVERED", "READ"]);
const MAIL_LEFT = new Set<OutboundEmail["status"]>(["SENT", "DELIVERED", "DELAYED", "BOUNCED", "COMPLAINED"]);
const PHOTO_ITEMS: ReadonlySet<ChecklistItem> = new Set<ChecklistItem>(["POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO"]);
const CLOSED_ITEM = new Set(["PASSED", "OVERRIDDEN"]);

function routeOf(message: Message): WhatsAppRoute {
  const refs = PolicyRefs.safeParse(message.refs?.[POLICY_REFS_KEY]);
  if (refs.success && refs.data.route !== undefined) return refs.data.route;
  return message.transport === "live" ? "LIVE_WORLD" : "SIMULATED";
}

/** What left the world to its people: outbound WhatsApp messages (read receipts are not messages). */
async function sentMessages(connector: Connector, ispId: string, clockId: string): Promise<Message[]> {
  const roles = ["INSTALLER", "SUPERVISOR", "ZONE_CHIEF"] as const;
  const people = (await Promise.all(roles.map((role) => connector.people.listPeople(ispId, role)))).flat().filter((person) => person.clockId === clockId);
  const threads = await Promise.all(people.map((person) => connector.conversations.listMessages(person.personId)));
  return threads.flat().filter((message) => message.direction === "OUT" && LEFT.has(message.status) && message.content !== "READ_ACK" && message.kind !== undefined);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The fence as the send saw it: recomputed, except in the demo world, whose registered recipients only the send's decision knows. */
function fenceOf(mail: OutboundEmail, allow: Decision | undefined): FenceVerdict {
  if (!acceptsDemoRecipients(mail.clockId)) {
    const decision = fenceEmailRecipient(mail.to, mail.clockId);
    return decision.allowed ? { allowed: true, reason: decision.recipientClass } : { allowed: false, reason: decision.reason };
  }
  const rule = allow?.evaluated.find((entry) => entry.ruleId === "CP-RECIPIENT-FENCE");
  return { allowed: rule === undefined || rule.result === "PASS" };
}

async function certificateViolations(connector: Connector, deps: PolicyAuditDeps, workOrderId: string): Promise<Violation[]> {
  const certificate = await connector.workOrders.getCertificate(workOrderId);
  if (certificate === undefined || certificate.pdfPending === true || certificate.s3Key === undefined) return [];
  const found: Violation[] = [];
  const checklist = await connector.workOrders.listChecklist(workOrderId);
  for (const entry of checklist) {
    const evidence = PHOTO_ITEMS.has(entry.item) && entry.evidenceId !== undefined ? await connector.workOrders.getEvidence(workOrderId, entry.evidenceId) : undefined;
    const missingEvidence = PHOTO_ITEMS.has(entry.item) && evidence === undefined;
    if (!CLOSED_ITEM.has(entry.status) || missingEvidence) found.push({ check: "CERTIFICATE_EVIDENCE", subject: `${certificate.certificateId}#${entry.item}`, ruleIds: [], workOrderId });
  }
  const bytes = await deps.readCertificate(certificate.s3Key);
  if (bytes === undefined || certificate.sha256 === undefined || sha256Hex(bytes) !== certificate.sha256) {
    found.push({ check: "CERTIFICATE_SHA256", subject: certificate.certificateId, ruleIds: [], workOrderId });
  }
  return found;
}

/** The three checks over one world; writes each new violation once. */
export async function auditWorld(deps: PolicyAuditDeps, input: { readonly clockId: string }): Promise<AuditReport> {
  const { connector } = deps;
  const clockId = input.clockId;
  const ispId = ispIdOfClock(clockId);
  const ofWorld = (row: Decision) => row.clockId === undefined || row.clockId === clockId;
  const allows = new Map((await connector.audit.listByDecision(ispId, "ALLOW")).filter(ofWorld).flatMap((row) => (row.messageId === undefined ? [] : [[row.messageId, row] as const])));
  const known = new Set((await connector.audit.listByDecision(ispId, "VIOLATION")).filter(ofWorld).map((row) => `${row.reason ?? ""}#${String(row.detail?.subject ?? "")}`));
  const violations: Violation[] = [];
  let errors = 0;
  const attempt = async (subject: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      errors += 1;
      deps.logger?.error("policy_audit.check_failed", { clockId, subject, error });
    }
  };

  const messages = await sentMessages(connector, ispId, clockId);
  for (const message of messages) {
    if (!allows.has(message.messageId)) violations.push({ check: "ALLOW_DECISION", subject: message.messageId, ruleIds: [], ...(message.workOrderId === undefined ? {} : { workOrderId: message.workOrderId }) });
    await attempt(message.messageId, async () => {
      const at = { sim: message.sentAtSim, real: message.sentAtReal ?? message.sentAtSim };
      const records = await loadPolicyRecords(connector, {
        ispId,
        personId: message.personId,
        route: routeOf(message),
        ...(message.workOrderId === undefined ? {} : { workOrderId: message.workOrderId }),
        certificate: message.kind?.startsWith("CERTIFICATE") === true,
        at,
      });
      const decision = evaluateSentAsOf(message, records);
      if (!decision.allowed) violations.push({ check: "REEVALUATION", subject: message.messageId, ruleIds: decision.deniedBy === undefined ? [] : [decision.deniedBy], ...(message.workOrderId === undefined ? {} : { workOrderId: message.workOrderId }) });
    });
  }

  const mails = (await connector.conversations.listOutbox(ispId)).filter((mail) => mail.clockId === clockId && MAIL_LEFT.has(mail.status));
  for (const mail of mails) {
    const allow = allows.get(mail.mailId);
    if (allow === undefined) violations.push({ check: "ALLOW_DECISION", subject: mail.mailId, ruleIds: [], ...(mail.workOrderId === undefined ? {} : { workOrderId: mail.workOrderId }) });
    await attempt(mail.mailId, async () => {
      const records = await loadPolicyRecords(connector, { ispId, ...(mail.workOrderId === undefined ? {} : { workOrderId: mail.workOrderId }), certificate: mail.kind === "CERTIFICATE_EMAIL", at: { sim: mail.sentAtSim, real: mail.sentAtReal } });
      const decision = evaluateMailAsOf(mail, fenceOf(mail, allow), records);
      if (!decision.allowed) violations.push({ check: "REEVALUATION", subject: mail.mailId, ruleIds: decision.deniedBy === undefined ? [] : [decision.deniedBy], ...(mail.workOrderId === undefined ? {} : { workOrderId: mail.workOrderId }) });
    });
  }

  const certified = [...new Set([...messages.filter((message) => message.kind === "CERTIFICATE"), ...mails.filter((mail) => mail.kind === "CERTIFICATE_EMAIL")].flatMap((row) => (row.workOrderId === undefined ? [] : [row.workOrderId])))];
  for (const workOrderId of certified) await attempt(workOrderId, async () => void violations.push(...(await certificateViolations(connector, deps, workOrderId))));

  for (const violation of violations) {
    if (known.has(`${violation.check}#${violation.subject}`)) continue;
    await connector.audit.append({
      ispId,
      clockId,
      decision: "VIOLATION",
      action: "POLICY_VIOLATION",
      ruleIds: [...violation.ruleIds],
      actor: "SYSTEM",
      reason: violation.check,
      ...(violation.check === "ALLOW_DECISION" || violation.check === "REEVALUATION" ? { messageId: violation.subject } : {}),
      refs: violation.workOrderId === undefined ? {} : { workOrderId: violation.workOrderId },
      detail: { check: violation.check, subject: violation.subject },
    });
    known.add(`${violation.check}#${violation.subject}`);
    deps.logger?.warn("policy_audit.violation", { clockId, check: violation.check, metric: "PolicyViolations", value: 1 });
  }
  const report = { clockId, messages: messages.length, emails: mails.length, certificates: certified.length, violations, errors };
  deps.logger?.info("policy_audit.done", { clockId, messages: report.messages, emails: report.emails, certificates: report.certificates, violations: violations.length, errors });
  return report;
}
