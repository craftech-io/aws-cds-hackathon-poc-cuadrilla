// The run of `seed:load` (docs/seed-spec.md §15) over ports, so the test drives it in memory. In order:
//
//   0  the logos of `--brand-logo-on-light`/`--brand-logo-on-dark`, when given, are checked first
//      (load/svg.ts) against `BrandConfig.logoAssetKeys`; nothing is written for a logo that fails
//   1  the fingerprint (the manifest's bytes and the overrides in force): the same as the last load and
//      no `--force` skips steps 2-5
//   2  `Seed`: the photos (the set and the renders outside it), their catalog, the voice notes, the
//      evaluation set and the sample of the certificate template's document header; `Manual`: every
//      section and its sidecar. The world templates are the IaC's (infra/world-templates.ts), never here
//   3  `Reference` (validated by the seed store): a WhatsApp template keeps the id and status Meta gave it (P-01 step 8)
//   4  the Knowledge Base is ingested again only when the manual's fingerprint changed (also with
//      `--force`), waiting for COMPLETE; then `MANUALINDEX` is written
//   5  the demo world: created at epoch 1, or reset ("Reiniciar demo" as `seed:load`: epoch up, tombstone,
//      Memory purged in every pass in this process, the world written again); the live world of the
//      overrides goes live (the singleton `LIVEWORLD`)
//   6  a changed `BrandConfig` rewrites the name of every existing world and renders its certificates again
//   7  the historical certificates still `pdfPending` in any world (guest worlds included) are rendered
//   8  the logos go to `Seed/brand/`; without the flags `Seed/brand/` is never touched
//   9  `AuditLog ACTION SEED_LOADED` and `Seed/loaded.json` with the fingerprints, last
import { DEMO_CLOCK_ID, DEMO_ISP_ID } from "@cuadrilla/shared";
import type { Item } from "../../../packages/bff/src/connector/table-client";
import type { WorldRef } from "../../../packages/bff/src/worlds/certificates";
import { brandFingerprint, rewriteBrand, stableJson } from "../../../packages/bff/src/worlds/brand";
import { type WorldsDeps, liveWorldOf, readOverrides } from "../../../packages/bff/src/worlds/deps";
import { createDemoWorld } from "../../../packages/bff/src/worlds/demo";
import { syncLiveWorld } from "../../../packages/bff/src/worlds/live-world";
import { resetWorld } from "../../../packages/bff/src/worlds/rebuild";
import { sha256Hex } from "../photos/prng";
import type { LoadArgs } from "./args";
import type { SeedOnDisk } from "./disk";
import { LogoRejected, validateLogoSvg } from "./svg";

/** Where the loader records what it loaded (`Seed/loaded.json`). */
export const LOADED_KEY = "loaded.json";
/** Keys of the partner's logos in the `Seed` bucket (generic: never the partner's name). */
export const LOGO_KEYS = { onLight: "brand/logo-on-light.svg", onDark: "brand/logo-on-dark.svg" } as const;

export interface ObjectSink {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** The object's text, or `undefined` when it does not exist. */
  getText(key: string): Promise<string | undefined>;
}

export interface Ingestion {
  /** Starts an ingestion job of the manual's data source and waits for COMPLETE; throws on FAILED or timeout. */
  ingest(): Promise<{ readonly jobId: string; readonly status: "COMPLETE" }>;
}

export interface LoadPorts {
  readonly seed: ObjectSink;
  readonly manual: Pick<ObjectSink, "put">;
  readonly ingestion: Ingestion;
  /** The world factory with every Memory purge pass in this process. */
  readonly worlds: WorldsDeps;
  /** Every world of the stage (`Isps` · `META`): the brand and the certificates reach all of them. */
  readonly listWorlds: () => Promise<WorldRef[]>;
  readonly readFile: (path: string) => Uint8Array;
  readonly report: (line: string) => void;
}

interface Loaded {
  readonly fingerprint?: string;
  readonly manualFingerprint?: string;
  readonly brandFingerprint?: string;
}

export interface LoadResult {
  readonly skipped: boolean;
  readonly fingerprint: string;
  readonly ingested: boolean;
  readonly demo?: { readonly worldEpoch: number; readonly action: "CREATED" | "RESET" };
  readonly renamedWorlds: number;
  readonly certificates: number;
  readonly logos: readonly string[];
}

export function fingerprintOf(seed: Pick<SeedOnDisk, "manifest">, overrides: unknown): string {
  return sha256Hex(`${sha256Hex(seed.manifest)}\u0000${stableJson(overrides)}`);
}

/** The logos of the flags, checked against `BrandConfig` before anything is written. */
function checkedLogos(args: LoadArgs, ports: LoadPorts): Array<{ readonly key: string; readonly body: Uint8Array }> {
  const asked = [
    ...(args.logoOnLight === undefined ? [] : [{ flag: "--brand-logo-on-light", path: args.logoOnLight, key: LOGO_KEYS.onLight, configured: "onLight" as const }]),
    ...(args.logoOnDark === undefined ? [] : [{ flag: "--brand-logo-on-dark", path: args.logoOnDark, key: LOGO_KEYS.onDark, configured: "onDark" as const }]),
  ];
  if (asked.length === 0) return [];
  const brand = ports.worlds.brand();
  if (brand.mode !== "cobrand") throw new LogoRejected("BrandConfig is neutral: there are no logos to upload");
  return asked.map(({ flag, path, key, configured }) => {
    if (brand.logoAssetKeys[configured] !== key) throw new LogoRejected(`${flag}: BrandConfig.logoAssetKeys.${configured} is not ${key}`);
    const body = ports.readFile(path);
    try {
      validateLogoSvg(body);
    } catch (error) {
      throw new LogoRejected(`${flag}: ${error instanceof Error ? error.message : "rejected"}`);
    }
    return { key, body };
  });
}

/** A template row keeps what its registration with Meta gave it in the stage (P-01 step 8): Meta's id, its review status and category. */
async function referenceRows(seed: SeedOnDisk, worlds: WorldsDeps): Promise<Item[]> {
  const rows: Item[] = [];
  for (const row of seed.reference) {
    if (row.entity !== "Template") {
      rows.push(row);
      continue;
    }
    const stored = await worlds.client.get("Reference", { PK: row.PK, SK: row.SK });
    const kept = stored === undefined || stored.status === "LOCAL_ONLY" ? {} : { status: stored.status, ...(stored.metaTemplateId === undefined ? {} : { metaTemplateId: stored.metaTemplateId }), ...(stored.metaCategory === undefined ? {} : { metaCategory: stored.metaCategory }) };
    rows.push({ ...row, ...kept });
  }
  return rows;
}

async function loadData(seed: SeedOnDisk, ports: LoadPorts, loaded: Loaded): Promise<Pick<LoadResult, "ingested" | "demo">> {
  const { worlds } = ports;
  for (const object of seed.seedObjects) await ports.seed.put(object.key, object.body, object.contentType);
  for (const object of seed.manual) await ports.manual.put(object.key, object.body, object.contentType);
  ports.report(`Seed: ${seed.seedObjects.length} objects; Manual: ${seed.manual.length} files`);

  const reference = await referenceRows(seed, worlds);
  await worlds.connector.seed.loadItems("Reference", reference.filter((row) => row.entity !== "ManualIndex"));
  const ingest = loaded.manualFingerprint !== seed.manualFingerprint;
  if (ingest) {
    const job = await ports.ingestion.ingest();
    ports.report(`Knowledge Base ingested (job ${job.jobId})`);
  }
  await worlds.connector.seed.loadItems("Reference", reference.filter((row) => row.entity === "ManualIndex"));

  let demo: LoadResult["demo"];
  if ((await worlds.connector.runtime.getClock(DEMO_CLOCK_ID)) === undefined) {
    demo = { worldEpoch: (await createDemoWorld(worlds)).worldEpoch, action: "CREATED" };
  } else {
    demo = { worldEpoch: (await resetWorld(worlds, { clockId: DEMO_CLOCK_ID, caller: "SEED", actor: "OPERATOR" })).worldEpoch, action: "RESET" };
  }
  ports.report(`${DEMO_CLOCK_ID}: ${demo.action.toLowerCase()} at epoch ${demo.worldEpoch}`);
  const live = await syncLiveWorld(worlds.connector, liveWorldOf(worlds), "OPERATOR");
  if (live.live !== undefined || live.cleared !== undefined) ports.report(`live world: ${live.live ?? "none"}`);
  return { ingested: ingest, demo };
}

export async function runLoad(seed: SeedOnDisk, args: LoadArgs, ports: LoadPorts): Promise<LoadResult> {
  const { worlds } = ports;
  const logos = checkedLogos(args, ports);
  const fingerprint = fingerprintOf(seed, readOverrides(worlds));
  const brandPrint = brandFingerprint(worlds.brand());
  const previous = await ports.seed.getText(LOADED_KEY);
  const loaded: Loaded = previous === undefined ? {} : (JSON.parse(previous) as Loaded);
  const skipped = loaded.fingerprint === fingerprint && !args.force;
  const data: Pick<LoadResult, "ingested" | "demo"> = skipped ? { ingested: false } : await loadData(seed, ports, loaded);
  if (skipped) ports.report("same fingerprint as the last load: the data is not loaded again (use --force)");

  const all = await ports.listWorlds();
  const renamed = loaded.brandFingerprint === brandPrint ? [] : (await rewriteBrand(worlds, all)).filter((world) => world.renamed);
  let certificates = renamed.reduce((sum, world) => sum + world.certificates, 0);
  for (const world of all) certificates += (await worlds.certificates?.render(world, "PENDING")) ?? 0;
  if (renamed.length > 0 || certificates > 0) ports.report(`brand: ${renamed.length} world(s) renamed; ${certificates} certificate(s) rendered`);

  for (const logo of logos) await ports.seed.put(logo.key, logo.body, "image/svg+xml");
  if (logos.length > 0) ports.report(`brand logos uploaded: ${logos.map((logo) => logo.key).join(", ")}`);

  if (!skipped) {
    await worlds.connector.audit.append({ ispId: DEMO_ISP_ID, clockId: DEMO_CLOCK_ID, decision: "ACTION", action: "SEED_LOADED", actor: "OPERATOR", detail: { fingerprint, force: args.force, ingested: data.ingested, worldEpoch: data.demo?.worldEpoch ?? 0 } });
  }
  const record = { fingerprint: skipped ? loaded.fingerprint : fingerprint, manualFingerprint: skipped ? loaded.manualFingerprint : seed.manualFingerprint, brandFingerprint: brandPrint, loadedAt: worlds.now().toISOString() };
  await ports.seed.put(LOADED_KEY, new TextEncoder().encode(`${JSON.stringify(record)}\n`), "application/json");
  return { skipped, fingerprint, ...data, renamedWorlds: renamed.length, certificates, logos: logos.map((logo) => logo.key) };
}
