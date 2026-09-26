// The five tool Lambdas of the agent, one per Gateway target (docs/architecture.md §9.2, §12 and §14,
// docs/tool-catalog.md, docs/build-plan.md WP-26): ToolOrders, ToolKnowledge, ToolEvidence, ToolMessaging and
// ToolCases. Each one runs `packages/bff/src/agent-tools/<target>/index.handler`, the `createToolHandler`
// wrapper of WP-25 over that target's tools (their implementations arrive in wave 3 and answer UNAVAILABLE
// until then). Runtime (Node 22), architecture (arm64) and log retention come from the $transform of
// sst.config.ts; timeout, memory and reserved concurrency from TOOL_LAMBDAS of infra/agentcore-spec.ts.
//
// Least privilege (infra/iam-capabilities.ts). Every target links its tables and buckets by name
// (`storageLinks`, no permission) with the exact item and object actions of `storagePermissions`, and
// SessionTokenKey (the wrapper verifies the sessionToken with its `session` subkey). Every other grant it
// holds travels with its carrier (`toolCarriers`, infra/agentcore-spec.ts; the test checks the mapping is
// total): the Linkable of the module that owns the resource, whose `include` is exactly that grant
// (NetworkMock, GuardrailG2/G3, EmailChannel, Scheduler, KnowledgeBase, PhotoModel, CertificateWriter), the
// statements on our WhatsApp number (`whatsappPermissions`, none while it is `not-connected`) and object
// prefixes of a bucket (`StoragePrefix`: SEND_WHATSAPP's reads of certificates and photos, ToolEvidence's
// writes of photos). PIPELINE holders also link, for their runtime, the stage's transports, SeedOverrides,
// BrandConfig and the sending number; ToolEvidence links CostCaps (the global ceiling reserved before
// `Converse`, ADR-0019).
//
// Late links (infra/late-links.ts). `Scheduler` (TIMERS) lives in infra/scheduler.ts and `CertificateWriter`
// in infra/certificates.ts (WP-38), both evaluated after this module: the first is required (a tool that
// arms a timer must not ship without it), the second optional (ToolCases answers UNAVAILABLE for the
// certificate until WP-38 exports it; the deploy log says so).
//
// Who invokes a target: the Gateway role, named in each target's resource policy, and the QaDriver (direct
// probes with `caller QA`, WP-38). Within one account an identity policy alone also invokes, so the fence that
// counts is that no other role of infra/iam-capabilities.ts holds lambda:InvokeFunction on a target (the test
// holds it). The worker, the console and the local flows call the handlers in process.
//
// Cost: per invocation; nothing bills while the agent is idle.
//
// Verify:
//   aws --profile craftech-demos lambda get-function-configuration --function-name <ToolX physical name>
//     → Timeout and MemorySize of TOOL_LAMBDAS, no secret in Environment
//   aws --profile craftech-demos lambda get-policy --function-name <ToolX physical name>
//     → lambda:InvokeFunction for aws-cds-hackathon-poc-cuadrilla-poc-gateway
//   aws --profile craftech-demos lambda get-function-concurrency --function-name <ToolEvidence physical name>   → 10

import { PHOTO_MODEL_ID, PHOTO_MODEL_LINK, TOOL_FUNCTIONS, TOOL_LAMBDAS, toolCarriers, toolGrantCarrier, toolHandlerPath, toolRuntimeLinks, type ToolCarrier, type ToolFunctionName, type ToolRuntimeLink } from "./agentcore-spec";
import { agentPlace, agentRoles } from "./agentcore-iam";
import { ChannelModes } from "./channel-modes";
import { CostCaps } from "./cost-caps";
import { GuardrailG2, GuardrailG3 } from "./guardrail";
import { agentModelArns, expectedGrants } from "./iam-capabilities";
import { lateLinks, links, type LinkList } from "./late-links";
import { EmailChannel } from "./messaging-email";
import { whatsappPermissions } from "./messaging-whatsapp";
import { grantStatement, mockLinks, mockPermissions, type Statement } from "./mocks";
import { GATEWAY_TARGETS, type GatewayTarget } from "./policy-rules";
import { BrandConfig, SeedOverrides, SessionTokenKey, WhatsAppPhoneNumberId } from "./secrets";
import { buckets, storageLinks, storagePermissions, storageResource } from "./storage";
import { knowledgeBaseLinks } from "./storage-kb";
import { parseStorageRef, storageFor } from "./storage-keys";

const grantsCarriedBy = (fn: ToolFunctionName, carrier: ToolCarrier) => expectedGrants(fn).filter((grant) => toolGrantCarrier(grant) === carrier);

// ---- PhotoModel: the photo validation's model (ADR-0015) ---------------------------------------------

/** ToolEvidence: `Resource.PhotoModel.modelId` (PHOTO_MODEL_ID) and exactly its grant on agentModelArns(PHOTO_MODEL_ID). */
export const PhotoModel = new sst.Linkable(PHOTO_MODEL_LINK, {
  properties: { modelId: PHOTO_MODEL_ID },
  include: grantsCarriedBy("ToolEvidence", "PhotoModel").map((grant) =>
    sst.aws.permission({ actions: [...grant.actions], resources: agentPlace().apply((place) => agentModelArns(PHOTO_MODEL_ID, place.region, place.account)) }),
  ),
});

// ---- Late links ------------------------------------------------------------------------------------

const schedulerLinks: LinkList = lateLinks("agent-tools", "scheduler", () => import("./scheduler"), ["Scheduler"]);

/** CertificateWriter of infra/certificates.ts (WP-38), exported under its SST name or camelCased; linking it grants InvokeFunction on it alone. */
const certificateWriterLinks: LinkList = $util.output(
  import("./certificates").then((module): unknown[] => {
    const writer: unknown = Reflect.get(module, "CertificateWriter") ?? Reflect.get(module, "certificateWriter");
    if (writer instanceof sst.aws.Function) return [writer];
    $util.log.warn("infra/certificates.ts exports no CertificateWriter Function yet: close_installation answers UNAVAILABLE for the certificate until it does.");
    return [];
  }),
);

// ---- Links and statements of each target --------------------------------------------------------------

const RUNTIME_LINKS: Readonly<Record<ToolRuntimeLink, unknown>> = { SessionTokenKey, ChannelModes, SeedOverrides, BrandConfig, WhatsAppPhoneNumberId, CostCaps };

/** Buckets whose object prefixes a target reaches without data access to the bucket: linked by name only. */
function prefixBuckets(fn: ToolFunctionName): sst.aws.Bucket[] {
  const linked = new Set<string>(storageFor(fn).buckets);
  const named = grantsCarriedBy(fn, "StoragePrefix").flatMap((grant) => grant.resources.map((resource) => parseStorageRef(resource)?.name ?? ""));
  return [...new Set(named)].filter((name) => !linked.has(name)).map((name) => buckets[name as keyof typeof buckets]);
}

function carrierLinks(fn: ToolFunctionName, carrier: ToolCarrier): $util.Input<unknown[]> {
  switch (carrier) {
    case "NetworkMock":
      return mockLinks(fn);
    case "Guardrails":
      return [GuardrailG2, GuardrailG3];
    case "EmailChannel":
      return [EmailChannel];
    case "Scheduler":
      return schedulerLinks;
    case "KnowledgeBase":
      return knowledgeBaseLinks(fn);
    case "PhotoModel":
      return [PhotoModel];
    case "CertificateWriter":
      return certificateWriterLinks;
    case "StoragePrefix":
      return prefixBuckets(fn);
    case "WhatsAppNumber":
      return []; // statements only (`toolPermissions`); the number's id is a runtime link
  }
}

function storagePrefixResource(resource: string): $util.Input<string> {
  const resolved = storageResource(resource);
  if (resolved === undefined) throw new Error(`infra/agent-tools.ts cannot resolve the object prefix "${resource}".`);
  return resolved;
}

/** Item and object actions of its data access, its object prefixes, its grants on our number and on the mocks' tables. */
function toolPermissions(fn: ToolFunctionName): $util.Output<Statement[]> {
  const prefixes = grantsCarriedBy(fn, "StoragePrefix").map((grant) => grantStatement(grant, storagePrefixResource));
  const number = toolCarriers(fn).includes("WhatsAppNumber") ? whatsappPermissions(fn) : [];
  return $util.all([storagePermissions(fn), prefixes, mockPermissions(fn), number]).apply((parts) => parts.flat() as Statement[]);
}

function toolFunction(target: GatewayTarget): sst.aws.Function {
  const fn = TOOL_FUNCTIONS[target];
  const spec = TOOL_LAMBDAS[target];
  return new sst.aws.Function(fn, {
    description: spec.description,
    handler: toolHandlerPath(target),
    timeout: `${spec.timeoutSeconds} seconds`,
    memory: `${spec.memoryMb} MB`,
    ...(spec.reservedConcurrency === undefined ? {} : { concurrency: { reserved: spec.reservedConcurrency } }),
    link: links([...storageLinks(fn), ...toolRuntimeLinks(fn).map((name) => RUNTIME_LINKS[name])], ...toolCarriers(fn).map((carrier) => carrierLinks(fn, carrier))),
    permissions: toolPermissions(fn),
  });
}

// ---- Functions -----------------------------------------------------------------------------------------

/** The five target Lambdas, in the order infra/agentcore.ts chains their `GatewayTarget`s. */
export const toolFunctions = Object.fromEntries(GATEWAY_TARGETS.map((target) => [target, toolFunction(target)])) as Readonly<Record<GatewayTarget, sst.aws.Function>>;

// Under their camelCased SST names: infra/mocks.ts names the callers of NetworkMock by them, infra/bff.ts the QaDriver's.
export const toolOrders = toolFunctions.orders;
export const toolKnowledge = toolFunctions.knowledge;
export const toolEvidence = toolFunctions.evidence;
export const toolMessaging = toolFunctions.messaging;
export const toolCases = toolFunctions.cases;

/** Resource policy of each target: the Gateway role, the agent's only way in. */
export const gatewayInvokePermissions: Readonly<Record<GatewayTarget, aws.lambda.Permission>> = Object.fromEntries(
  GATEWAY_TARGETS.map((target) => [
    target,
    new aws.lambda.Permission(`${TOOL_FUNCTIONS[target]}InvokeByGateway`, {
      action: "lambda:InvokeFunction",
      function: toolFunctions[target].name,
      principal: agentRoles().Gateway.arn,
    }),
  ]),
) as Record<GatewayTarget, aws.lambda.Permission>;
