// A lost invocation in the middle of the safety response, then the redelivered event (ADR-0016,
// docs/design-brief.md §5.9, FL-067/FL-068) [W3R1 B2]. The real `handleSafety`, the real case opening
// and ladder and the real outbound pipeline (outbound/cases.ts) over the demo world of the cases, with
// the simulated transport. The first run dies where a Lambda timeout or an out-of-memory would leave it
// (a promise that never settles), and the second run is the redelivery: the installer gets §SEG-01, the
// supervisor on duty `alerta_seguridad` and the zone chief the email, with one SAFETY_DETECTED row.
// [W3R3] The ladder is not one write either: the run also dies after PRIMARY's entry while the zone
// chief's email is in flight, and after a skipped PRIMARY while the SECONDARY is being alerted; the
// redelivery finishes each from what the case shows (cases/resume.ts), every piece exactly once.
import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, ISP } from "../connector/testing";
import type { Connector } from "../connector/ports";
import type { Message } from "../domain/conversations";
import { createCaseOutbound } from "../outbound/cases";
import { pipelineDeps } from "../outbound/testing";
import type { SendRequest } from "../channels/whatsapp/transport";
import { type CaseKit, caseKit, inbound, mx } from "../cases/testing";
import type { CaseDeps } from "../cases/ports";
import { classifySafety } from "./classifier";
import { type SafetyReport, handleSafety } from "./handler";

const ORDER = "wo-24817";
const TEXT = "Hay un cable pelado en el poste, está chispeando";
const NEVER = new Promise<never>(() => undefined);

function report(): SafetyReport {
  const match = classifySafety(TEXT);
  if (!match.hazard) throw new Error("the lexicon should match");
  return { ispId: ISP, clockId: CLOCK, installerId: "inst-rogelio", workOrderId: ORDER, category: match.category, detectedBy: "LEXICON", entryId: match.entryId, lexiconVersion: match.lexiconVersion, sourceMessageId: "wamid.SIM.safety.01", report: TEXT, atSim: mx("2026-10-13 15:10"), actor: "WORKER" };
}

let kit: CaseKit;
/** The sends the transport never answers: the invocation dies inside it, after the message was written QUEUED. */
let transportLost: (request: SendRequest) => boolean = () => false;
/** While true, SES never answers the zone chief's email. */
let emailLost = false;

function wiring(connector: Connector = kit.world.connector) {
  const pipeline = pipelineDeps(kit.world, { transport: (request: SendRequest, simulated) => (transportLost(request) ? NEVER : simulated(request)) });
  const email: typeof pipeline.deps.email = { send: (request) => (emailLost ? NEVER : pipeline.deps.email.send(request)) };
  const outbound = createCaseOutbound({ ...pipeline.deps, connector, email }, pipeline.log);
  const deps: CaseDeps = { ...kit.deps, connector, outbound };
  return { deps, pipeline };
}

/** Lets a run reach the point where it hangs (its other branch finishing meanwhile). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function outbox(personId: string, kind: Message["kind"]): Promise<Message[]> {
  return (await kit.world.connector.conversations.listMessages(personId)).filter((message) => message.direction === "OUT" && message.kind === kind);
}

async function expectFullResponse(emails: ReadonlyArray<{ readonly kind: string; readonly mailId?: string }>): Promise<void> {
  const instructions = await outbox("inst-rogelio", "SAFETY_INSTRUCTION");
  expect(instructions.filter((message) => message.status === "SENT")).toHaveLength(1);
  const alerts = await outbox("sup-adriana", "SAFETY_ALERT");
  expect(alerts.filter((message) => message.status === "SENT")).toHaveLength(1);
  expect(new Set(emails.filter((email) => email.kind === "ZONE_CHIEF_ALERT").map((email) => email.mailId)).size).toBe(1);
  const audit = await kit.world.connector.audit.listByWorkOrder(ORDER);
  expect(audit.filter((row) => row.action === "SAFETY_DETECTED")).toHaveLength(1);
  const [caseItem] = await kit.world.connector.cases.listCasesOfWorkOrder(ORDER);
  expect(caseItem?.ladder.map((entry) => `${entry.rung} ${entry.outcome}`)).toEqual(["PRIMARY NOTIFIED"]);
}

async function auditCount(action: string): Promise<number> {
  return (await kit.world.connector.audit.listByWorkOrder(ORDER)).filter((row) => row.action === action).length;
}

async function ladderOfCase(): Promise<string[]> {
  const [caseItem] = await kit.world.connector.cases.listCasesOfWorkOrder(ORDER);
  return caseItem?.ladder.map((entry) => `${entry.rung} ${entry.outcome}`) ?? [];
}

async function waitsOfCase(): Promise<string[]> {
  const [caseItem] = await kit.world.connector.cases.listCasesOfWorkOrder(ORDER);
  if (caseItem === undefined) return [];
  return (await kit.world.connector.timers.listTimers({ kind: "CASE", id: caseItem.caseId })).filter((timer) => timer.kind === "CASE_TIMEOUT").map((timer) => timer.timerId);
}

function zoneChiefEmails(...runs: ReadonlyArray<{ readonly pipeline: { readonly emails: ReadonlyArray<{ readonly kind: string }> } }>): number {
  return runs.flatMap((run) => run.pipeline.emails).filter((email) => email.kind === "ZONE_CHIEF_ALERT").length;
}

beforeEach(async () => {
  kit = await caseKit();
  transportLost = () => false;
  emailLost = false;
  await inbound(kit.world, "inst-rogelio", mx("2026-10-13 15:10"), { messageId: "wamid.SIM.safety.01", text: TEXT });
});

describe("[W3R1 B2] a lost invocation in the safety response, then the redelivery", () => {
  it("the transport never answered: the QUEUED instruction and alert go out again, the zone chief is emailed once, one audit row", async () => {
    transportLost = () => true;
    const lost = wiring();
    void handleSafety(lost.deps, report());
    await settle();
    expect((await outbox("inst-rogelio", "SAFETY_INSTRUCTION")).map((message) => message.status)).toEqual(["QUEUED"]);
    expect((await outbox("sup-adriana", "SAFETY_ALERT")).map((message) => message.status)).toEqual(["QUEUED"]);
    transportLost = () => false;
    const redelivery = wiring();
    const outcome = await handleSafety(redelivery.deps, report());
    expect(outcome).toMatchObject({ instructionSent: true, existingCase: true, workOrderId: ORDER });
    expect(redelivery.pipeline.sends.map((send) => send.message.messageId)).toEqual(expect.arrayContaining([expect.stringMatching(/^safety-[0-9a-f]{40}\.r1$/), expect.stringMatching(/-PRIMARY-0-t\.r1$/)]));
    await expectFullResponse([...lost.pipeline.emails, ...redelivery.pipeline.emails]);
    expect(redelivery.pipeline.logs.some((line) => line.message === "outbound.unconfirmed_resend")).toBe(true);
  });

  it("the invocation died right after the case was created: the redelivery runs the ladder it never started", async () => {
    let dieAfterCreate = true;
    const { connector } = kit.world;
    const cases: Connector["cases"] = {
      ...connector.cases,
      createCase: async (input) => {
        const created = await connector.cases.createCase(input);
        if (!dieAfterCreate) return created;
        dieAfterCreate = false;
        return NEVER;
      },
    };
    const lost = wiring({ ...connector, cases });
    void handleSafety(lost.deps, report());
    await settle();
    const [orphan] = await connector.cases.listCasesOfWorkOrder(ORDER);
    expect(orphan).toMatchObject({ status: "OPEN", rung: "PRIMARY", rungVersion: 0, ladder: [] });
    expect(await outbox("sup-adriana", "SAFETY_ALERT")).toEqual([]);
    const redelivery = wiring();
    expect(await handleSafety(redelivery.deps, report())).toMatchObject({ instructionSent: true, existingCase: true, caseId: orphan?.caseId });
    await expectFullResponse([...lost.pipeline.emails, ...redelivery.pipeline.emails]);
    const again = wiring();
    await handleSafety(again.deps, report());
    expect(again.pipeline.sends).toEqual([]);
    await expectFullResponse([...lost.pipeline.emails, ...redelivery.pipeline.emails]);
  });
});

describe("[W3R3] a lost invocation in the middle of the safety ladder, then the redelivery", () => {
  it("the zone chief's email never answered after PRIMARY was notified: the redelivery emails and audits it once", async () => {
    emailLost = true;
    const lost = wiring();
    void handleSafety(lost.deps, report());
    await settle();
    expect(await ladderOfCase()).toEqual(["PRIMARY NOTIFIED"]);
    expect(await auditCount("SAFETY_ZONE_CHIEF_ALERT")).toBe(0);
    emailLost = false;
    const redelivery = wiring();
    expect(await handleSafety(redelivery.deps, report())).toMatchObject({ instructionSent: true, existingCase: true });
    await expectFullResponse([...lost.pipeline.emails, ...redelivery.pipeline.emails]);
    expect(zoneChiefEmails(lost, redelivery)).toBe(1);
    expect(await auditCount("SAFETY_ZONE_CHIEF_ALERT")).toBe(1);
    expect(await auditCount("SAFETY_ZONE_CHIEF_SKIPPED")).toBe(0);
    expect(await auditCount("CASE_NOTIFIED")).toBe(1);
    expect(await waitsOfCase()).toHaveLength(1);
    expect(await outbox("inst-rogelio", "CASE_NOTICE")).toHaveLength(1);
    const again = wiring();
    await handleSafety(again.deps, report());
    expect(again.pipeline.sends).toEqual([]);
    expect(zoneChiefEmails(again)).toBe(0);
    expect(await auditCount("SAFETY_ZONE_CHIEF_ALERT")).toBe(1);
    expect(await auditCount("CASE_NOTIFIED")).toBe(1);
  });

  it.each([
    ["before the alert was written", "PERSON"],
    ["inside the transport, the alert written QUEUED", "TRANSPORT"],
  ] as const)("PRIMARY was skipped and the run died sending to the SECONDARY %s: the redelivery climbs, alerting once", async (_where, cut) => {
    await kit.world.connector.people.revokeConsent("sup-adriana", { actor: "PERSON:sup-adriana", atSim: mx("2026-10-13 07:10") });
    const { connector } = kit.world;
    let hang = true;
    const people: Connector["people"] = { ...connector.people, getPerson: (personId) => (cut === "PERSON" && hang && personId === "sup-hector" ? NEVER : connector.people.getPerson(personId)) };
    transportLost = (request) => cut === "TRANSPORT" && /-SECONDARY-/.test(request.message.messageId);
    const lost = wiring({ ...connector, people });
    void handleSafety(lost.deps, report());
    await settle();
    expect(await ladderOfCase()).toEqual(["PRIMARY SKIPPED"]);
    expect((await outbox("sup-hector", "SAFETY_ALERT")).map((message) => message.status)).toEqual(cut === "PERSON" ? [] : ["QUEUED"]);
    hang = false;
    transportLost = () => false;
    const redelivery = wiring();
    expect(await handleSafety(redelivery.deps, report())).toMatchObject({ instructionSent: true, existingCase: true });
    expect(await ladderOfCase()).toEqual(["PRIMARY SKIPPED", "SECONDARY NOTIFIED"]);
    expect((await outbox("sup-hector", "SAFETY_ALERT")).filter((message) => message.status === "SENT")).toHaveLength(1);
    expect((await outbox("sup-adriana", "SAFETY_ALERT")).map((message) => message.status)).toEqual(["DENIED"]);
    expect(zoneChiefEmails(lost, redelivery)).toBe(1);
    expect(await auditCount("CASE_SKIPPED")).toBe(1);
    expect(await auditCount("CASE_NOTIFIED")).toBe(1);
    expect(await auditCount("SAFETY_ZONE_CHIEF_ALERT")).toBe(1);
    expect(await waitsOfCase()).toEqual([expect.stringMatching(/-SECONDARY$/)]);
    expect(await outbox("inst-rogelio", "CASE_NOTICE")).toHaveLength(1);
    expect((await outbox("inst-rogelio", "SAFETY_INSTRUCTION")).filter((message) => message.status === "SENT")).toHaveLength(1);
    const again = wiring();
    await handleSafety(again.deps, report());
    expect(again.pipeline.sends).toEqual([]);
    expect(await auditCount("CASE_NOTIFIED")).toBe(1);
    expect(await waitsOfCase()).toHaveLength(1);
  });
});
