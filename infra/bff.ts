// The console BFF, the scenario driver and the daily policy audit (docs/architecture.md §10, §12 and
// §14, ADR-0007, ADR-0025 §3 and §7, docs/build-plan.md WP-56 and WP-38).
//
//   Bff          tRPC v11 on `/api/*` behind the Router, its Function URL with auth NONE (OAC would
//                clobber the console's `Authorization: Bearer` and cannot sign POST bodies). The edge is
//                the only way in: the Router adds `x-cuadrilla-origin` with the value of `OriginVerifyKey`
//                on every origin request (infra/web.ts; CloudFront overwrites a viewer's header of the same
//                name) and forwards `CloudFront-Viewer-Address` and the headers AWS WAF inserts
//                (AllViewerExceptHostHeader, infra/web-spec.ts). `routers/handler.ts` answers 403 without a
//                body, before parsing, to any request without the header or with another value.
//   QaDriver     `<app>-<stage>-qa-driver`, no URL, invoked only by the bootstrap's `qa-runner` role: what
//                the Bff has (it runs the real appRouter) with WORLDS fenced to QA, evaluation and the
//                test guest, plus the channel entries, the tool targets, G1, the DLQ, the topic of our
//                WABA, the pool's QA seam and the reads of the two web ACLs.
//   PolicyAudit  re-evaluates every sent message and every certificate (§12): daily and on demand.
//
// Least privilege (infra/iam-capabilities.ts, checked by infra/observability-spec.test.ts). Data by
// `link` (names only) with `storagePermissions`; the mocks with `mockLinks`/`mockPermissions`. Every grant
// a link carries complete comes with that link (observability-spec.ts `LINK_CARRIED_*`): a linked
// Function grants InvokeFunction on it alone, the queues their one role, `Scheduler` TIMERS, `Memory`
// MEMORY_ADMIN, `GuardrailG1` and `WaInbound` theirs. Every other grant of the role's row becomes a
// statement here (`Leads` with the form's attributes, Cognito and WAF on the stage's own pool and ACLs,
// the QA fences of `Runtime`, S3 and Scheduler); a placeholder nobody resolves fails the deploy.
//
// Modules created before this one whose top level a test of this module cannot evaluate (the queues,
// the scheduler, WhatsApp, the guardrails, the tool targets) are read late: sst.config.ts has already
// evaluated them, so the import returns the module and a missing export fails the deploy; only where a
// module cannot be evaluated at all (a test's fake runtime) the link is left out with a warning.
//
// Verify:
//   curl -s -o /dev/null -w "%{http_code}" -X POST "<Bff Function URL>api/signup.start"   → 403, empty body
//   curl -s https://cuadrilla.demo.craftech.io/api/health                               → {"result":{"data":{"ok":true,…}}}
//   aws --profile craftech-demos lambda get-policy --function-name aws-cds-hackathon-poc-cuadrilla-poc-qa-driver   → lambda:InvokeFunction for …-qa-runner only
//   aws --profile craftech-demos iam simulate-principal-policy --policy-source-arn <QaDriver role ARN> \
//     --action-names dynamodb:PutItem --resource-arns <Network ARN> --context-entries \
//     ContextKeyName=dynamodb:LeadingKeys,ContextKeyValues=ONU#GLOBAL#isp-demo#X,ContextKeyType=stringList   → implicitDeny
//   (and the same with KILL#AGENT, KILL#ALL on <Runtime ARN>, and with a table ARN of the other app → implicitDeny)
//   aws --profile craftech-demos events list-rule-names-by-target --target-arn <PolicyAudit ARN>   → the daily rule

import { Memory } from "./agentcore";
import { Auth, guestSignupClient, qaProbeClient, userPool, webClient } from "./auth";
import { ChannelModes } from "./channel-modes";
import { CostCaps } from "./cost-caps";
import { guestWorlds } from "./guest-worlds";
import { LAMBDA_CAPABILITIES, resolveCapabilities, type LambdaName } from "./iam-capabilities";
import { Leads, grantStatement, guestAccountDeletion, type Refs, type Statement } from "./leads";
import { mockLinks, mockPermissions } from "./mocks";
import {
  LINK_CARRIED_CAPABILITIES,
  POLICY_AUDIT,
  QA_DRIVER,
  WP38_HANDLERS,
  carriedResources,
  qaDriverFunctionName,
  qaRunnerRoleName,
  statementGrants,
  type LinkCarriedResource,
} from "./observability-spec";
import { BrandConfig, OriginVerifyKey, SeedOverrides, SessionTokenKey, WhatsAppMetaPhoneNumberId } from "./secrets";
import { evidenceBucket, seedBucket, storageLinks, storagePermissions } from "./storage";
import { authWebAcl, edgeWebAcl } from "./waf";
import { API_PATH, EDGE_BUDGETS } from "./web-spec";
import { router } from "./web";
import { WorldTemplates } from "./world-templates";

/** Entry of the tRPC handler (WP-13; the origin check and the sign-up's shape by WP-57). */
export const BFF_HANDLER = "packages/bff/src/routers/handler.handler";

// ---- Late reads -----------------------------------------------------------------------------------

const LATE_MODULES = {
  workers: () => import("./workers"),
  scheduler: () => import("./scheduler"),
  "messaging-whatsapp": () => import("./messaging-whatsapp"),
  guardrail: () => import("./guardrail"),
  "agent-tools": () => import("./agent-tools"),
  certificates: () => import("./certificates"),
} as const satisfies Record<string, () => Promise<object>>;

type LateModule = keyof typeof LATE_MODULES;
const loaded = new Map<LateModule, Promise<object | undefined>>();

/** The module, or `undefined` (and a warning) only when it cannot be evaluated here, never in a deploy. */
function lateModule(owner: LateModule): Promise<object | undefined> {
  const pending =
    loaded.get(owner) ??
    LATE_MODULES[owner]().catch((error: unknown) => {
      $util.log.warn(`infra/bff.ts could not evaluate infra/${owner}.ts (${error instanceof Error ? error.message : String(error)}); its links are left out.`);
      return undefined;
    });
  loaded.set(owner, pending);
  return pending;
}

/** What a link resolves to when its module could not be evaluated: not linkable, so SST skips it. */
const UNAVAILABLE = Object.freeze({ unavailable: true });

/** One export of a late module, as one element of a `link` array; a module that loaded without it fails the deploy. */
function lateExport(owner: LateModule, name: string): $util.Output<unknown> {
  return $util.output(
    lateModule(owner).then((module): unknown => {
      if (module === undefined) return UNAVAILABLE;
      const value: unknown = Reflect.get(module, name);
      if (value === undefined) throw new Error(`infra/${owner}.ts does not export ${name}, which infra/bff.ts links.`);
      return value;
    }),
  );
}

// ---- Links and statements of a role --------------------------------------------------------------

/** The component that carries each grant of LINK_CARRIED_RESOURCES. */
function carrier(resource: LinkCarriedResource, local: Readonly<Partial<Record<LinkCarriedResource, unknown>>>): $util.Input<unknown> {
  const own = local[resource];
  if (own !== undefined) return own;
  switch (resource) {
    case "{InstallerEvents}":
      return lateExport("workers", "InstallerEvents");
    case "{InstallerEventsDlq}":
      return lateExport("workers", "InstallerEventsDlq");
    case "{InboundWhatsApp}":
      return lateExport("messaging-whatsapp", "InboundWhatsApp");
    case "{WorldJanitor}":
      return lateExport("scheduler", "worldJanitor");
    case "{GuestWorlds}":
      return guestWorlds;
    case "{GuestAccountDeletion}":
      return guestAccountDeletion;
    case "{CertificateWriter}":
      return lateExport("certificates", "CertificateWriter");
    case "{ToolOrders}":
    case "{ToolKnowledge}":
    case "{ToolEvidence}":
    case "{ToolMessaging}":
    case "{ToolCases}":
      return lateExport("agent-tools", `tool${resource.slice(5, -1)}`);
    case "{G1}":
      return lateExport("guardrail", "GuardrailG1");
    case "{G3}":
      return lateExport("guardrail", "GuardrailG3");
    case "{PolicyAudit}":
      throw new Error("PolicyAudit is created by infra/bff.ts: pass it as a local carrier.");
    default:
      return lateExport("messaging-whatsapp", "WaInbound"); // IAM_ARNS.waTopic: sns:Publish on our topic
  }
}

/** Capability Linkables (the mocks come with `mockLinks`). */
function capabilityLinks(fn: LambdaName): Array<$util.Input<unknown>> {
  const held = resolveCapabilities(LAMBDA_CAPABILITIES[fn].capabilities).filter((name) => (LINK_CARRIED_CAPABILITIES as readonly string[]).includes(name));
  return [...(held.includes("TIMERS") ? [lateExport("scheduler", "Scheduler")] : []), ...(held.includes("MEMORY_ADMIN") ? [Memory] : [])];
}

/** Placeholders of the statements that are neither storage nor `Leads` (infra/leads.ts resolves those). */
const refs: Refs = {
  "{UserPool}": () => userPool.arn,
  "{Auth}": () => userPool.arn,
  "{EdgeWebAcl}": () => edgeWebAcl.arn,
  "{AuthWebAcl}": () => authWebAcl.arn,
};

const namesLeads = (fn: LambdaName) => statementGrants(fn).some((grant) => grant.resources.some((resource) => resource.startsWith("{Leads}")));

interface RoleAccess {
  /** One element per link (SST resolves each Output, never a nested list). */
  readonly link: Array<$util.Input<unknown>>;
  readonly permissions: $util.Output<Statement[]>;
}

/** Everything a role of this module links and is granted, from its row and nothing else. */
function roleAccess(fn: LambdaName, base: unknown[], local: Readonly<Partial<Record<LinkCarriedResource, unknown>>> = {}): RoleAccess {
  return {
    link: [...storageLinks(fn), ...(namesLeads(fn) ? [Leads] : []), ...base, ...mockLinks(fn), ...capabilityLinks(fn), ...carriedResources(fn).map((resource) => carrier(resource, local))],
    permissions: $util
      .all([storagePermissions(fn), mockPermissions(fn), statementGrants(fn).map((grant) => grantStatement(grant, refs))])
      .apply((parts) => parts.flat() as Statement[]),
  };
}

/** What the appRouter reads at run time, in the Bff and in the QaDriver alike. */
const routerLinks = [Auth, SessionTokenKey, BrandConfig, CostCaps, ChannelModes, SeedOverrides, WorldTemplates, seedBucket];

// ---- PolicyAudit --------------------------------------------------------------------------------

const auditAccess = roleAccess("PolicyAudit", [evidenceBucket]);

export const policyAudit = new sst.aws.Function("PolicyAudit", {
  description: "Daily and on-demand re-evaluation of every sent message against its ALLOW decision, and of every certificate's evidence.",
  handler: WP38_HANDLERS.PolicyAudit,
  timeout: `${POLICY_AUDIT.timeoutSeconds} seconds`,
  memory: `${POLICY_AUDIT.memoryMb} MB`,
  link: auditAccess.link,
  permissions: auditAccess.permissions,
});

export const policyAuditDaily = new sst.aws.Cron("PolicyAuditDaily", {
  function: policyAudit.arn,
  schedule: POLICY_AUDIT.schedule,
  event: { ...POLICY_AUDIT.event },
});

// ---- Bff ----------------------------------------------------------------------------------------

const budget = EDGE_BUDGETS.bff;
const bffAccess = roleAccess("Bff", routerLinks);

export const bff = new sst.aws.Function("Bff", {
  description: "Console BFF (tRPC) behind the Router; answers 403 to any request without the origin header.",
  handler: BFF_HANDLER,
  url: {
    authorization: "none",
    // Same origin as the console: no CORS.
    cors: false,
    router: { instance: router, path: API_PATH, readTimeout: `${budget.routerReadTimeoutSeconds} seconds` },
  },
  // The origin key (routers/handler.ts) is the Bff's alone: the QaDriver runs the appRouter in process.
  link: [OriginVerifyKey, ...bffAccess.link],
  permissions: bffAccess.permissions,
  timeout: `${budget.timeoutSeconds} seconds`,
  memory: `${budget.memoryMb} MB`,
  concurrency: { reserved: budget.reservedConcurrency },
});

// ---- QaDriver -----------------------------------------------------------------------------------

/** What the QA seam and the probes need to name: the pool, its three clients and the two web ACLs. */
export const QaTargets = new sst.Linkable("QaTargets", {
  properties: {
    userPoolId: userPool.id,
    clients: { consoleWeb: webClient.id, guestSignup: guestSignupClient.id, qaProbe: qaProbeClient.id },
    webAcls: {
      edge: { name: edgeWebAcl.name, id: edgeWebAcl.id, scope: "CLOUDFRONT" },
      auth: { name: authWebAcl.name, id: authWebAcl.id, scope: "REGIONAL" },
    },
  },
});

const qaAccess = roleAccess("QaDriver", [...routerLinks, QaTargets, WhatsAppMetaPhoneNumberId], { "{PolicyAudit}": policyAudit });

export const qaDriver = new sst.aws.Function("QaDriver", {
  name: qaDriverFunctionName($app.name, $app.stage),
  description: "Scenario driver of the stage, invoked only by the qa-runner role; fenced to QA, evaluation and the test guest's worlds.",
  handler: WP38_HANDLERS.QaDriver,
  timeout: `${QA_DRIVER.timeoutSeconds} seconds`,
  memory: `${QA_DRIVER.memoryMb} MB`,
  link: qaAccess.link,
  permissions: qaAccess.permissions,
});

/** Only the bootstrap's qa-runner role (ADR-0007); its ARN comes from the account the deploy runs in. */
export const qaDriverInvokeByQaRunner = aws.getCallerIdentityOutput({}).accountId.apply(
  (account) =>
    new aws.lambda.Permission("QaDriverInvokeByQaRunner", {
      action: "lambda:InvokeFunction",
      function: qaDriver.name,
      principal: `arn:aws:iam::${account}:role/${qaRunnerRoleName($app.name)}`,
    }),
);
