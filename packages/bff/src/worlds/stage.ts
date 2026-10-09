/// <reference path="../../sst-env.d.ts" />
// The world factory in a Lambda of the stage (the `Bff`'s clock procedures, the `QaDriver`'s
// `world.*`, `WorldJanitor`, `GuestWorlds`, `GuestAccountDeletion`): every port from the linked resources
// (`Resource`, never `process.env`), built once per container. What a role does not hold stays out:
// without the installer queue the due timers of a scene are only logged; a role without `Evidence`
// certificate writes leaves the historical certificates `pdfPending` (`seed:load` renders them); without
// the Memory link nothing is purged.
//
//   templates   `Seed/worlds/<name>.json` through the `WorldTemplates` link (digest checked)
//   photos      `Seed/photos/catalog.json` (published by `seed:load`)
//   media       a photo of `Seed/photos/` copied to a key of `Media` (the `candidates` preset)
//   memory      AgentCore Memory (worlds/memory-admin.ts)
//   continue    the passes a purge owes: `MEMORY_PURGE` to `WorldJanitor`, asynchronously
//   certificates the PDFs of the historical certificates in `Evidence/[guest/<seg>/]certificates/`, in the
//               role itself or handed to `WorldJanitor` (`RENDER_CERTIFICATES`, the `Bff`)
//   effects     the `case` preset as `CASE_PRESET` on the installer queue (a role that holds it)
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { z } from "zod";
import { ToolError } from "@cuadrilla/shared";
import { s3CertificateObjects } from "../certificates/store";
import { connector, tableClient } from "../connector/index";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { systemClock } from "../lib/clock";
import { phoneHash } from "../lib/crypto";
import type { Logger } from "../lib/log";
import { readLinked } from "../lib/resource";
import { brandConfig, seedOverrides, subkey } from "../lib/secrets";
import type { TimerDispatcher } from "../timers/dispatch";
import type { InstallerEventSink } from "../worker/ports";
import { eventBridgeScheduler } from "../timers/scheduler-client";
import { type HistoricalCertificates, historicalCertificates } from "./certificates";
import type { WorldsDeps } from "./deps";
import { agentCoreMemoryAdmin } from "./memory-admin";
import type { RenderCertificatesEvent } from "./janitor";
import type { MemoryPurgeEvent, PurgeFromPass, PurgeTarget } from "./memory-purge";
import { PHOTO_CATALOG_KEY, PhotoCatalog, PhotoIndex, seedPhotoKey } from "./photo-catalog";
import { queuedCasePresetEffects } from "./preset-effects";
import type { SeedMediaCopier } from "./presets";
import { s3TemplateSource } from "./sources";

const BucketsLink = z.object({ buckets: z.object({ Seed: z.string().min(1), Media: z.string().min(1), Evidence: z.string().min(1) }) });
const buckets = () => readLinked("WorldTemplates", BucketsLink).buckets;

let s3: S3Client | undefined;
const s3Client = (): S3Client => (s3 ??= new S3Client(awsClientConfig(CLIENT_TIMEOUTS.s3)));

async function seedObject(key: string): Promise<Uint8Array> {
  const output = await s3Client().send(new GetObjectCommand({ Bucket: buckets().Seed, Key: key }));
  const bytes = await output.Body?.transformToByteArray();
  if (bytes === undefined) throw new ToolError("UNAVAILABLE", `Seed/${key} is empty`);
  return bytes;
}

let photoIndex: Promise<PhotoIndex> | undefined;

/** The photo catalog of `Seed/photos/catalog.json`, read once per container. */
export function s3PhotoIndex(): () => Promise<PhotoIndex> {
  return () =>
    (photoIndex ??= seedObject(PHOTO_CATALOG_KEY)
      .then((bytes) => new PhotoIndex(PhotoCatalog.parse(JSON.parse(new TextDecoder().decode(bytes)))))
      .catch((error: unknown) => {
        photoIndex = undefined;
        throw error;
      }));
}

// Copies `Seed/photos/<photoId>.jpg` byte for byte: to a key of `Media` (WORLDS: `Seed/*` read, `Media/sim/*`
// write) or to an evidence key of `Evidence` (the roles that run presets: `[guest/*/]photos/*` write).
export function s3SeedMediaCopier(): SeedMediaCopier {
  const copy = async (photoId: string, bucket: string, key: string): Promise<void> => {
    const body = await seedObject(seedPhotoKey(photoId));
    await s3Client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "image/jpeg" }));
  };
  return {
    copySeedPhoto: (photoId, mediaKey) => copy(photoId, buckets().Media, mediaKey),
    copySeedPhotoToEvidence: (photoId, evidenceKey) => copy(photoId, buckets().Evidence, evidenceKey),
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound");
}

/** The historical certificates' PDFs, with the photos of `Seed/photos/` and the world's brand. */
export function s3HistoricalCertificates(log: Logger): HistoricalCertificates {
  return historicalCertificates({
    connector: connector(),
    objects: s3CertificateObjects(s3Client(), () => buckets().Evidence),
    photo: (photoId) =>
      seedObject(seedPhotoKey(photoId)).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      }),
    brand: brandConfig,
    logger: log,
  });
}

const LinkedFunction = z.object({ name: z.string().min(1) });
let lambda: LambdaClient | undefined;

const janitorName = (): string => readLinked("WorldJanitor", LinkedFunction).name;

/** One asynchronous invocation of the linked `WorldJanitor` (`InvocationType: Event`, 202 or it throws). */
async function invokeJanitor(functionName: () => string, event: MemoryPurgeEvent | RenderCertificatesEvent, what: string): Promise<void> {
  lambda ??= new LambdaClient(awsClientConfig(CLIENT_TIMEOUTS.lambda));
  const output = await lambda.send(new InvokeCommand({ FunctionName: functionName(), InvocationType: "Event", Payload: new TextEncoder().encode(JSON.stringify(event)) }));
  if (output.StatusCode !== 202) throw new ToolError("UNAVAILABLE", `${what} could not be handed to WorldJanitor`);
}

/** `MEMORY_PURGE` to the linked `WorldJanitor`, asynchronously: the passes the purge owes run there. */
export function janitorPurge(functionName: () => string = janitorName): (target: PurgeTarget, fromPass?: PurgeFromPass) => Promise<void> {
  return (target, fromPass = 2) => invokeJanitor(functionName, { kind: "MEMORY_PURGE", ...target, fromPass }, "the Memory purge");
}

/** The historical certificates of a reloaded world, rendered by `WorldJanitor` (`RENDER_CERTIFICATES`), never in the request. */
export function janitorCertificates(functionName: () => string = janitorName): HistoricalCertificates {
  return {
    async render(world) {
      await invokeJanitor(functionName, { kind: "RENDER_CERTIFICATES", clockId: world.clockId }, "the historical certificates");
      return 0;
    },
  };
}

/** A dispatcher for a role without the installer queue: a due timer waits for the next clock move. */
export function loggingDispatcher(log: Logger): TimerDispatcher {
  return { dispatch: async (due) => log.warn("worlds.timer_due_not_dispatched", { timerId: due.timer.timerId, clockId: due.timer.clockId }) };
}

export interface StageWorldsOptions {
  readonly log: Logger;
  /** The installer queue's timer dispatcher (scenes); without it due timers are only logged. */
  readonly dispatcher?: TimerDispatcher;
  /** Where the passes a purge owes go; `MEMORY_PURGE` to `WorldJanitor` by default. */
  readonly continuePurge?: (target: PurgeTarget, fromPass?: PurgeFromPass) => Promise<void>;
  /** The installer queue: case presets go to it as `CASE_PRESET` (the worker holds the pipeline). */
  readonly queue?: InstallerEventSink;
  /** Whether the role links the Memory (`WORLDS` roles do). */
  readonly memory?: boolean;
  /**
   * The certificates' PDFs of the worlds it rebuilds: rendered here (`true`, `Evidence` certificate writes),
   * handed to `WorldJanitor` (`"janitor"`, the `Bff`), or left `pdfPending`.
   */
  readonly certificates?: boolean | "janitor";
}

/** The world factory's ports of a Lambda. */
export function stageWorldsDeps(options: StageWorldsOptions): WorldsDeps {
  const data = connector();
  return {
    connector: data,
    client: tableClient(),
    templates: s3TemplateSource(),
    photos: s3PhotoIndex(),
    brand: brandConfig,
    overrides: seedOverrides,
    phoneHash: (phone) => phoneHash(subkey("phone-hash"), phone),
    runtimeSessionKey: subkey("runtime-session"),
    scheduler: eventBridgeScheduler(),
    dispatcher: options.dispatcher ?? loggingDispatcher(options.log),
    ...(options.memory === false ? {} : { memory: agentCoreMemoryAdmin() }),
    continuePurge: options.continuePurge ?? janitorPurge(),
    nonces: { runtime: data.runtime, nonceKey: subkey("nonce"), realClock: systemClock },
    ...(options.queue === undefined ? {} : { effects: queuedCasePresetEffects(options.queue) }),
    ...(options.certificates === true ? { certificates: s3HistoricalCertificates(options.log) } : {}),
    ...(options.certificates === "janitor" ? { certificates: janitorCertificates() } : {}),
    media: s3SeedMediaCopier(),
    log: options.log,
    now: () => new Date(),
  };
}
