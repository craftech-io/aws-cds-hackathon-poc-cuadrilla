// Test kit of the `QaDriver` (never imported by a Lambda): its ports over the memory world factory of WP-39
// (the committed templates, the memory connector on a movable real clock) with recording fakes of what
// leaves the driver (the installer queue, `InboundWhatsApp`, the tool Lambdas, the mocks, the seam's
// Cognito), and the driver itself over those ports with an instant `sleep` that moves the harness clock.
import { createLogger } from "../lib/log";
import { deriveSubkey } from "../lib/crypto";
import { createMemoryRuntimeStore } from "../ops/memory-runtime-store";
import type { InstallerQueueEventInput } from "../worker/events";
import { type WorldsHarness, TEST_MASTER_KEY, worldsHarness } from "../worlds/testing";
import { type QaDriver, createQaDriver } from "./driver";
import type { GuardLookups } from "./guard";
import { buildHandlers } from "./handlers";
import type { QaPorts, ToolTargetName } from "./ports";
import type { SeamCognito, SeamUser } from "./signup-fence";
import { connectorLookups } from "./lookups";

export const SIM_ENVELOPE_KEY = deriveSubkey(TEST_MASTER_KEY, "sim-envelope");

/** Cognito of the seam in memory: users by name, and what the seam asked of it. */
export class FakeSeamCognito implements SeamCognito {
  readonly users = new Map<string, SeamUser>();
  readonly confirmed: string[] = [];
  readonly signIns: string[] = [];
  readonly signUps: Array<{ readonly username: string; readonly ticket?: string }> = [];

  async getUser(username: string): Promise<SeamUser | undefined> {
    return this.users.get(username);
  }
  async confirm(username: string): Promise<void> {
    this.confirmed.push(username);
    const user = this.users.get(username);
    if (user !== undefined) this.users.set(username, { ...user, status: "CONFIRMED" });
  }
  async adminSignIn(username: string): Promise<{ readonly idToken: string }> {
    this.signIns.push(username);
    return { idToken: `token-of-${username}` };
  }
  async signUp(input: { readonly username: string; readonly email: string; readonly ticket?: string }): Promise<void> {
    this.signUps.push({ username: input.username, ...(input.ticket === undefined ? {} : { ticket: input.ticket }) });
    if (this.users.has(input.username)) throw Object.assign(new Error("User already exists"), { name: "UsernameExistsException" });
    if (input.ticket === undefined) throw Object.assign(new Error("PreSignUp failed with error TICKET_INVALID."), { name: "UserLambdaValidationException" });
    this.users.set(input.username, { username: input.username, status: "UNCONFIRMED", email: input.email, emailVerified: false });
  }
}

export interface MemoryQaPorts {
  readonly ports: QaPorts;
  readonly harness: WorldsHarness;
  readonly queued: InstallerQueueEventInput[];
  readonly inbound: unknown[];
  readonly toolCalls: Array<{ readonly target: ToolTargetName; readonly event: unknown }>;
  readonly deletions: string[];
  readonly cognito: FakeSeamCognito;
}

const unavailable = (what: string) => () => {
  throw new Error(`${what} is not part of this harness`);
};

export function memoryQaPorts(options: { readonly start?: string } = {}): MemoryQaPorts {
  const queued: InstallerQueueEventInput[] = [];
  const queue = { enqueue: async (event: InstallerQueueEventInput) => void queued.push(event) };
  const harness = worldsHarness({ ...(options.start === undefined ? {} : { start: options.start }), queue });
  const inbound: unknown[] = [];
  const toolCalls: MemoryQaPorts["toolCalls"] = [];
  const deletions: string[] = [];
  const cognito = new FakeSeamCognito();
  const realClock = { now: async () => harness.now() };
  const log = createLogger({ sink: () => undefined });
  const ports: QaPorts = {
    data: harness.connector,
    client: harness.client,
    worlds: harness.deps,
    clock: { data: harness.connector, scheduler: harness.scheduler, dispatcher: harness.dispatcher, realClock, log },
    queue,
    inbound: async (event) => {
      inbound.push(event);
      return { accepted: 1 };
    },
    simEnvelopeKey: () => SIM_ENVELOPE_KEY,
    hashPhone: (phone) => phone,
    media: { copyFromSeed: async () => undefined, put: async () => undefined },
    network: { setBehaviour: async () => ({ kind: "UNAVAILABLE", reason: "NOT_CONFIGURED", attempts: 0 }), reportPhysicalAction: async () => ({ kind: "UNAVAILABLE", reason: "NOT_CONFIGURED", attempts: 0 }) },
    dispatch: { command: async () => ({ kind: "UNAVAILABLE", reason: "NOT_CONFIGURED" }) } as unknown as QaPorts["dispatch"],
    tools: {
      invoke: async (target, event) => {
        toolCalls.push({ target, event });
        return { ok: true };
      },
    },
    console: { server: unavailable("console"), public: unavailable("console"), token: unavailable("console"), procedureKind: (procedure) => (procedure.endsWith(".list") || procedure.endsWith(".get") ? "query" : procedure.includes(".") ? "mutation" : undefined) },
    evaluation: unavailable("evaluation"),
    kill: { store: createMemoryRuntimeStore(), realClock },
    memory: { listRecords: async () => [], listSessions: async () => [], listEvents: async () => [] },
    dlq: { receive: async () => [], remove: async () => undefined },
    policyAudit: { run: async () => ({ messages: 0, emails: 0, certificates: 0, violations: 0, errors: 0 }) },
    probes: {
      mocksHealth: async () => ({ network: "OK", dispatch: "OK" }),
      applyG1: async () => ({ action: "GUARDRAIL_INTERVENED", policies: ["PROMPT_ATTACK"] }),
      authConfig: async () => ({}),
      webAcls: async () => ({}),
      alarmHistory: async () => [],
      publishForeign: async () => ({ snsMessageId: "sns-1" }),
    },
    signup: () => ({
      cognito,
      leads: { get: async () => undefined, listEvents: async () => [] },
      emailHash: (email) => `hash-${email}`,
      passwordOf: (username) => `pw-${username}`,
      deleteAccount: async (userId) => {
        deletions.push(userId);
        return { outcome: "DELETED", deletedUsers: 1 };
      },
    }),
    demoRecipients: () => [],
    runtimeSessionKey: () => deriveSubkey(TEST_MASTER_KEY, "runtime-session"),
  };
  return { ports, harness, queued, inbound, toolCalls, deletions, cognito };
}

/** The driver over memory ports: `sleep` moves the harness's real clock instead of waiting. */
export function memoryDriver(memory: MemoryQaPorts, lookups: GuardLookups = connectorLookups(memory.ports.data, memory.ports.console.procedureKind)): QaDriver {
  return createQaDriver({
    data: memory.ports.data,
    lookups,
    handlers: buildHandlers(memory.ports),
    now: () => memory.harness.now(),
    sleep: async (ms) => memory.harness.advance(ms),
    loggerFor: (correlationId) => createLogger({ correlationId, sink: () => undefined }),
  });
}
