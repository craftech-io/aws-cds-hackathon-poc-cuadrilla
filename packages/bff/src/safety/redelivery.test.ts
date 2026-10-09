// A lost invocation in the middle of the safety response, then the redelivered event (ADR-0016,
// docs/design-brief.md §5.9, FL-067/FL-068) [W3R1 B2]. The real `handleSafety`, the real case opening
// and ladder and the real outbound pipeline (outbound/cases.ts) over the demo world of the cases, with
// the simulated transport. The first run dies where a Lambda timeout or an out-of-memory would leave it
// (a promise that never settles), and the second run is the redelivery: the installer gets §SEG-01, the
// supervisor on duty `alerta_seguridad` and the zone chief the email, with one SAFETY_DETECTED row.
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
/** While true, the transport never answers: the invocation dies inside it, after the message was written QUEUED. */
let transportLost = false;

function wiring(connector: Connector = kit.world.connector) {
  const pipeline = pipelineDeps(kit.world, { transport: (request: SendRequest, simulated) => (transportLost ? NEVER : simulated(request)) });
  const outbound = createCaseOutbound({ ...pipeline.deps, connector }, pipeline.log);
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

beforeEach(async () => {
  kit = await caseKit();
  transportLost = false;
  await inbound(kit.world, "inst-rogelio", mx("2026-10-13 15:10"), { messageId: "wamid.SIM.safety.01", text: TEXT });
});

describe("[W3R1 B2] a lost invocation in the safety response, then the redelivery", () => {
  it("the transport never answered: the QUEUED instruction and alert go out again, the zone chief is emailed once, one audit row", async () => {
    transportLost = true;
    const lost = wiring();
    void handleSafety(lost.deps, report());
    await settle();
    expect((await outbox("inst-rogelio", "SAFETY_INSTRUCTION")).map((message) => message.status)).toEqual(["QUEUED"]);
    expect((await outbox("sup-adriana", "SAFETY_ALERT")).map((message) => message.status)).toEqual(["QUEUED"]);
    transportLost = false;
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
