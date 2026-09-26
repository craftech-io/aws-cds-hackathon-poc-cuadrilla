// `npm run leads:export -- --out <path outside the repository>` (ADR-0026, "Exportación y baja del
// contacto"): the operator's CSV of leads, with the operator's profile through `sst shell`, never in CI.
//
//   default      contactable leads only: CONFIRMED, origin WEB and the CONTACT consent in force accepted
//   --all        also the confirmed leads that may not be contacted (`contactConsent = no`), for internal counts
//   --origin QA  the QA seam's leads, only for the deployed verification (docs/test-plan.md §6.1)
//
// The file is UTF-8 with the columns of ADR-0026 in their order; every cell is quoted as RFC 4180 needs
// and a cell starting with `=`, `+`, `-`, `@` (or a tab or CR) is prefixed with `'` against formula
// injection. It refuses a path inside the repository and never overwrites a file. Each exported lead
// gets an `EXPORTED` event (without the email). The script prints counts, never an address. A CSV is
// temporary: delete it after use and within 30 days at the latest.
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Lead, type LeadOrigin, emailHashOfPartition } from "../../packages/bff/src/leads/model";
import type { LeadStore } from "../../packages/bff/src/leads/store";
import { isContactable } from "../../packages/bff/src/leads/transitions";
import { parseFlags } from "../channels/cli-args";
import { assertOperatorMachine } from "./operator-only";

export const EXPORT_COLUMNS = [
  "leadId",
  "email",
  "name",
  "company",
  "jobTitle",
  "locale",
  "contactConsent",
  "contactConsentVersion",
  "termsVersion",
  "originPoc",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "referrerOrigin",
  "signupAt",
  "confirmedAt",
  "lastLoginAt",
] as const;

export const USAGE = "npm run leads:export -- --out <path outside the repository> [--all] [--contactable] [--origin WEB|QA]";

export interface ExportRequest {
  readonly out: string;
  readonly all: boolean;
  readonly origin: LeadOrigin;
}

export function parseExportArgs(argv: readonly string[]): ExportRequest {
  let out: string | undefined;
  let all = false;
  let contactable = false;
  let origin: LeadOrigin = "WEB";
  parseFlags(argv, {
    "--out": (value) => {
      out = value();
    },
    "--all": () => {
      all = true;
    },
    "--contactable": () => {
      contactable = true;
    },
    "--origin": (value) => {
      const given = value().toUpperCase();
      if (given !== "WEB" && given !== "QA") throw new RangeError(`--origin is WEB or QA\n${USAGE}`);
      origin = given;
    },
  });
  if (out === undefined) throw new RangeError(`--out is required\n${USAGE}`);
  if (all && contactable) throw new RangeError("--all and --contactable exclude each other");
  return { out, all, origin };
}

/** The repository's root (this file lives in scripts/leads/). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Refuses any destination inside the repository tree (symlinks of the existing parent resolved). */
export function assertOutsideRepo(out: string, cwd: string = process.cwd(), repoRoot: string = REPO_ROOT): string {
  const target = resolve(cwd, out);
  const roots = [repoRoot, realOrSelf(repoRoot)];
  const candidates = [target, resolve(realOrSelf(dirname(target)), basename(target))];
  for (const root of roots) {
    for (const candidate of candidates) {
      const rel = relative(root, candidate);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new RangeError("the export must be written outside the repository");
    }
  }
  return target;
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: formula prefixes neutralized, quoted when it needs it. */
export function csvCell(value: string | undefined): string {
  const text = value ?? "";
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function selectLeads(leads: readonly Lead[], request: Pick<ExportRequest, "all" | "origin">): Lead[] {
  return leads
    .filter((lead) => lead.status === "CONFIRMED" && lead.origin === request.origin && (request.all || isContactable({ ...lead, origin: "WEB" })))
    .sort((a, b) => a.leadId.localeCompare(b.leadId));
}

export function csvRow(lead: Lead): string {
  const contactable = isContactable({ ...lead, origin: "WEB" });
  const values: Readonly<Record<(typeof EXPORT_COLUMNS)[number], string | undefined>> = {
    leadId: lead.leadId,
    email: lead.email,
    name: lead.name,
    company: lead.company,
    jobTitle: lead.jobTitle,
    locale: lead.locale,
    contactConsent: contactable ? "yes" : "no",
    contactConsentVersion: lead.consents.CONTACT.textVersion,
    termsVersion: lead.consents.TERMS_PRIVACY.textVersion,
    originPoc: lead.originPoc,
    utm_source: lead.utm?.source,
    utm_medium: lead.utm?.medium,
    utm_campaign: lead.utm?.campaign,
    utm_term: lead.utm?.term,
    utm_content: lead.utm?.content,
    referrerOrigin: lead.referrerOrigin,
    signupAt: lead.signupStartedAt,
    confirmedAt: lead.confirmedAt,
    lastLoginAt: lead.lastLoginAt,
  };
  return EXPORT_COLUMNS.map((column) => csvCell(values[column])).join(",");
}

export function toCsv(leads: readonly Lead[]): string {
  return `${[EXPORT_COLUMNS.join(","), ...leads.map(csvRow)].join("\r\n")}\r\n`;
}

export interface ExportDeps {
  readonly store: LeadStore;
  readonly write: (path: string, content: string) => Promise<void>;
  readonly now: () => Date;
  readonly cwd?: string;
  readonly repoRoot?: string;
}

/** Reads, filters, writes and marks `EXPORTED`; returns how many rows went out. */
export async function runExport(request: ExportRequest, deps: ExportDeps): Promise<number> {
  const target = assertOutsideRepo(request.out, deps.cwd, deps.repoRoot);
  const leads = selectLeads(await deps.store.scan(), request);
  await deps.write(target, toCsv(leads));
  const at = deps.now();
  for (const lead of leads) await deps.store.recordEvent(emailHashOfPartition(lead.PK), "EXPORTED", "OPERATOR", at);
  return leads.length;
}

async function main(): Promise<void> {
  assertOperatorMachine();
  const request = parseExportArgs(process.argv.slice(2));
  const { dynamoLeadStore } = await import("../../packages/bff/src/leads/dynamo-table");
  const count = await runExport(request, { store: dynamoLeadStore(), write: (path, content) => writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" }), now: () => new Date() });
  console.log(`leads:export: ${count} lead(s) written (${request.all ? "all confirmed" : "contactable only"}, origin ${request.origin}). Delete the file after use, within 30 days.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(`leads:export: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
