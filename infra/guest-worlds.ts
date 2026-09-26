// `GuestWorlds`, the asynchronous provisioning of a guest's world (ADR-0025 §2, docs/architecture.md §8
// and §14): the post confirmation and post authentication triggers (infra/auth.ts), the BFF
// (`guest.retryWorld`) and the QaDriver invoke it with `InvocationType: Event`; it builds the world with
// the minimal world factory (packages/bff/src/worlds/, WP-58) from `Seed/worlds/guest.json`, idempotent
// by (userId, generation), and writes the state `PROVISIONING` → `READY` | `FAILED` | `CAP_FULL`.
//
// Permissions: WORLDS of infra/iam-capabilities.ts (the world factory), with the mocks' tables fenced to
// guest worlds by `dynamodb:LeadingKeys` (`ONU#GUEST#isp-guest-*`, `DWO#isp-guest-*`); never `Leads`.
// Links: the storage of WORLDS by name, the mocks' tables, the stage's Memory (late), the templates
// uploaded by infra/world-templates.ts (key and sha256), the brand (the operator's display name comes
// from `resolveBrand`), the session key (phone hashes of the world's people) and the cost caps
// (the `SIGNUP` profile of the world's settings).
//
// Verify: aws --profile craftech-demos lambda get-function-configuration --function-name <GuestWorlds>

import { CostCaps } from "./cost-caps";
import { links } from "./late-links";
import { GUEST_WORLDS_BUDGET, SIGNUP_HANDLERS } from "./leads-spec";
import { signupPermissions, worldsAccess } from "./leads";
import { BrandConfig, SessionTokenKey } from "./secrets";
import { storageLinks } from "./storage";
import { WorldTemplates } from "./world-templates";

const access = worldsAccess("GuestWorlds");

export const guestWorlds = new sst.aws.Function("GuestWorlds", {
  description: "Provisions a guest's world (asynchronous, idempotent by user and generation).",
  handler: SIGNUP_HANDLERS.GuestWorlds,
  link: links([...storageLinks("GuestWorlds"), WorldTemplates, BrandConfig, SessionTokenKey, CostCaps], access.links),
  permissions: [...access.permissions, ...signupPermissions("GuestWorlds", {}, access.carried)],
  timeout: `${GUEST_WORLDS_BUDGET.timeoutSeconds} seconds`,
  memory: `${GUEST_WORLDS_BUDGET.memoryMb} MB`,
});
