// What the world factory of wave 4 needs (docs/build-plan.md WP-39), as ports: the Lambdas wire the real
// ones (worlds/stage.ts), `seed:load` its own over the operator's credentials, the tests memory fakes.
// From one `WorldsDeps` this module derives what each part takes: the minimal factory of wave 2b
// (`FactoryDeps`, guest worlds), the presets and the clock's reset (`ResetDeps` of clock/reset.ts), so
// the console, the `QaDriver`, `WorldJanitor` and `seed:load` build and reset a world the same way.
import type { ResetDeps } from "../clock/reset";
import type { NonceDeps } from "../channels/whatsapp/nonces";
import type { Connector } from "../connector/ports";
import type { TableClient } from "../connector/table-client";
import type { WorldPolicy } from "../connector/world";
import type { SecretKey } from "../lib/crypto";
import type { Logger } from "../lib/log";
import type { BrandConfigValue, SeedOverridesValue } from "../lib/secret-schemas";
import type { TimerDispatcher } from "../timers/dispatch";
import type { SchedulerPort } from "../timers/scheduler-client";
import type { HistoricalCertificates } from "./certificates";
import type { FactoryDeps } from "./factory";
import type { MemoryAdmin, PurgeFromPass, PurgeTarget } from "./memory-purge";
import type { PhotoIndex } from "./photo-catalog";
import type { PresetDeps, PresetEffects, SeedMediaCopier } from "./presets";
import { GUEST_TEMPLATE, type TemplateSource, readTemplate } from "./template";

export interface WorldsDeps {
  readonly connector: Connector;
  /** Every table of the app, the mocks' included. */
  readonly client: TableClient;
  /** `Seed/worlds/<name>.json` with the digest the IaC uploaded it with (or the committed files). */
  readonly templates: TemplateSource;
  /** `Seed/photos/catalog.json`: the photos the presets name by id. */
  readonly photos: () => Promise<PhotoIndex>;
  readonly brand: () => BrandConfigValue;
  /** `SeedOverrides`: the live world, the operator's demo phones and mailboxes (PII: never logged). */
  readonly overrides: () => SeedOverridesValue;
  /** HMAC of an E.164 number with the `phone-hash` subkey. */
  readonly phoneHash: (phone: string) => string;
  /** The `runtime-session` subkey: the Harness sessions of a past epoch the Memory purge computes. */
  readonly runtimeSessionKey?: SecretKey;
  readonly scheduler: SchedulerPort;
  /** Sends a timer to its installer's queue (the due timers of a scene, as "Avanzar" does). */
  readonly dispatcher: TimerDispatcher;
  /** AgentCore Memory; without it nothing is purged (a stage with no Memory, or a test). */
  readonly memory?: MemoryAdmin;
  /**
   * The passes a purge still owes (`fromPass` 1: every one, 2 by default: those after the first): in process
   * (`seed:load`, `WorldJanitor`) or `MEMORY_PURGE` to `WorldJanitor`.
   */
  readonly continuePurge: (target: PurgeTarget, fromPass?: PurgeFromPass) => Promise<void>;
  /** The PDFs of the historical certificates (needs `Evidence` writes); absent: they stay `pdfPending`. */
  readonly certificates?: HistoricalCertificates;
  readonly nonces?: NonceDeps;
  readonly effects?: PresetEffects;
  readonly media?: SeedMediaCopier;
  readonly policy?: WorldPolicy;
  readonly log: Logger;
  /** Real clock. */
  readonly now: () => Date;
}

/** The minimal factory of wave 2b over the same ports (guest worlds). */
export function factoryDepsOf(deps: WorldsDeps): FactoryDeps {
  return {
    connector: deps.connector,
    client: deps.client,
    template: () => readTemplate(deps.templates, GUEST_TEMPLATE),
    brand: deps.brand,
    phoneHash: deps.phoneHash,
    ...(deps.policy === undefined ? {} : { policy: deps.policy }),
    now: deps.now,
  };
}

export function presetDepsOf(deps: WorldsDeps, photos: PhotoIndex): PresetDeps {
  return {
    connector: deps.connector,
    client: deps.client,
    photos,
    now: deps.now,
    ...(deps.nonces === undefined ? {} : { nonces: deps.nonces }),
    ...(deps.effects === undefined ? {} : { effects: deps.effects }),
    ...(deps.media === undefined ? {} : { media: deps.media }),
  };
}

/** The overrides, or none when they cannot be read: no live world, no real phone (the safe side). */
export function readOverrides(deps: Pick<WorldsDeps, "overrides" | "log">): SeedOverridesValue {
  try {
    return deps.overrides();
  } catch (error) {
    deps.log.warn("worlds.overrides_unavailable", { error: error instanceof Error ? error.name : "unknown" });
    return {};
  }
}

/** The live world of the overrides, when there is one (at most one: `channels:check-modes`). */
export function liveWorldOf(deps: Pick<WorldsDeps, "overrides" | "log">): string | undefined {
  return readOverrides(deps).liveWorldClockId ?? undefined;
}

/** The clock's reset over the factory's ports; `rebuild` is worlds/rebuild.ts's (passed in to keep imports acyclic). */
export function resetDepsOf(deps: WorldsDeps, rebuild: ResetDeps["rebuild"]): ResetDeps {
  return { data: deps.connector, client: deps.client, scheduler: deps.scheduler, dispatcher: deps.dispatcher, realClock: { now: async () => deps.now() }, log: deps.log, rebuild };
}
