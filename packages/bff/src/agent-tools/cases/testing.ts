// Test support for the `cases` target (never imported by runtime code): the tools' kit of
// common/testing.ts (sessions, kill switch, captured logs) over the demo world of cases/testing.ts,
// with the fakes of every port: the outbound pipeline that runs the real contact policy, the timers,
// the installer queue, a summary check the test steers, the network orchestrator and a certificate
// writer that records the order as the real one does (`WorkOrders/CERT`, the order CLOSED).
import { CLOCK, ISP } from "../../connector/testing";
import type { CaseClosedTurn, SummaryCheckInput } from "../../cases/ports";
import { type FakeNetwork, type FakeOutbound, fakeNetwork, memoryTimers, policyOutbound, seedCaseWorld } from "../../cases/testing";
import type { IssueCertificateRequest } from "../common/ports";
import type { ToolHandler } from "../common/handler";
import { type ToolTestKit, toolTestKit } from "../common/testing";
import { createCasesTools } from "./index";
import type { CasesRuntime } from "./runtime";

export interface CasesToolKit {
  readonly tools: ToolTestKit;
  readonly cases: ToolHandler;
  readonly runtime: CasesRuntime;
  readonly outbound: FakeOutbound;
  readonly network: FakeNetwork;
  readonly turns: CaseClosedTurn[];
  readonly certificates: IssueCertificateRequest[];
  /** What the summary check answers; a test flips `ok`. */
  readonly summaryAnswer: { ok: boolean; reason?: string };
  readonly checkedSummaries: SummaryCheckInput[];
}

/** The worker's caller for a direct call in the demo world. */
export const CHANNEL_CALLER = { kind: "CHANNEL", ispId: ISP, clockId: CLOCK, eventId: "evt-button-01" } as const;

export const CERT_SHA = "a1".repeat(32);

export async function casesToolKit(): Promise<CasesToolKit> {
  const tools = toolTestKit();
  await seedCaseWorld(tools.memory);
  const { workOrders } = tools.memory.connector;
  const outbound = policyOutbound(tools.memory);
  const network = fakeNetwork();
  const turns: CaseClosedTurn[] = [];
  const certificates: IssueCertificateRequest[] = [];
  const checkedSummaries: SummaryCheckInput[] = [];
  const summaryAnswer: { ok: boolean; reason?: string } = { ok: true };
  let sequence = 0;
  const runtime: CasesRuntime = {
    ...tools.runtime,
    outbound,
    network,
    timers: memoryTimers(tools.memory),
    turns: { enqueueCaseClosed: async (turn) => void turns.push(turn) },
    summaries: {
      verify: async (input) => {
        checkedSummaries.push(input);
        return { ...summaryAnswer };
      },
    },
    certificates: {
      async issue(request) {
        certificates.push(request);
        const certificateId = `cert-${request.workOrderId}-1`;
        await workOrders.putCertificate({ workOrderId: request.workOrderId, clockId: request.clockId, certificateId, n: 1, issuedAtSim: request.closedAtSim, sha256: CERT_SHA, s3Key: `certificates/${request.workOrderId}/acta-1.pdf` });
        await workOrders.setStatus(request.workOrderId, "CLOSED", { actor: "SYSTEM", atSim: request.closedAtSim, reason: "certificate issued" });
        return {
          certificateId,
          sha256: CERT_SHA,
          deliveries: [
            { to: "CUSTOMER", channel: "EMAIL", status: "QUEUED" },
            { to: "OPS_MAILBOX", channel: "EMAIL", status: "QUEUED" },
            { to: "INSTALLER", channel: "WHATSAPP", status: "QUEUED" },
          ],
        };
      },
    },
    newCaseId: () => `case-01J9ZQX${(sequence++).toString().padStart(19, "0")}`,
  };
  return { tools, cases: createCasesTools(() => runtime), runtime, outbound, network, turns, certificates, summaryAnswer, checkedSummaries };
}
