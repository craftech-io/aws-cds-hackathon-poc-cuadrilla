// What the `QaDriver` drives but does not own (docs/build-plan.md WP-45): the world factory and the clock
// (WP-39, WP-27), the installer queue, the simulated channel's entry (`InboundWhatsApp`), the two simulated
// systems, the kill switch, the tool targets, the console's `appRouter`, the evaluation (WP-46), and the
// probes of the stage. Each is a port: the Lambda entry wires the module that owns it (stage-ports.ts), so
// an action never takes a shortcut around policy, Cedar or the outbound pipeline, and the tests drive the
// actions over fakes (testing.ts).
import type { Connector } from "../connector/ports";
import type { TableClient } from "../connector/table-client";
import type { AdvanceDeps } from "../clock/advance";
import type { EvalDeps } from "../evaluation/ports";
import type { SecretKey } from "../lib/crypto";
import type { LeadStore } from "../leads/store";
import type { Logger } from "../lib/log";
import type { NetworkClient } from "../network/client";
import type { SetKillSwitchDeps } from "../ops/kill-switch";
import type { AppCaller } from "../routers/index";
import type { DispatchControlClient } from "../services/demo-controls/dispatch-client";
import type { InstallerEventSink } from "../worker/ports";
import type { WorldsDeps } from "../worlds/deps";
import type { SeamCognito } from "./signup-fence";

/** A tool target as the driver reaches it: the Lambda, with a direct event (`{tool, input, subject}`). */
export type ToolTargetName = "ToolOrders" | "ToolKnowledge" | "ToolEvidence" | "ToolMessaging" | "ToolCases";

export interface ToolInvoker {
  invoke(target: ToolTargetName, event: { readonly tool: string; readonly input: Readonly<Record<string, unknown>>; readonly subject?: Readonly<Record<string, string>>; readonly correlationId?: string }): Promise<unknown>;
}

/** The principal an id token of `auth.qaLogin` stands for, and the `appRouter` as that principal. */
export interface TokenPrincipal {
  readonly caller: AppCaller;
  readonly clockId: string;
  readonly ispId: string;
  readonly userId: string;
  readonly role: string;
  readonly isGuest: boolean;
}

export interface ConsoleCallers {
  /** The `appRouter` as a principal the driver builds (`SUPERVISOR`, `OPS`, `GUEST`) of one world. */
  server(options: { readonly role: "SUPERVISOR" | "OPS" | "GUEST"; readonly clockId: string; readonly authTime?: number; readonly sessionId?: string; readonly runId?: string; readonly correlationId: string }): AppCaller;
  /** The `appRouter` with a verified id token of `auth.qaLogin` (the post authentication and pre token ran). */
  token(idToken: string, correlationId: string): Promise<TokenPrincipal>;
  /** A public call of the QA seam: no principal, the run's counters (`createQaPublicContext`). */
  public(runId: string, correlationId: string): AppCaller;
  /** Query or mutation of a procedure; `undefined` when the router has no such procedure. */
  procedureKind(procedure: string): "query" | "mutation" | undefined;
}

/** One object of the `Media` bucket the channel will read (a sample of the set, or bytes the driver built). */
export interface SimMedia {
  copyFromSeed(input: { readonly sourceKey: string; readonly key: string; readonly contentType: string }): Promise<void>;
  put(input: { readonly key: string; readonly bytes: Uint8Array; readonly contentType: string }): Promise<void>;
}

export interface DlqMessage {
  readonly eventId: string;
  readonly clockId?: string;
  readonly type?: string;
  readonly receiptHandle: string;
}

export interface DlqPort {
  /** Messages of the DLQ (received and left there: their visibility is a few seconds). */
  receive(): Promise<DlqMessage[]>;
  remove(receiptHandle: string): Promise<void>;
}

export interface AlarmTransition {
  readonly alarmName: string;
  readonly timestamp: string;
  readonly summary: string;
}

export interface MemoryRecordView {
  readonly memoryRecordId: string;
  readonly namespace: string;
  readonly createdAt: string;
  readonly text: string;
}

export interface MemoryEventView {
  readonly eventId: string;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly texts: readonly string[];
}

/** AgentCore Memory as `memory.inspect` reads it (never written by the driver; the purge is `world.destroy`). */
export interface MemoryReader {
  listRecords(namespacePrefix: string): Promise<MemoryRecordView[]>;
  listSessions(actorId: string): Promise<string[]>;
  listEvents(actorId: string, sessionId: string): Promise<MemoryEventView[]>;
}

export interface PolicyAuditPort {
  /** `PolicyAudit` over one world; its counts (never a message). */
  run(clockId: string): Promise<{ readonly messages: number; readonly emails: number; readonly certificates: number; readonly violations: number; readonly errors: number }>;
}

/** The QA seam's view of the own sign-up's stores (ADR-0025 §7). */
export interface SignupSeamPorts {
  readonly cognito: SeamCognito;
  readonly leads: Pick<LeadStore, "get" | "listEvents">;
  readonly emailHash: (email: string) => string;
  /** A password for a `gst-*` user: derived on the server, never in a request, a result or a report. */
  readonly passwordOf: (username: string) => string;
  /** `GuestAccountDeletion` with `{userId}` (the driver has no `AdminDeleteUser`). */
  readonly deleteAccount: (userId: string) => Promise<unknown>;
}

export interface StageProbes {
  /** `GET /v1/health` of both mocks with the driver's role. */
  mocksHealth(): Promise<{ readonly network: "OK" | "UNAVAILABLE"; readonly dispatch: "OK" | "UNAVAILABLE" }>;
  /** `ApplyGuardrail` of G1 over a text (`guardrail.probe`). */
  applyG1(text: string): Promise<{ readonly action: string; readonly policies: readonly string[] }>;
  /** The three clients of the pool, the pool's verification setting and the JWKS (`auth.probe`). */
  authConfig(): Promise<unknown>;
  /** The two web ACLs and their associations (`waf.probe`). */
  webAcls(): Promise<unknown>;
  alarmHistory(sinceReal: string): Promise<AlarmTransition[]>;
  /** Publishes a foreign event on our topic with `qa-foreign=1`; SNS's message id (the probe's key). */
  publishForeign(input: { readonly eventId: string; readonly sentAtReal: Date }): Promise<{ readonly snsMessageId: string }>;
}

export interface QaPorts {
  readonly data: Connector;
  readonly client: TableClient;
  readonly worlds: WorldsDeps;
  readonly clock: AdvanceDeps;
  readonly queue: InstallerEventSink;
  /** `InboundWhatsApp` with the simulator's signed envelope (the same entry the console's phone uses). */
  readonly inbound: (event: unknown) => Promise<unknown>;
  readonly simEnvelopeKey: () => SecretKey;
  readonly hashPhone: (phone: string) => string;
  readonly media: SimMedia;
  readonly network: Pick<NetworkClient, "setBehaviour" | "reportPhysicalAction">;
  readonly dispatch: DispatchControlClient;
  readonly tools: ToolInvoker;
  readonly console: ConsoleCallers;
  /** The evaluation's dependencies (WP-46) over this driver's own actions. */
  readonly evaluation: (log: Logger) => EvalDeps;
  readonly kill: SetKillSwitchDeps;
  readonly memory: MemoryReader;
  readonly dlq: DlqPort;
  readonly policyAudit: PolicyAuditPort;
  readonly probes: StageProbes;
  readonly signup: () => SignupSeamPorts;
  /** `SeedOverrides.demoRecipients` (the fence of the demo world, FL-076); never logged nor returned. */
  readonly demoRecipients: () => readonly string[];
  /** The runtime session subkey (Memory actors are computed by turns/identity.ts). */
  readonly runtimeSessionKey: () => SecretKey;
}
