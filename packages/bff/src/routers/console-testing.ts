// Support of the console's router tests and of the local UI server (tests/ui-server/): the console's
// ports over memory (never imported by runtime code). Objects live in a map that answers presigned links
// with the local server's own origin; the simulator's envelopes, the queued events, the fired timers,
// the world rebuilds and the network calls are recorded for the assertions.
import { type ConsoleRole, type WhatsAppTransport, ispKindOfIspId } from "@cuadrilla/shared";
import { type TestContextDeps, createTestIssuer, testContextDeps } from "../auth/testing";
import { type MemoryConnector, createMemoryConnector } from "../connector/index";
import { DEMO, REAL_NOW, type ServiceWorld, type WorldSpec, hashPhone, serviceWorld } from "../services/people/testing";
import { type OnuControlState, type OnuStatus } from "@cuadrilla/network-contract";
import type { WorldRebuild } from "../clock/reset";
import type { Connector } from "../connector/ports";
import type { TableClient } from "../connector/table-client";
import { type Clock, fixedClock } from "../lib/clock";
import type { BucketName } from "../lib/resource";
import type { BrandConfigValue } from "../lib/secret-schemas";
import type { NetworkClient } from "../network/client";
import type { GlobalCostCaps } from "../ops/cost-caps";
import { createKillSwitchReader } from "../ops/kill-switch";
import { type MemoryRuntimeStore, createMemoryRuntimeStore } from "../ops/memory-runtime-store";
import type { ConsoleQueueEvent } from "../services/case-console/queue";
import type { DispatchControlClient } from "../services/demo-controls/dispatch-client";
import { RecordingDispatcher, RecordingScheduler } from "../timers/testing";
import { type ConsoleObjects, type ConsolePorts, type EvalRunRef, type PresignGetInput, bindConsolePorts } from "./console-ports";
import { type AppCaller, appRouter, createQaCaller } from "./index";
import { type ServerCallOptions, createCallerFactory, createContextFactory } from "./trpc";

export interface StoredBlob {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface MemoryObjects extends ConsoleObjects {
  /** `<bucket>/<key>` → object. */
  readonly blobs: Map<string, StoredBlob>;
  put(bucket: BucketName, key: string, bytes: Uint8Array, contentType: string): void;
  get(bucket: BucketName, key: string): Promise<StoredBlob | undefined>;
}

/** Where a missing object of the local server is read from (the repository's seed files). */
export type ObjectFallback = (bucket: BucketName, key: string) => Promise<StoredBlob | undefined>;

/** The buckets in memory; links point at `<origin>/s3/<bucket>/<key>` (the UI server serves them). */
export function memoryObjects(origin = "http://127.0.0.1:0", fallback?: ObjectFallback): MemoryObjects {
  const blobs = new Map<string, StoredBlob>();
  const path = (bucket: BucketName, key: string) => `${bucket}/${key}`;
  const get = async (bucket: BucketName, key: string): Promise<StoredBlob | undefined> => blobs.get(path(bucket, key)) ?? (await fallback?.(bucket, key));
  const link = (input: PresignGetInput) => {
    const query = new URLSearchParams({ "response-content-type": input.contentType, ...(input.download === undefined ? {} : { "response-content-disposition": `attachment; filename="${input.download}"` }) });
    return `${origin}/s3/${input.bucket}/${input.key.split("/").map(encodeURIComponent).join("/")}?${query.toString()}`;
  };
  return {
    blobs,
    put: (bucket, key, bytes, contentType) => void blobs.set(path(bucket, key), { bytes, contentType }),
    get,
    presignGet: async (input) => link(input),
    presignPost: async (input) => ({ url: `${origin}/s3/Media`, fields: { key: input.key, "Content-Type": input.contentType, "x-max-bytes": String(input.maxBytes) } }),
    media: {
      async head(key) {
        const blob = await get("Media", key);
        return blob === undefined ? undefined : { bytes: blob.bytes.length, contentType: blob.contentType };
      },
      async readStart(key, count) {
        return (await get("Media", key))?.bytes.slice(0, count) ?? new Uint8Array();
      },
      delete: async (key) => void blobs.delete(path("Media", key)),
    },
    async copyFromSeed(input) {
      const source = await get("Seed", input.sourceKey);
      if (source === undefined) throw new Error(`no seed object ${input.sourceKey}`);
      blobs.set(path("Media", input.key), { bytes: source.bytes, contentType: input.contentType });
    },
    async manualText(version, sectionId) {
      const blob = await get("Manual", `manual/${version}/${sectionId}.md`);
      return blob === undefined ? undefined : new TextDecoder().decode(blob.bytes);
    },
    exists: async (bucket, key) => (await get(bucket, key)) !== undefined,
  };
}

/** A JPEG's and an Ogg's first bytes, enough for the magic-byte checks. */
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0xff, 0xd9]);
export const OGG_BYTES = new TextEncoder().encode("OggS\u0000\u0002fake-voice-note-bytes");

export interface FakeNetwork extends NetworkClient {
  readonly calls: Array<{ readonly op: string; readonly serial: string; readonly kind?: string }>;
  onu: Partial<OnuStatus>;
}

export function fakeNetwork(): FakeNetwork {
  const control = (serial: string): OnuControlState => ({ serial, behaviour: "NORMAL", fixed: false }) as unknown as OnuControlState;
  const network: FakeNetwork = {
    calls: [],
    onu: { operState: "ONLINE", rxPowerDbm: -21.4, txPowerDbm: 2.1 },
    async getOnuStatus(call) {
      network.calls.push({ op: "status", serial: call.serial });
      return { kind: "OK", attempts: 1, value: { serial: call.serial, operState: "ONLINE", observedAt: "2026-10-13T15:20:00.000Z", ...network.onu } as OnuStatus };
    },
    async reportPhysicalAction(call) {
      network.calls.push({ op: "action", serial: call.serial, kind: call.kind });
      return { kind: "OK", attempts: 1, value: control(call.serial) };
    },
    async setBehaviour(call) {
      network.calls.push({ op: "behaviour", serial: call.serial });
      return { kind: "OK", attempts: 1, value: control(call.serial) };
    },
    health: async () => ({ kind: "OK", attempts: 1, value: {} }),
  };
  return network;
}

export interface RecordingRebuild extends WorldRebuild {
  readonly reloads: Array<{ readonly clockId: string; readonly sceneId?: string; readonly worldEpoch: number }>;
}

/** The world factory's half of a reset: records the reload and stands the clock at the template's start. */
export function recordingRebuild(startAtSim = "2026-10-13T07:00:00-06:00", scenes: Readonly<Record<string, string>> = {}): RecordingRebuild {
  const reloads: RecordingRebuild["reloads"] = [];
  return {
    reloads,
    async reload(input) {
      reloads.push({ clockId: input.clockId, worldEpoch: input.worldEpoch, ...(input.sceneId === undefined ? {} : { sceneId: input.sceneId }) });
      const sceneAtSim = input.sceneId === undefined ? undefined : (scenes[input.sceneId] ?? startAtSim);
      return { startAtSim, ...(sceneAtSim === undefined ? {} : { sceneAtSim }) };
    },
    purgeMemory: async () => undefined,
  };
}

export interface MemoryConsolePorts extends ConsolePorts {
  readonly objects: MemoryObjects;
  readonly network: FakeNetwork;
  readonly rebuild: RecordingRebuild;
  readonly scheduler: RecordingScheduler;
  readonly dispatcher: RecordingDispatcher;
  readonly queued: ConsoleQueueEvent[];
  readonly envelopes: unknown[];
  readonly runtimeStore: MemoryRuntimeStore;
  readonly evalRunPointers: Map<"Q" | "P", EvalRunRef>;
  readonly read: string[];
  /** What `InboundWhatsApp` does with each envelope (recorded only, by default). */
  onInbound: ((event: unknown) => Promise<unknown>) | undefined;
  transports: WhatsAppTransport[];
  brandConfig: BrandConfigValue;
}

export interface MemoryPortsOptions {
  readonly connector: Connector;
  readonly client: TableClient;
  readonly hashPhone: (phone: string) => string;
  /** Real time of the ports (caps, uploads, schedules); fixed by default. */
  readonly realClock?: Clock;
  readonly origin?: string;
  readonly fallback?: ObjectFallback;
  /** What `InboundWhatsApp` does with the simulator's envelope; recorded only, by default. */
  readonly inbound?: (event: unknown) => Promise<unknown>;
  readonly globalCaps?: GlobalCostCaps;
}

export function memoryConsolePorts(options: MemoryPortsOptions): MemoryConsolePorts {
  const realClock = options.realClock ?? fixedClock("2026-11-02T18:00:00.000Z");
  const runtimeStore = createMemoryRuntimeStore();
  const kill = createKillSwitchReader({ store: runtimeStore, realClock, ttlMs: 0 });
  const queued: ConsoleQueueEvent[] = [];
  const envelopes: unknown[] = [];
  const read: string[] = [];
  const evalRunPointers = new Map<"Q" | "P", EvalRunRef>();
  let sequence = 0;
  const dispatch: DispatchControlClient = { send: async () => ({ kind: "OK", status: 202 }) } as unknown as DispatchControlClient;
  const ports: MemoryConsolePorts = {
    services: { connector: options.connector, realClock },
    client: options.client,
    queue: { enqueue: async (event) => void queued.push(event) },
    scheduler: new RecordingScheduler(),
    dispatcher: new RecordingDispatcher(),
    rebuild: recordingRebuild(),
    network: fakeNetwork(),
    dispatch,
    hashPhone: options.hashPhone,
    addresses: () => ({}),
    objects: memoryObjects(options.origin, options.fallback),
    async inbound(event) {
      envelopes.push(event);
      return ports.onInbound?.(event);
    },
    simEnvelopeKey: () => "sim-envelope-test-key",
    simulatedTransport: () =>
      ({
        channel: "WHATSAPP",
        transport: "simulated",
        send: async () => ({ ok: false }),
        markThreadRead: async (personId: string) => {
          read.push(personId);
          return 0;
        },
      }) as unknown as ReturnType<ConsolePorts["simulatedTransport"]>,
    brand: () => ports.brandConfig,
    costCaps: { store: runtimeStore, globalCaps: () => options.globalCaps ?? { turnsPerDay: 1_000, validationsPerDay: 1_000, transcribeSecondsPerDay: 36_000 }, kill, realClock },
    kill,
    stageTransports: () => ports.transports,
    evalRuns: { latest: async (kind) => evalRunPointers.get(kind) },
    newId: () => `01K7SIM${String(++sequence).padStart(19, "0")}`,
    queued,
    envelopes,
    runtimeStore,
    evalRunPointers,
    read,
    onInbound: options.inbound,
    transports: ["simulated"],
    brandConfig: { mode: "neutral" },
  };
  return ports;
}

// ---- A console over one (or two) service worlds ---------------------------------------------------

export interface ConsoleTestWorld {
  readonly world: ServiceWorld;
  readonly ports: MemoryConsolePorts;
  readonly deps: TestContextDeps;
  readonly memory: MemoryConnector;
  /** The console as a signed-in user of this world (registered in its operator on first use). */
  as(role?: ConsoleRole, userId?: string, claims?: Record<string, unknown>): Promise<AppCaller>;
  /** The console as the `QaDriver`'s principal of this world. */
  qa(role: ConsoleRole, options?: Partial<ServerCallOptions>): AppCaller;
}

const issuer = createTestIssuer();

/** A service world (services/people/testing.ts) behind the real `appRouter`, over memory ports. */
export async function consoleTestWorld(spec: WorldSpec = DEMO, shared?: ConsoleTestWorld): Promise<ConsoleTestWorld> {
  const memory = shared?.memory ?? createMemoryConnector({ now: () => new Date(REAL_NOW) });
  const world = await serviceWorld(spec, { deps: { connector: memory.connector } } as ServiceWorld);
  const ports = memoryConsolePorts({ connector: memory.connector, client: memory.client, hashPhone });
  const deps = bindConsolePorts(testContextDeps(issuer, { connector: memory.connector }), ports) as TestContextDeps;
  const guest = ispKindOfIspId(world.ispId) === "GUEST";
  const createCaller = createCallerFactory(appRouter);
  return {
    world,
    ports,
    deps,
    memory,
    async as(role = guest ? "GUEST" : "SUPERVISOR", userId = guest ? `usr-${world.ispId.slice("isp-".length)}` : "usr-adriana", claims = {}) {
      const sub = `sub-${world.ispId}-${userId}`;
      await memory.connector.isps.putUser({ ispId: world.ispId, userId, role, name: userId, cognitoSub: sub });
      const token = issuer.idToken({ sub, ispId: world.ispId, userId, role, isGuest: role === "GUEST" ? "true" : "false", "cognito:groups": [role], ...claims });
      return createCaller(await createContextFactory(() => deps)({ event: { headers: { authorization: `Bearer ${token}` } } }));
    },
    qa: (role, options = {}) => createQaCaller({ role, clockId: world.clockId, ...options }, deps),
  };
}
