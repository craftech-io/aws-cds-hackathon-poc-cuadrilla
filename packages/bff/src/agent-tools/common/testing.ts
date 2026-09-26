// Test support for the tools (never imported by runtime code): a `ToolRuntime` over the in-memory
// connector and kill switch store, a real clock the test moves, captured log lines, and sessions
// opened the way the worker opens them. Fixtures are the synthetic ones of docs/seed-spec.md: world
// `GLOBAL#isp-demo`, installer Rogelio with orders 24817 and 24818 on 13/10, Karina with 24819.
import { deriveSubkey } from "../../lib/crypto";
import { createLogger } from "../../lib/log";
import { type MemoryRuntimeStore, createMemoryRuntimeStore } from "../../ops/memory-runtime-store";
import { createKillSwitchReader, killSwitchKey } from "../../ops/kill-switch";
import { type SessionRecord, openSession } from "../../services/session/session";
import { CLOCK, ISP, installer, testConnector, workOrder } from "../../connector/testing";
import type { ToolRuntime } from "./context";
import type { LambdaContextLike } from "./invocation";

export const TEST_MASTER_KEY = "test-master-key-test-master-key-00000000";
export const TEST_SESSION_KEY = deriveSubkey(TEST_MASTER_KEY, "session");
/** Real instant of the tests (tokens, TTLs); the simulated instant of the turn is `TURN_AT_SIM`. */
export const REAL_T0 = "2026-10-13T15:20:00.000Z";
export const TURN_AT_SIM = "2026-10-13T09:20:00-06:00";
export const TURN_ID = "01JB8Z9Q2W3E4R5T6Y7V8X9TRN";

export interface ToolTestKit {
  readonly memory: ReturnType<typeof testConnector>;
  readonly store: MemoryRuntimeStore;
  readonly runtime: ToolRuntime;
  /** Every JSON log line written by the calls, parsed. */
  readonly logs: Array<Record<string, unknown>>;
  /** Opens a session of Rogelio's turn on wo-24817 (overridable) and returns its signed token. */
  openSession(overrides?: Partial<Omit<SessionRecord, "sessionId">>): Promise<string>;
  /** Turns the agent kill switch on, globally or for one world. */
  killAgent(clockId?: string): Promise<void>;
}

/** Rogelio's two orders on 13/10, Karina's order and Rogelio's order of 14/10, in `GLOBAL#isp-demo`. */
export async function seedDay(kit: Pick<ToolTestKit, "memory">): Promise<void> {
  const { connector } = kit.memory;
  await connector.people.createPerson(installer());
  await connector.people.createPerson(installer({ personId: "inst-karina", firstName: "Karina", phone: "+525501010002", phoneHash: "d".repeat(64) }));
  await connector.workOrders.createWorkOrder(workOrder());
  await connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24818", workOrderNumber: "24818", customerId: "cust-10422" }));
  await connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24819", workOrderNumber: "24819", customerId: "cust-10423", installerId: "inst-karina" }));
  await connector.workOrders.createWorkOrder(
    workOrder({
      workOrderId: "wo-24820",
      workOrderNumber: "24820",
      customerId: "cust-10424",
      date: "2026-10-14",
      appointmentWindow: { startSim: "2026-10-14T09:00:00-06:00", endSim: "2026-10-14T11:00:00-06:00" },
    }),
  );
}

export function toolTestKit(): ToolTestKit {
  const memory = testConnector(REAL_T0);
  const store = createMemoryRuntimeStore();
  const logs: Array<Record<string, unknown>> = [];
  const realClock = { now: async () => memory.now() };
  const runtime: ToolRuntime = {
    connector: memory.connector,
    killSwitch: createKillSwitchReader({ store, realClock, ttlMs: 0 }),
    sessionKey: () => TEST_SESSION_KEY,
    realClock,
    loggerFor: (correlationId) => createLogger({ correlationId, level: "debug", sink: (line) => logs.push(JSON.parse(line) as Record<string, unknown>), now: memory.now }),
  };
  return {
    memory,
    store,
    runtime,
    logs,
    async openSession(overrides = {}) {
      const opened = await openSession(
        { sessionKey: TEST_SESSION_KEY, store: memory.connector.runtime, nowMs: memory.now().getTime() },
        { turnId: TURN_ID, ispId: ISP, installerId: "inst-rogelio", workOrderId: "wo-24817", trigger: "INSTALLER_MESSAGE", clockId: CLOCK, eventAtSim: TURN_AT_SIM, sourceMessageId: "wamid.SIM.01", ...overrides },
      );
      return opened.token;
    },
    async killAgent(clockId) {
      await store.write(killSwitchKey("AGENT", clockId), { scope: "AGENT", ...(clockId === undefined ? {} : { clockId }), state: "on", setBy: "OPERATOR", setAtReal: REAL_T0 });
    },
  };
}

/** The context AgentCore Gateway gives a target Lambda for `<target>___<tool>`. */
export function gatewayContext(qualifiedTool: string): LambdaContextLike {
  return {
    clientContext: {
      custom: {
        bedrockAgentCoreMessageVersion: "1.0",
        bedrockAgentCoreAwsRequestId: "req-0001",
        bedrockAgentCoreMcpMessageId: "mcp-0001",
        bedrockAgentCoreGatewayId: "aws-cds-hackathon-poc-cuadrilla-poc-gw",
        bedrockAgentCoreTargetId: "TARGET01",
        bedrockAgentCoreToolName: qualifiedTool,
      },
    },
  };
}
