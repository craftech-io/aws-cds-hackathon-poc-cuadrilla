// The five Gateway targets of a local world (docs/architecture.md §9.2), each the product's own handler
// (`createToolHandler` with the target's implementations) over the runtime its Lambda builds in
// agent-tools/<target>/runtime.ts, here from the local stage (stage.ts):
//
//   orders     the network client over the in-process orchestrator, `open_case(NOT_PROVISIONED)`
//   knowledge  the Knowledge Base client over the `Retrieve` fake, the catalog of the manual in force
//   evidence   the scripted photo model (the set's scripted verdicts), the buckets, the orchestrator's
//              cross-check, the cost caps, `open_case(PHOTO_ATTEMPTS)` and the reaction by the pipeline
//   messaging  `send_whatsapp` through the outbound pipeline
//   cases      the case handlers, the timers, the installer queue, the summary check and the certificate
import { caseButtonActions, notProvisionedCases, photoAttemptsCases } from "../../../packages/bff/src/agent-tools/cases/actions";
import { createCasesTools } from "../../../packages/bff/src/agent-tools/cases/index";
import type { ToolRuntime } from "../../../packages/bff/src/agent-tools/common/context";
import { type ToolHandler, createToolHandler } from "../../../packages/bff/src/agent-tools/common/handler";
import { createEvidenceTarget } from "../../../packages/bff/src/agent-tools/evidence/index";
import { searchProcedures } from "../../../packages/bff/src/agent-tools/knowledge/handler";
import { MESSAGING_IMPLEMENTATIONS } from "../../../packages/bff/src/agent-tools/messaging/handler";
import { ORDERS_IMPLEMENTATIONS } from "../../../packages/bff/src/agent-tools/orders/handler";
import { type ScriptedModel, scriptedModel } from "../../../packages/bff/src/evidence/testing";
import { createKnowledgeCatalog } from "../../../packages/bff/src/knowledge/catalog";
import { createKnowledgeClient } from "../../../packages/bff/src/knowledge/client";
import { pipelineEvidenceOutbound } from "../../../packages/bff/src/outbound/adapters";
import type { GatewayTarget } from "../../../infra/policy-rules";
import type { KnowledgeFake } from "./aws";
import { LOCAL_GLOBAL_CAPS, type Stage } from "./stage";

export interface Targets extends Readonly<Record<GatewayTarget, ToolHandler>> {
  readonly photoModel: ScriptedModel;
  /** The two buttons of an installer that belong to cases (agent-tools/cases/actions.ts), for the worker. */
  readonly buttonActions: ReturnType<typeof caseButtonActions>;
}

export function createTargets(stage: Stage, knowledge: KnowledgeFake): Targets {
  const data = stage.memory.connector;
  const base: ToolRuntime = { connector: data, killSwitch: stage.kill, sessionKey: () => stage.key("session"), realClock: stage.realClock, loggerFor: () => stage.log };
  const network = stage.network.client;
  const photoModel = scriptedModel();
  const kb = createKnowledgeClient({ send: (input) => knowledge.send(input), knowledgeBaseId: () => "LOCALKB01", fault: async () => undefined, sleep: async () => undefined, logger: stage.log });
  const catalog = createKnowledgeCatalog(data.reference, stage.realClock, 0);
  const orders = createToolHandler({ target: "orders", deps: () => ({ ...base, network, notProvisionedCases: notProvisionedCases(stage.cases) }), tools: ORDERS_IMPLEMENTATIONS });
  const knowledgeTarget = createToolHandler({ target: "knowledge", deps: () => ({ ...base, knowledge: kb, catalog }), tools: [searchProcedures] });
  const evidence = createEvidenceTarget(() => ({
    ...base,
    photoModel,
    objects: stage.objects.evidence,
    network,
    capStore: stage.runtimeStore,
    globalCaps: () => LOCAL_GLOBAL_CAPS,
    cases: photoAttemptsCases(stage.cases),
    outbound: pipelineEvidenceOutbound(stage.outbound, stage.log),
  }));
  const messaging = createToolHandler({ target: "messaging", deps: () => ({ ...base, outbound: () => stage.outbound }), tools: [...MESSAGING_IMPLEMENTATIONS] });
  const cases = createCasesTools(() => ({
    ...base,
    outbound: stage.cases.outbound,
    timers: stage.timers,
    turns: stage.cases.turns,
    summaries: stage.summaries,
    certificates: stage.certificates,
    network,
  }));
  return { orders, knowledge: knowledgeTarget, evidence, messaging, cases, photoModel, buttonActions: caseButtonActions(stage.cases, cases) };
}
