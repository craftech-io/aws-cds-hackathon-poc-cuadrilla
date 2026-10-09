/// <reference path="../../sst-env.d.ts" />
// What the console's feature routers run on besides `ctx.deps` (docs/tool-catalog.md "Procedimientos de
// la consola"): the deterministic handlers' dependencies, the installer queue, the clock module's
// Scheduler and dispatcher, the world factory's half of a reset, the two simulated systems, the
// objects of the buckets (presigned links, the simulator's uploads, the manual's text), the phone
// simulator's way into `InboundWhatsApp`, the brand, the cost caps and the kill switch.
//
// The Lambda builds them once per container on first use, from what SST links (`Resource` through
// lib/resource.ts and lib/secrets.ts, never `process.env`); nothing is read at import time. The
// tests, the local UI server (tests/ui-server/) and the local flows bind their own to their
// `ContextDeps` with `bindConsolePorts`, so every router of a request with those dependencies uses them.
import { CopyObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { type Caller, ToolError, type WhatsAppTransport } from "@cuadrilla/shared";
import type { Principal } from "../auth/principal";
import { type StoredObject, createS3MediaStore } from "../channels/whatsapp/media-store";
import { whatsAppTransportFactories } from "../channels/whatsapp/defaults";
import type { WindowFallbackPort } from "../channels/whatsapp/events";
import type { SimulatedTransport } from "../channels/whatsapp/simulated";
import type { WorldRebuild } from "../clock/reset";
import { connector, tableClient } from "../connector/index";
import type { TableClient } from "../connector/table-client";
import { stageQueueSink } from "../feeds/stage";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { type Clock, systemClock } from "../lib/clock";
import { type SecretKey, phoneHash, ulid } from "../lib/crypto";
import { type Logger, createLogger } from "../lib/log";
import { type EvalRunIndex, tableEvalRuns } from "../metrics/eval-runs";
import { type BucketName, bucketName, channelModes, readLinked } from "../lib/resource";
import type { BrandConfigValue } from "../lib/secret-schemas";
import { brandConfig, seedOverrides, subkey } from "../lib/secrets";
import { type NetworkClient, networkClient } from "../network/client";
import { sigv4Transport } from "../network/sigv4";
import { costCapsDeps, killSwitchReader } from "../ops/defaults";
import type { CostCapsDeps } from "../ops/cost-caps";
import type { KillSwitchReader } from "../ops/kill-switch";
import type { InstallerQueue } from "../services/case-console/queue";
import { type DispatchControlClient, createDispatchControlClient } from "../services/demo-controls/dispatch-client";
import { MEXICO_CITY_TIME_ZONE, localDateOf, toZonedIso } from "../services/business-hours/zoned-time";
import type { AddressOptions } from "../services/people/address-rules";
import type { ServiceDeps } from "../services/people/direct-call";
import type { SchedulerPort } from "../timers/scheduler-client";
import { eventBridgeScheduler } from "../timers/scheduler-client";
import { type TimerDispatcher, queueTimerDispatcher } from "../timers/dispatch";
import type { InstallerEventSink } from "../worker/ports";
import { worldRebuild } from "../worlds/rebuild";
import { stageWorldsDeps } from "../worlds/stage";
import type { ContextDeps } from "./deps";
import type { IspContext } from "./trpc";

/** A presigned POST of one object (the simulator's uploads). */
export interface PresignedPost {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface PresignGetInput {
  readonly bucket: BucketName;
  readonly key: string;
  /** Fixed by the code, never by the stored object (`nosniff` on the console). */
  readonly contentType: string;
  /** A file name: `ResponseContentDisposition=attachment` (PDFs). */
  readonly download?: string;
}

/** An object of the `Media` bucket by its key. */
export interface MediaObjects {
  head(key: string): Promise<StoredObject | undefined>;
  readStart(key: string, count: number): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

/** The buckets as the console reaches them. */
export interface ConsoleObjects {
  /** GET link of 5 minutes, issued only after the operator check of the procedure. */
  presignGet(input: PresignGetInput): Promise<string>;
  /** POST of exactly `key` in `Media`, with the size and type conditions of the upload. */
  presignPost(input: { readonly key: string; readonly contentType: string; readonly maxBytes: number }): Promise<PresignedPost>;
  /** Size, type and first bytes of what the simulator uploaded, and its deletion when refused (`Media`). */
  readonly media: MediaObjects;
  /** A file of the synthetic set (`Seed/photos/…`, `Seed/audio/…`) copied to a simulator key of `Media`. */
  copyFromSeed(input: { readonly sourceKey: string; readonly key: string; readonly contentType: string }): Promise<void>;
  /** A section of the manual in force (`Manual/manual/<version>/<sectionId>.md`); `undefined` when missing. */
  manualText(version: string, sectionId: string): Promise<string | undefined>;
  /** Whether an object exists (the partner's logos before presigning them). */
  exists(bucket: BucketName, key: string): Promise<boolean>;
}

export interface ConsolePorts {
  /** The deterministic handlers' dependencies (services/): connector, real clock, logger. */
  readonly services: ServiceDeps;
  /** The storage primitive under the connector (a reset purges the world with it). */
  readonly client: TableClient;
  /** The installer queue (`InstallerEvents.fifo`): case actions, manual validations, fired timers. */
  readonly queue: InstallerQueue;
  readonly scheduler: SchedulerPort;
  readonly dispatcher: TimerDispatcher;
  /** The world factory's half of "Reiniciar demo" and "Saltar a escena" (worlds/, WP-39). */
  readonly rebuild: WorldRebuild;
  readonly network: NetworkClient;
  readonly dispatch: DispatchControlClient;
  readonly hashPhone: (phone: string) => string;
  /** The live world's registered real phones and demo recipients (`SeedOverrides`; PII, never logged). */
  readonly addresses: () => AddressOptions;
  readonly objects: ConsoleObjects;
  /** Hands the simulator's signed envelope to `InboundWhatsApp` (the same entry a live event takes). */
  readonly inbound: (event: unknown) => Promise<unknown>;
  readonly simEnvelopeKey: () => SecretKey;
  /** The simulated transport ("marcar leído"). */
  readonly simulatedTransport: () => SimulatedTransport;
  readonly brand: () => BrandConfigValue;
  readonly costCaps: CostCapsDeps;
  readonly kill: KillSwitchReader;
  /** The WhatsApp transports of the stage (`ChannelModes`). */
  readonly stageTransports: () => readonly WhatsAppTransport[];
  readonly evalRuns: EvalRunIndex;
  /** Ids the console names itself (uploads), ULIDs stamped with real time. */
  readonly newId: (nowMs: number) => string;
}

// ---- Calls -------------------------------------------------------------------------------------

/** Who calls a deterministic handler: the principal's operator, world, user and role, never the input. */
export function callerOf(principal: Pick<Principal, "origin" | "ispId" | "clockId" | "userId" | "role">): Caller {
  return { kind: principal.origin === "QA" ? "QA" : "CONSOLE", ispId: principal.ispId, clockId: principal.clockId, userId: principal.userId, role: principal.role };
}

/** The audit actor of a principal, as the services name it. */
export function actorOf(principal: Pick<Principal, "origin" | "userId">): "QA" | `USER:${string}` {
  return principal.origin === "QA" ? "QA" : `USER:${principal.userId}`;
}

/** What a feature procedure acts with: the ports of its request and the caller its principal stands for. */
export interface ConsoleCall {
  readonly ports: ConsolePorts;
  readonly caller: Caller;
}

export function consoleCall(ctx: Pick<IspContext, "deps" | "principal">): ConsoleCall {
  return { ports: consolePortsOf(ctx.deps), caller: callerOf(ctx.principal) };
}

export interface WorldToday {
  /** The world's simulated now, in its time zone (`2026-10-13T09:20:00-06:00`). */
  readonly simNow: string;
  /** Its simulated calendar day. */
  readonly day: string;
  readonly timeZone: string;
}

/** The world's simulated now and day (ADR-0010): business time is never the machine's. */
export async function worldToday(ctx: Pick<IspContext, "deps" | "world">): Promise<WorldToday> {
  const settings = await ctx.deps.connector.isps.getSettings(ctx.world.ispId);
  const timeZone = settings?.timezone ?? MEXICO_CITY_TIME_ZONE;
  const now = await ctx.world.clock.now();
  return { simNow: toZonedIso(now, timeZone), day: localDateOf(now, timeZone), timeZone };
}

const SIM_FIELD = /Sim$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Every simulated instant of an answer (a field named `…Sim`) in the world's time zone: the connector
 * keeps them in UTC, and the console reads the wall time from the string itself (lib/world-clock.ts).
 */
export function zoneSimFields<T>(value: T, timeZone: string): T {
  const walk = (node: unknown, key: string | undefined): unknown => {
    if (typeof node === "string") return key !== undefined && SIM_FIELD.test(key) && INSTANT.test(node) ? toZonedIso(new Date(node), timeZone) : node;
    if (Array.isArray(node)) return node.map((item) => walk(item, key));
    if (typeof node === "object" && node !== null) return Object.fromEntries(Object.entries(node).map(([field, item]) => [field, walk(item, field)]));
    return node;
  };
  return walk(value, undefined) as T;
}

/** An answer with its simulated instants in the time zone of the principal's world. */
export async function inWorldTime<T>(ctx: Pick<IspContext, "deps" | "world">, value: T): Promise<T> {
  const settings = await ctx.deps.connector.isps.getSettings(ctx.world.ispId);
  return zoneSimFields(value, settings?.timezone ?? MEXICO_CITY_TIME_ZONE);
}

/** A row of the principal's world, or `NOT_FOUND` (a row of another world is never told apart). */
export function ownRow<T extends { readonly clockId: string; readonly ispId?: string }>(ctx: Pick<IspContext, "world">, row: T | undefined, what: string): T {
  if (row === undefined || row.clockId !== ctx.world.clockId || (row.ispId !== undefined && row.ispId !== ctx.world.ispId)) throw new ToolError("NOT_FOUND", `${what} not found`);
  return row;
}

// ---- Stage --------------------------------------------------------------------------------------

const REGION = "us-east-1";
const GET_LINK_SECONDS = 300;
const POST_LINK_SECONDS = 600;
const LinkedFunction = z.object({ name: z.string().min(1) });
const LinkedFunctionUrl = z.object({ url: z.url() });

function isMissing(error: unknown): boolean {
  return error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound");
}

/** The stage's buckets, clients built on first use. */
export function s3ConsoleObjects(client?: S3Client): ConsoleObjects {
  let s3 = client;
  const sdk = (): S3Client => (s3 ??= new S3Client({ region: REGION, ...awsClientConfig(CLIENT_TIMEOUTS.s3) }));
  const store = createS3MediaStore(client);
  const at = (key: string) => ({ bucket: bucketName("Media"), key });
  const media: MediaObjects = { head: (key) => store.head(at(key)), readStart: (key, count) => store.readStart(at(key), count), delete: (key) => store.delete(at(key)) };
  return {
    presignGet: (input) =>
      getSignedUrl(
        sdk(),
        new GetObjectCommand({
          Bucket: bucketName(input.bucket),
          Key: input.key,
          ResponseContentType: input.contentType,
          ...(input.download === undefined ? {} : { ResponseContentDisposition: `attachment; filename="${input.download}"` }),
        }),
        { expiresIn: GET_LINK_SECONDS },
      ),
    async presignPost(input) {
      const post = await createPresignedPost(sdk(), {
        Bucket: bucketName("Media"),
        Key: input.key,
        Conditions: [
          ["content-length-range", 1, input.maxBytes],
          ["eq", "$Content-Type", input.contentType],
        ],
        Fields: { "Content-Type": input.contentType },
        Expires: POST_LINK_SECONDS,
      });
      return { url: post.url, fields: post.fields };
    },
    media,
    async copyFromSeed(input) {
      await sdk().send(
        new CopyObjectCommand({ Bucket: bucketName("Media"), Key: input.key, CopySource: `${bucketName("Seed")}/${input.sourceKey}`, ContentType: input.contentType, MetadataDirective: "REPLACE" }),
      );
    },
    async manualText(version, sectionId) {
      try {
        const output = await sdk().send(new GetObjectCommand({ Bucket: bucketName("Manual"), Key: `manual/${version}/${sectionId}.md` }));
        return output.Body === undefined ? undefined : await output.Body.transformToString("utf-8");
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    async exists(bucket, key) {
      return (await store.head({ bucket: bucketName(bucket), key })) !== undefined;
    },
  };
}

let lambda: LambdaClient | undefined;

/** `lambda:Invoke` of `InboundWhatsApp` with the simulator's envelope; its failure is the simulator's. */
function invokeInbound(log: Logger): (event: unknown) => Promise<unknown> {
  return async (event) => {
    lambda ??= new LambdaClient(awsClientConfig(CLIENT_TIMEOUTS.lambda));
    const output = await lambda.send(
      new InvokeCommand({ FunctionName: readLinked("InboundWhatsApp", LinkedFunction).name, InvocationType: "RequestResponse", Payload: new TextEncoder().encode(JSON.stringify(event)) }),
    );
    if (output.FunctionError !== undefined) {
      log.warn("simulator.inbound.failed", { functionError: output.FunctionError });
      throw new ToolError("UNAVAILABLE", "the simulated channel did not take the message", "INBOUND_FAILED");
    }
    return output.Payload === undefined ? undefined : (JSON.parse(new TextDecoder().decode(output.Payload)) as unknown);
  };
}

/** `SeedOverrides` of the stage, read when a person of the demo or live world is written. */
function stageAddresses(): AddressOptions {
  const overrides = seedOverrides();
  return {
    registeredRealPhones: new Set(Object.values(overrides.personPhones ?? {})),
    demoRecipients: overrides.demoRecipients?.emails ?? [],
  };
}

/**
 * The world factory of the stage (worlds/rebuild.ts), built on the first reset or jump. Nothing slow runs in
 * the request: the whole Memory purge and the historical certificates' PDFs go to `WorldJanitor`
 * (asynchronous), and a scene's `case` preset to the installer's queue (`CASE_PRESET`: the worker holds the
 * outbound pipeline the ladder sends through, the BFF never does).
 */
function stageRebuild(log: Logger, dispatcher: TimerDispatcher, queue: InstallerEventSink): WorldRebuild {
  let rebuild: WorldRebuild | undefined;
  const factory = (): WorldRebuild => (rebuild ??= worldRebuild(stageWorldsDeps({ log, dispatcher, queue, certificates: "janitor" })));
  return {
    checkScene: (input) => factory().checkScene(input),
    handOffPurge: (input) => factory().handOffPurge(input),
    reload: (input) => factory().reload(input),
  };
}

function stageConsolePorts(): ConsolePorts {
  const data = connector();
  const log = createLogger({ bindings: { service: "bff-console" } });
  const realClock: Clock = systemClock;
  const sink = stageQueueSink(data);
  const dispatcher = queueTimerDispatcher(sink);
  let transport: SimulatedTransport | undefined;
  // The simulator only marks threads read: a `read` status never falls back to a template, and the BFF
  // holds no outbound pipeline (infra/pipeline-holders.test.ts).
  const fallback: WindowFallbackPort = { sendTemplate: async () => undefined, holdForNextInbound: async () => undefined };
  return {
    services: { connector: data, realClock, logger: log },
    client: tableClient(),
    queue: sink,
    scheduler: eventBridgeScheduler(),
    dispatcher,
    rebuild: stageRebuild(log, dispatcher, sink),
    network: networkClient(),
    dispatch: createDispatchControlClient({ transport: (request, signal) => sigv4Transport({ baseUrl: readLinked("DispatchMock", LinkedFunctionUrl).url })(request, signal) }),
    hashPhone: (phone) => phoneHash(subkey("phone-hash"), phone),
    addresses: stageAddresses,
    objects: s3ConsoleObjects(),
    inbound: invokeInbound(log),
    simEnvelopeKey: () => subkey("sim-envelope"),
    simulatedTransport: () => (transport ??= whatsAppTransportFactories({ fallback, logger: log, connector: data, realClock }).simulated()),
    brand: brandConfig,
    costCaps: costCapsDeps({ logger: log }),
    kill: killSwitchReader(),
    stageTransports: () => channelModes().whatsapp.transports,
    evalRuns: tableEvalRuns(tableClient()),
    newId: (nowMs) => ulid(nowMs),
  };
}

const bound = new WeakMap<ContextDeps, ConsolePorts>();
let stage: ConsolePorts | undefined;

/** The ports every router of a request with these dependencies uses (tests, the UI server, the local flows). */
export function bindConsolePorts(deps: ContextDeps, ports: ConsolePorts): ContextDeps {
  bound.set(deps, ports);
  return deps;
}

/** The ports bound to `deps`, else the stage's (built once per container). */
export function consolePortsOf(deps: ContextDeps): ConsolePorts {
  return bound.get(deps) ?? (stage ??= stageConsolePorts());
}
