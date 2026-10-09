/// <reference path="../../sst-env.d.ts" />
// The `QaDriver`'s ports in the stage (handlers/qa-driver.ts), built once per container from what SST links
// to it. The console's ports (routers/console-ports.ts) are the same ones the `Bff` uses: the installer
// queue, the Scheduler and its dispatcher, the two simulated systems, the simulator's objects and its way
// into `InboundWhatsApp`; the world factory is the stage's (worlds/stage.ts) with the queue, so a `case`
// preset runs in the installer's worker. The AWS adapters proper are in stage-aws.ts.
import { ToolError, ispIdOfClock } from "@cuadrilla/shared";
import { createCognitoIdTokenVerifier } from "../auth/jwt";
import { principalFromClaims } from "../auth/principal";
import { connector, tableClient } from "../connector/index";
import { presetOnuSetter } from "../evaluation/index";
import type { EvalChannel, EvalDeps } from "../evaluation/ports";
import { leadEmailHash } from "../leads/keys";
import { dynamoLeadStore } from "../leads/dynamo-table";
import { hmacSha256Base64Url } from "../lib/crypto";
import { type Logger, createLogger } from "../lib/log";
import { seedOverrides, subkey } from "../lib/secrets";
import { killSwitchReader, runtimeStore } from "../ops/defaults";
import { consolePortsOf } from "../routers/console-ports";
import { defaultDeps } from "../routers/deps";
import { appRouter } from "../routers/index";
import { QA_FORCE_EXPIRE, QaForceExpireAnswer } from "../guest/qa-expire";
import { type Context, createCallerFactory, createQaPublicContext, createServerContext } from "../routers/trpc";
import { linkedG1Prefilter } from "../turns/prefilter";
import { stageWorldsDeps } from "../worlds/stage";
import { loadTemplate } from "../worlds/templates";
import { evalInboundKey, sendInbound } from "./channel";
import type { GuardLookups } from "./guard";
import { connectorLookups } from "./lookups";
import type { ConsoleCallers, QaPorts } from "./ports";
import { settle } from "./settle";
import { agentCoreMemoryReader, authConfiguration, cognitoSeam, dlqAlarmHistory, invokeLinked, lambdaTools, publishForeign, putMediaObject, qaTargets, sqsDlq, webAcls } from "./stage-aws";

const createAppCaller = createCallerFactory(appRouter);

type ProcedureNode = { readonly _def?: { readonly type?: string } };

/** Query or mutation of a procedure of the `appRouter` (`clock.jumpToScene` → mutation). */
export function procedureKindOf(path: string): "query" | "mutation" | undefined {
  const procedures = (appRouter as unknown as { _def: { procedures: Record<string, ProcedureNode> } })._def.procedures;
  const type = procedures[path]?._def?.type;
  return type === "query" || type === "mutation" ? type : undefined;
}

function consoleCallers(): ConsoleCallers {
  const deps = defaultDeps();
  let qaProbeVerifier: ReturnType<typeof createCognitoIdTokenVerifier> | undefined;
  return {
    server: (options) => createAppCaller(createServerContext(options, deps)),
    public: (correlationId) => createAppCaller(createQaPublicContext({ correlationId }, deps)),
    async token(idToken, correlationId) {
      const targets = qaTargets();
      qaProbeVerifier ??= createCognitoIdTokenVerifier({ userPoolId: targets.userPoolId, clientId: targets.clients.qaProbe });
      const principal = principalFromClaims(await qaProbeVerifier.verify(idToken));
      const context: Context = { correlationId, principal, authFailure: null, deps, log: deps.loggerFor(correlationId), edge: null };
      return { caller: createAppCaller(context), clockId: principal.clockId, ispId: principal.ispId, userId: principal.userId, role: principal.role, isGuest: principal.isGuest };
    },
    procedureKind: procedureKindOf,
  };
}

/** The password of a `gst-*` user of the seam: a keyed digest, never stored, never in a result. */
export function seamPasswordOf(key: Uint8Array | string, username: string): string {
  return `Qa!${hmacSha256Base64Url(key, `qa-signup-password/${username}`).slice(0, 24)}9z`;
}

function evalChannel(ports: QaPorts): EvalChannel {
  return {
    async sendText({ clockId, installerId, text, attempt }) {
      const sent = await sendInbound(ports, { clockId, identity: installerId, content: { type: "text", text }, key: evalInboundKey({ clockId, installerId, attempt }), now: new Date() });
      return { messageId: sent.wamid };
    },
    async tapButton({ clockId, installerId, action, nonce, attempt }) {
      await sendInbound(ports, { clockId, identity: installerId, content: { type: "button", action }, key: evalInboundKey({ clockId, installerId, attempt, tapNonce: nonce }), now: new Date() });
    },
    async settleInstaller({ installerId, timeoutSec }) {
      const person = await ports.data.people.requirePerson(installerId);
      await settle({ data: ports.data, now: () => new Date(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }, { clockId: person.clockId, installerId, timeoutSec, holdSec: 10 });
    },
  };
}

function evaluation(ports: QaPorts, log: Logger, callKey: string): EvalDeps {
  return {
    callKey,
    connector: ports.data,
    client: ports.client,
    channel: evalChannel(ports),
    tools: {
      validatePhoto: async (call) =>
        (await ports.tools.invoke("ToolEvidence", {
          tool: "validate_install_photo",
          input: { caller: { kind: "QA", ispId: call.ispId, clockId: call.clockId }, candidateId: call.candidateId, item: call.item },
          subject: { installerId: call.installerId, workOrderId: call.workOrderId },
        })) as Awaited<ReturnType<EvalDeps["tools"]["validatePhoto"]>>,
      setOnu: presetOnuSetter(ports.worlds),
    },
    evalTemplate: () => loadTemplate(ports.worlds.templates, "eval"),
    log,
    now: () => new Date(),
  };
}

let built: QaPorts | undefined;

export function stageQaPorts(): QaPorts {
  if (built !== undefined) return built;
  const log = createLogger({ bindings: { service: "qa-driver" } });
  const deps = defaultDeps();
  const consolePorts = consolePortsOf(deps);
  const data = connector();
  const g1 = linkedG1Prefilter();
  const ports: QaPorts = {
    data,
    client: tableClient(),
    worlds: stageWorldsDeps({ log, dispatcher: consolePorts.dispatcher, queue: consolePorts.queue, certificates: "janitor" }),
    clock: { data, scheduler: consolePorts.scheduler, dispatcher: consolePorts.dispatcher, realClock: consolePorts.services.realClock, log },
    queue: consolePorts.queue,
    inbound: consolePorts.inbound,
    simEnvelopeKey: consolePorts.simEnvelopeKey,
    hashPhone: consolePorts.hashPhone,
    media: { copyFromSeed: (input) => consolePorts.objects.copyFromSeed(input), put: putMediaObject },
    network: consolePorts.network,
    dispatch: consolePorts.dispatch,
    tools: lambdaTools,
    console: consoleCallers(),
    evaluation: (requestLog, callKey) => evaluation(ports, requestLog, callKey),
    kill: { store: runtimeStore(), reader: killSwitchReader(), logger: log, audit: async (event) => void (await data.audit.append({ ispId: ispIdOfClock(event.record.clockId ?? ""), ...(event.record.clockId === undefined ? {} : { clockId: event.record.clockId }), decision: "ACTION", action: "KILL_SWITCH_SET", actor: "QA", detail: { scope: event.record.scope, state: event.record.state } })) },
    memory: agentCoreMemoryReader,
    dlq: sqsDlq,
    policyAudit: {
      async run(clockId) {
        const answer = (await invokeLinked("PolicyAudit", { clockId })) as { worlds?: Array<{ messages: number; emails: number; certificates: number; violations: number; errors: number }> };
        const world = answer.worlds?.[0];
        if (world === undefined) throw new ToolError("UNAVAILABLE", "PolicyAudit answered no world");
        return world;
      },
    },
    probes: {
      mocksHealth: () => deps.mocks(log),
      async applyG1(text) {
        const verdict = await g1.check(text);
        return { action: verdict.action === "BLOCKED" ? "GUARDRAIL_INTERVENED" : verdict.action, policies: verdict.action === "BLOCKED" ? [verdict.policy] : [] };
      },
      authConfig: authConfiguration,
      webAcls,
      alarmHistory: dlqAlarmHistory,
      publishForeign,
    },
    signup: () => ({
      forceExpire: async (userId) => QaForceExpireAnswer.parse(await invokeLinked("GuestWorlds", { op: QA_FORCE_EXPIRE, userId })),
      cognito: cognitoSeam,
      leads: dynamoLeadStore(),
      emailHash: (email) => leadEmailHash(subkey("email-hash"), email),
      passwordOf: (username) => seamPasswordOf(subkey("session"), username),
      deleteAccount: (userId) => invokeLinked("GuestAccountDeletion", { userId, actor: "SYSTEM" }),
    }),
    demoRecipients: () => seedOverrides().demoRecipients?.emails ?? [],
    runtimeSessionKey: () => subkey("runtime-session"),
  };
  built = ports;
  return ports;
}

/** Where the rows an input names live, read from the stage's tables (guard.ts). */
export function stageLookups(ports: Pick<QaPorts, "data" | "console">): GuardLookups {
  return connectorLookups(ports.data, (procedure) => ports.console.procedureKind(procedure));
}
