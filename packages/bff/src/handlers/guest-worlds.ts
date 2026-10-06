/// <reference path="../../sst-env.d.ts" />
// `GuestWorlds` (ADR-0025 §2, infra/guest-worlds.ts): builds a guest's world, asynchronously. The post
// confirmation and post authentication triggers and `guest.retryWorld` invoke it with
// `{userId, clockId, origin}` and nothing else. Idempotent by (userId, generation):
//
//   the account names another generation, or is gone   nothing (a stale request)
//   the world is READY, waits in CAP_FULL, or is PERSON_LIMIT   nothing
//   the world is complete but not marked                READY, without building it again
//   otherwise                                           the minimal factory builds it → READY
//
// A failure never throws back to the asynchronous invocation: the account becomes FAILED with its reason
// (a collision of the generation id asks the next retry for a new generation) and the portada offers
// "Reintentar". The world is READY within 60 s of the request.
import { ConnectorError, type GuestOrigin, ToolError, ispIdOfClock } from "@cuadrilla/shared";
import { connector, tableClient } from "../connector/index";
import type { TableClient } from "../connector/table-client";
import { type GuestAccount, type WorldFailure, getGuestAccount, setStatus } from "../guest/account";
import { ProvisionRequest } from "../guest/provisioner";
import { phoneHash } from "../lib/crypto";
import { type Logger, createLogger } from "../lib/log";
import { brandConfig, subkey } from "../lib/secrets";
import { type FactoryDeps, buildWorld, worldExists } from "../worlds/factory";
import { GenerationCollisionError } from "../worlds/guest-lifecycle";
import { s3TemplateSource } from "../worlds/sources";
import { TemplateError, readTemplate } from "../worlds/template";

export type GuestWorldsOutcome = "READY" | "ALREADY_READY" | "STALE" | "NO_SLOT" | "FAILED";

export interface GuestWorldsDeps {
  readonly client: TableClient;
  readonly factory: FactoryDeps;
  /** Real clock. */
  readonly now: () => Date;
  readonly log: Logger;
}

function failureOf(error: unknown): WorldFailure {
  if (error instanceof GenerationCollisionError) return "GENERATION_COLLISION";
  if (error instanceof TemplateError) return "TEMPLATE_INVALID";
  return "BUILD_FAILED";
}

/** What the log keeps of a failure: the error's name and, for the store, its code, table and cause; never a row. */
export function failureDetail(error: unknown): Record<string, string> {
  if (!(error instanceof Error)) return { error: "unknown" };
  const detail: Record<string, string> = { error: error.name };
  if (error instanceof ConnectorError) {
    detail.code = error.code;
    if (error.table !== undefined) detail.table = error.table;
  }
  if (error.cause instanceof Error) detail.cause = error.cause.name;
  return detail;
}

function skip(account: GuestAccount | undefined, clockId: string, origin: GuestOrigin): GuestWorldsOutcome | undefined {
  if (account === undefined || account.clockId !== clockId || account.guestOrigin !== origin) return "STALE";
  if (account.status === "READY") return "ALREADY_READY";
  if (account.status === "CAP_FULL" || account.status === "PERSON_LIMIT") return "NO_SLOT";
  return undefined;
}

export async function handleGuestWorlds(deps: GuestWorldsDeps, event: unknown): Promise<{ readonly outcome: GuestWorldsOutcome }> {
  const parsed = ProvisionRequest.safeParse(event);
  if (!parsed.success) throw new ToolError("INVALID", "GuestWorlds takes {userId, clockId, origin} and nothing else");
  const { userId, clockId, origin } = parsed.data;
  const started = deps.now();
  const account = await getGuestAccount(deps.client, userId);
  const skipped = skip(account, clockId, origin);
  if (skipped !== undefined) {
    deps.log.info("guest.world.skipped", { userId, outcome: skipped });
    return { outcome: skipped };
  }
  const ispId = ispIdOfClock(clockId);
  const done = { to: "READY" as const, clockId, from: ["PROVISIONING", "FAILED"] as const };
  try {
    if (await worldExists(deps.factory, ispId)) {
      await setStatus(deps.client, userId, done, deps.now());
      return { outcome: "READY" };
    }
    const built = await buildWorld(deps.factory, { ispId, origin, ownerUserId: origin === "SIGNUP" ? userId : undefined });
    await setStatus(deps.client, userId, done, deps.now());
    deps.log.info("guest.world.ready", { userId, ispId, origin, worldEpoch: built.worldEpoch, metric: "GuestWorldReadyMs", value: deps.now().getTime() - started.getTime() });
    return { outcome: "READY" };
  } catch (error) {
    const failure = failureOf(error);
    await setStatus(deps.client, userId, { to: "FAILED", clockId, from: ["PROVISIONING"], failure }, deps.now());
    deps.log.error("guest.world.failed", { userId, ispId, origin, failure, metric: "GuestWorldFailed", value: 1, ...failureDetail(error) });
    return { outcome: "FAILED" };
  }
}

let factory: FactoryDeps | undefined;

function defaultDeps(): GuestWorldsDeps {
  const source = s3TemplateSource();
  factory ??= {
    connector: connector(),
    client: tableClient(),
    template: () => readTemplate(source),
    brand: brandConfig,
    phoneHash: (phone) => phoneHash(subkey("phone-hash"), phone),
    now: () => new Date(),
  };
  return { client: tableClient(), factory, now: () => new Date(), log: createLogger({ bindings: { service: "guest-worlds" } }) };
}

export async function handler(event: unknown): Promise<{ readonly outcome: GuestWorldsOutcome }> {
  return handleGuestWorlds(defaultDeps(), event);
}
