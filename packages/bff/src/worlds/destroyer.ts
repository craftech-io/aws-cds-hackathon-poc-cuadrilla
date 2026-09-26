/// <reference path="../../sst-env.d.ts" />
// The destruction of a sign-up guest's current generation as `GuestAccountDeletion` runs it
// (leads/deletion.ts `GenerationDestroyer`, ADR-0025 §6): the demo's tables through the process-wide
// connector, the guest template of the `Seed` bucket (the partitions of the world, `WorldTemplates`
// link), the phone hashes of its people (`SessionTokenKey`) and the `guest/` objects of `Media` and
// `Evidence`. Built once per container.
import { connector, tableClient } from "../connector/index";
import { phoneHash } from "../lib/crypto";
import { subkey } from "../lib/secrets";
import { signupGenerationDestroyer } from "./guest-lifecycle";
import { s3ObjectStore, s3TemplateSource } from "./sources";
import { readTemplate } from "./template";

let destroyer: ReturnType<typeof signupGenerationDestroyer> | undefined;

export function defaultSignupGenerationDestroyer(): ReturnType<typeof signupGenerationDestroyer> {
  const source = s3TemplateSource();
  destroyer ??= signupGenerationDestroyer({
    client: tableClient(),
    connector: connector(),
    template: () => readTemplate(source),
    phoneHash: (phone) => phoneHash(subkey("phone-hash"), phone),
    objects: s3ObjectStore(),
    now: () => new Date(),
  });
  return destroyer;
}
