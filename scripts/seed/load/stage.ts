/// <reference path="../../../packages/bff/sst-env.d.ts" />
// The stage side of `seed:load`: everything from the resources `sst shell` links (`Resource`, never
// `process.env`) and the operator's or CI's credentials:
//
//   Seed / Manual / Evidence   the buckets by their linked names
//   Knowledge Base             `Resource.KnowledgeBase.{id, dataSourceId}` (bedrock-agent)
//   worlds                     the world factory over the stage's tables, subkeys, Scheduler and Memory,
//                              every Memory purge pass in this process; templates and photos from disk
//                              (the same bytes the IaC and step 2 upload); historical certificates
//                              written to `Evidence` with the photos of the committed seed
//   listWorlds                 every operator of `Isps` (`META`), by Scan: the operator's credentials
//   overrides                  `scripts/seed/overrides.local.json` when it exists, else `SeedOverrides`
import { existsSync, readFileSync } from "node:fs";
import { BedrockAgentClient, GetIngestionJobCommand, StartIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { clockIdOfIsp } from "@cuadrilla/shared";
import { s3CertificateObjects } from "../../../packages/bff/src/certificates/store";
import { connector, tableClient } from "../../../packages/bff/src/connector/index";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../../../packages/bff/src/lib/clients";
import { phoneHash } from "../../../packages/bff/src/lib/crypto";
import { createLogger } from "../../../packages/bff/src/lib/log";
import { bucketName, readLinked, tableName } from "../../../packages/bff/src/lib/resource";
import { SeedOverridesValue } from "../../../packages/bff/src/lib/secret-schemas";
import { brandConfig, seedOverrides, subkey } from "../../../packages/bff/src/lib/secrets";
import { eventBridgeScheduler } from "../../../packages/bff/src/timers/scheduler-client";
import { historicalCertificates, type WorldRef } from "../../../packages/bff/src/worlds/certificates";
import type { WorldsDeps } from "../../../packages/bff/src/worlds/deps";
import { agentCoreMemoryAdmin } from "../../../packages/bff/src/worlds/memory-admin";
import { purgeRemainingPasses } from "../../../packages/bff/src/worlds/memory-purge";
import { PhotoIndex } from "../../../packages/bff/src/worlds/photo-catalog";
import { staticTemplateSource } from "../../../packages/bff/src/worlds/templates";
import { fromRoot } from "../lib/paths";
import type { SeedOnDisk } from "./disk";
import { type IngestionApi, type JobStatus, pollingIngestion } from "./kb";
import type { LoadPorts, ObjectSink } from "./run";

const REGION = "us-east-1";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function s3Sink(client: S3Client, bucket: () => string): ObjectSink {
  return {
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }));
    },
    async getText(key) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
        return await object.Body?.transformToString("utf-8");
      } catch (error) {
        if (error instanceof NoSuchKey) return undefined;
        throw error;
      }
    },
  };
}

const KnowledgeBaseLink = z.object({ id: z.string().min(1), dataSourceId: z.string().min(1) });

function bedrockIngestion(): IngestionApi {
  const client = new BedrockAgentClient({ region: REGION, ...awsClientConfig(CLIENT_TIMEOUTS.knowledgeBase) });
  const link = () => readLinked("KnowledgeBase", KnowledgeBaseLink);
  return {
    async start() {
      const { id, dataSourceId } = link();
      const { ingestionJob } = await client.send(new StartIngestionJobCommand({ knowledgeBaseId: id, dataSourceId, description: "seed:load" }));
      if (ingestionJob?.ingestionJobId === undefined) throw new Error("StartIngestionJob answered no job");
      return { jobId: ingestionJob.ingestionJobId, status: (ingestionJob.status ?? "STARTING") as JobStatus };
    },
    async status(jobId) {
      const { id, dataSourceId } = link();
      const { ingestionJob } = await client.send(new GetIngestionJobCommand({ knowledgeBaseId: id, dataSourceId, ingestionJobId: jobId }));
      return { status: (ingestionJob?.status ?? "IN_PROGRESS") as JobStatus, ...(ingestionJob?.failureReasons === undefined ? {} : { failureReasons: ingestionJob.failureReasons }) };
    },
  };
}

/** Every operator of the stage, by Scan of `Isps` (`SK = META`): the operator's or CI's credentials. */
async function scanWorlds(): Promise<WorldRef[]> {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, ...awsClientConfig(CLIENT_TIMEOUTS.dynamodb) }));
  const worlds: WorldRef[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new ScanCommand({ TableName: tableName("Isps"), FilterExpression: "SK = :meta AND entity = :isp", ExpressionAttributeValues: { ":meta": "META", ":isp": "Isp" }, ProjectionExpression: "ispId", ExclusiveStartKey: start }));
    for (const item of page.Items ?? []) if (typeof item.ispId === "string") worlds.push({ ispId: item.ispId, clockId: clockIdOfIsp(item.ispId) });
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return worlds.sort((a, b) => (a.clockId < b.clockId ? -1 : 1));
}

/** The local overrides file wins over the stage's secret (docs/seed-spec.md §1); PII, never printed. */
export function loadOverrides(): SeedOverridesValue {
  const local = fromRoot("scripts/seed/overrides.local.json");
  return existsSync(local) ? SeedOverridesValue.parse(JSON.parse(readFileSync(local, "utf8"))) : seedOverrides();
}

export function stagePorts(seed: SeedOnDisk, report: (line: string) => void): LoadPorts {
  const log = createLogger({ bindings: { service: "seed-load" } });
  const s3 = new S3Client({ region: REGION, ...awsClientConfig(CLIENT_TIMEOUTS.s3) });
  const data = connector();
  const memory = agentCoreMemoryAdmin();
  const overrides = loadOverrides();
  const photoFile = (photoId: string): string => fromRoot(`scripts/seed/photos/out/${photoId}.jpg`);
  const worlds: WorldsDeps = {
    connector: data,
    client: tableClient(),
    templates: staticTemplateSource(seed.templates),
    photos: async () => new PhotoIndex(seed.catalog),
    brand: brandConfig,
    overrides: () => overrides,
    phoneHash: (phone) => phoneHash(subkey("phone-hash"), phone),
    runtimeSessionKey: subkey("runtime-session"),
    scheduler: eventBridgeScheduler(),
    // A reload of the demo world is never a scene: nothing is due at its start.
    dispatcher: { dispatch: async (due) => log.warn("seed_load.timer_due_not_dispatched", { timerId: due.timer.timerId }) },
    memory,
    continuePurge: async (target) => {
      await purgeRemainingPasses({ memory, data, log, now: () => new Date(), sleep }, target);
    },
    certificates: historicalCertificates({
      connector: data,
      objects: s3CertificateObjects(s3, () => bucketName("Evidence")),
      photo: async (photoId) => (existsSync(photoFile(photoId)) ? new Uint8Array(readFileSync(photoFile(photoId))) : undefined),
      brand: brandConfig,
      logger: log,
    }),
    log,
    now: () => new Date(),
  };
  return {
    seed: s3Sink(s3, () => bucketName("Seed")),
    manual: s3Sink(s3, () => bucketName("Manual")),
    ingestion: pollingIngestion(bedrockIngestion(), { sleep, now: () => Date.now() }),
    worlds,
    listWorlds: scanWorlds,
    readFile: (path) => new Uint8Array(readFileSync(path)),
    report,
  };
}
