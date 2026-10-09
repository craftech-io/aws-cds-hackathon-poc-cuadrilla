/// <reference path="../../sst-env.d.ts" />
// The destruction of a sign-up guest's current generation as `GuestAccountDeletion` runs it
// (leads/deletion.ts `GenerationDestroyer`, ADR-0025 §6): the demo's tables through the process-wide
// connector, the guest template of the `Seed` bucket (the partitions of the world, `WorldTemplates`
// link), the phone hashes of its people (`SessionTokenKey`), the `guest/` objects of `Media` and
// `Evidence`, and the Memory of its installers: the first pass of every epoch here, before the items go
// (so the actors and sessions are still known); whatever the strategies extract later belongs to a
// generation that no longer exists, and `WorldJanitor` purges it at night. Built once per container.
import { connector, tableClient } from "../connector/index";
import { phoneHash } from "../lib/crypto";
import { createLogger } from "../lib/log";
import { subkey } from "../lib/secrets";
import { signupGenerationDestroyer } from "./guest-lifecycle";
import { agentCoreMemoryAdmin } from "./memory-admin";
import { purgeFirstPass } from "./memory-purge";
import { purgeTargetOf, scopeOfWorld } from "./memory-targets";
import { s3ObjectStore, s3TemplateSource } from "./sources";
import { GUEST_WORLD_START_SIM, readTemplate } from "./template";

/** The simulated start day of every guest world (its orders and day sessions are around it). */
const START_DATE = GUEST_WORLD_START_SIM.slice(0, 10);

let destroyer: ReturnType<typeof signupGenerationDestroyer> | undefined;

/** First pass of the Memory purge of every epoch of a generation, from its installers and orders. */
async function purgeGenerationMemory(clockId: string, epochs: readonly number[]): Promise<void> {
  const data = connector();
  const memory = agentCoreMemoryAdmin();
  const ispId = clockId.slice("GUEST#".length);
  const runtimeSessionKey = subkey("runtime-session");
  const log = createLogger({ bindings: { component: "guest-account-deletion" } });
  for (const epoch of epochs) {
    if (epoch < 1) continue;
    const scope = await scopeOfWorld(data, { clockId, ispId, epoch, startDate: START_DATE });
    const { deleted } = await purgeFirstPass({ memory, now: () => new Date() }, purgeTargetOf(scope, runtimeSessionKey));
    log.info("worlds.generation_memory_purged", { epoch, deleted });
  }
}

export function defaultSignupGenerationDestroyer(): ReturnType<typeof signupGenerationDestroyer> {
  const source = s3TemplateSource();
  destroyer ??= signupGenerationDestroyer({
    client: tableClient(),
    connector: connector(),
    template: () => readTemplate(source),
    phoneHash: (phone) => phoneHash(subkey("phone-hash"), phone),
    objects: s3ObjectStore(),
    purgeMemory: purgeGenerationMemory,
    now: () => new Date(),
  });
  return destroyer;
}
