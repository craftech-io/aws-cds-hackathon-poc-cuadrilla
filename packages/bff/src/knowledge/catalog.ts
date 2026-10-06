// What `search_procedures` reads from `Reference` besides the Knowledge Base (docs/architecture.md §9.5,
// docs/seed-spec.md §12): the manual version in force (the newest `MANUALINDEX#v<nnn>` that has sections),
// its index of sections (id, title, category) and the score threshold in force (the newest
// `KBTHRESHOLD#v<nnn>`). A new manual or a recalibrated threshold is a new version in `Reference`
// (`seed:load`, the first `EV-01` run), read here without a deploy. Kept for a minute per container.
import { type ManualCategory, ToolError } from "@cuadrilla/shared";
import type { ReferencePort } from "../connector/ports";
import type { ManualIndex } from "../domain/reference";
import type { Clock } from "../lib/clock";

/** Threshold until `KBTHRESHOLD#v001` is read (docs/seed-spec.md §12: 0,35, provisional). */
export const DEFAULT_KB_THRESHOLD = 0.35;
export const CATALOG_TTL_MS = 60_000;
/** Versions probed upwards from `v001`; far more than a demo ever writes. */
export const MAX_VERSIONS = 99;

export interface ManualSection {
  readonly sectionId: string;
  readonly title: string;
  readonly category: ManualCategory;
}

export interface KnowledgeCatalogSnapshot {
  readonly manualVersion: string;
  readonly sections: ReadonlyMap<string, ManualSection>;
  readonly threshold: number;
  readonly thresholdVersion?: string;
  readonly provisional: boolean;
}

export interface KnowledgeCatalog {
  /** The manual and threshold in force; `UNAVAILABLE` when no manual has been loaded. */
  current(): Promise<KnowledgeCatalogSnapshot>;
}

export const versionTag = (n: number): string => `v${n.toString().padStart(3, "0")}`;

/** "v001" → "v1": how a citation names the manual (`(Manual v1, §COM-04)`). */
export function manualLabel(manualVersion: string): string {
  return `v${Number(manualVersion.slice(1))}`;
}

/** The newest version `exists` accepts, probing `v001`, `v002`… until the first gap. */
export async function newestVersion(exists: (version: string) => Promise<boolean>): Promise<string | undefined> {
  let newest: string | undefined;
  for (let n = 1; n <= MAX_VERSIONS; n += 1) {
    const version = versionTag(n);
    if (!(await exists(version))) break;
    newest = version;
  }
  return newest;
}

export function createKnowledgeCatalog(reference: Pick<ReferencePort, "listManualIndex" | "getKbThreshold">, realClock: Clock, ttlMs: number = CATALOG_TTL_MS): KnowledgeCatalog {
  let cached: { readonly snapshot: KnowledgeCatalogSnapshot; readonly untilMs: number } | undefined;

  async function load(): Promise<KnowledgeCatalogSnapshot> {
    const indexes = new Map<string, ManualIndex[]>();
    const manualVersion = await newestVersion(async (version) => {
      const rows = await reference.listManualIndex(version);
      indexes.set(version, rows);
      return rows.length > 0;
    });
    if (manualVersion === undefined) throw new ToolError("UNAVAILABLE", "the manual has not been loaded", "MANUAL_NOT_LOADED");
    const sections = new Map((indexes.get(manualVersion) ?? []).map((row) => [row.sectionId, { sectionId: row.sectionId, title: row.title, category: row.category }] as const));
    const thresholds = new Map<string, { value: number; provisional: boolean }>();
    const thresholdVersion = await newestVersion(async (version) => {
      const row = await reference.getKbThreshold(version);
      if (row !== undefined) thresholds.set(version, { value: row.value, provisional: row.provisional });
      return row !== undefined;
    });
    const threshold = thresholdVersion === undefined ? undefined : thresholds.get(thresholdVersion);
    return {
      manualVersion,
      sections,
      threshold: threshold?.value ?? DEFAULT_KB_THRESHOLD,
      provisional: threshold?.provisional ?? true,
      ...(thresholdVersion === undefined ? {} : { thresholdVersion }),
    };
  }

  return {
    async current() {
      const nowMs = (await realClock.now()).getTime();
      if (cached !== undefined && nowMs < cached.untilMs) return cached.snapshot;
      const snapshot = await load();
      cached = { snapshot, untilMs: nowMs + ttlMs };
      return snapshot;
    },
  };
}
