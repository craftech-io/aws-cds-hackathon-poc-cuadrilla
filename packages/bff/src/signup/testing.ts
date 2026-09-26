// Fixtures of the sign-up tests (never imported by a Lambda): the sign-up's ports over memory (the
// `Runtime` table, the `Leads` table, the kill switch), the test master key's subkeys, a fake DNS
// resolver whose domains a test declares, a clock a test moves and deterministic ULIDs. Addresses are
// `@example.com`, `@gmail.com` or the mailbox simulator; IPs are from the documentation ranges.
import { CONSENTS_VERSION } from "@cuadrilla/shared/legal/consents";
import { MemoryTableClient } from "../connector/memory/table-client";
import { MemoryLeadTable } from "../leads/memory-table";
import { type LeadStore, createLeadStore } from "../leads/store";
import { TEST_MASTER_KEY, sequentialIds } from "../leads/testing";
import { deriveSubkey } from "../lib/crypto";
import { type Logger, createLogger } from "../lib/log";
import { createKillSwitchReader, setKillSwitch } from "../ops/kill-switch";
import { createMemoryRuntimeStore, type MemoryRuntimeStore } from "../ops/memory-runtime-store";
import type { DnsResolver, MxRecord } from "./email-domain";
import type { SignupKeys, SignupPorts } from "./start";

export const SIGNUP_T0 = new Date("2026-10-20T15:05:00.000Z");
export const VIEWER_IP = "203.0.113.10";
export const TICKET_KEY = deriveSubkey(TEST_MASTER_KEY, "signup-ticket");
export const EMAIL_HASH_KEY = deriveSubkey(TEST_MASTER_KEY, "email-hash");
export const IP_HASH_KEY = deriveSubkey(TEST_MASTER_KEY, "ip-hash");

export const TEST_KEYS: SignupKeys = { emailHash: () => EMAIL_HASH_KEY, ipHash: () => IP_HASH_KEY, ticket: () => TICKET_KEY };

export interface FakeDomain {
  readonly mx?: readonly MxRecord[];
  readonly a?: readonly string[];
  readonly aaaa?: readonly string[];
  /** The resolver's error code for every lookup of this domain (`ETIMEOUT`, `ESERVFAIL`). */
  readonly fail?: string;
  /** Answers after this long (the 1 s deadline). */
  readonly delayMs?: number;
}

const DEFAULT_DOMAIN: FakeDomain = { mx: [{ exchange: "mx.example.net", priority: 10 }] };

function absent(): Error {
  return Object.assign(new Error("no data"), { code: "ENODATA" });
}

/** Every domain answers an MX unless the test declares it; `lookups` lists what was asked. */
export function fakeResolver(domains: Readonly<Record<string, FakeDomain>> = {}): DnsResolver & { readonly lookups: string[] } {
  const lookups: string[] = [];
  const answer = async <T>(domain: string, kind: "mx" | "a" | "aaaa"): Promise<readonly T[]> => {
    lookups.push(`${kind}:${domain}`);
    const spec = domains[domain] ?? DEFAULT_DOMAIN;
    if (spec.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
    if (spec.fail !== undefined) throw Object.assign(new Error(spec.fail), { code: spec.fail });
    const records = spec[kind] as readonly T[] | undefined;
    if (records === undefined || records.length === 0) throw absent();
    return records;
  };
  return { lookups, mx: (domain) => answer<MxRecord>(domain, "mx"), a: (domain) => answer<string>(domain, "a"), aaaa: (domain) => answer<string>(domain, "aaaa") };
}

export interface SignupHarness {
  readonly runtime: MemoryTableClient;
  readonly leadTable: MemoryLeadTable;
  readonly leads: LeadStore;
  readonly kill: MemoryRuntimeStore;
  readonly resolver: ReturnType<typeof fakeResolver>;
  readonly lines: string[];
  readonly log: Logger;
  ports(): SignupPorts;
  /** The real clock of the ports. */
  now(): Date;
  advance(ms: number): void;
  setNow(at: Date): void;
  cut(scope: "SIGNUP" | "ALL"): Promise<void>;
}

/**
 * The sign-up's ports over memory with nothing that leaves the process: a fresh `Runtime` and `Leads`,
 * no kill switch on, the test keys and a DNS stand-in where every domain receives mail (the capture's
 * visitor is on `example.com`, whose real MX is null). For a local server and `testContextDeps`.
 */
export function memorySignupPorts(now: () => Date = () => new Date()): SignupPorts {
  const ids = sequentialIds("01K8");
  return {
    leads: createLeadStore(new MemoryLeadTable(), { newId: sequentialIds("01K7") }),
    runtime: new MemoryTableClient(),
    kill: createKillSwitchReader({ store: createMemoryRuntimeStore(), ttlMs: 0 }),
    keys: TEST_KEYS,
    resolver: fakeResolver(),
    now,
    newUlid: () => ids(),
  };
}

export function signupHarness(domains: Readonly<Record<string, FakeDomain>> = {}): SignupHarness {
  const runtime = new MemoryTableClient();
  const leadTable = new MemoryLeadTable();
  const leads = createLeadStore(leadTable, { newId: sequentialIds("01K7") });
  const kill = createMemoryRuntimeStore();
  const resolver = fakeResolver(domains);
  const lines: string[] = [];
  const log = createLogger({ level: "debug", sink: (line) => void lines.push(line) });
  let now = SIGNUP_T0;
  const ids = sequentialIds("01K8");
  const reader = createKillSwitchReader({ store: kill, ttlMs: 0 });
  const ports: SignupPorts = { leads, runtime, kill: reader, keys: TEST_KEYS, resolver, now: () => now, newUlid: () => ids() };
  return {
    runtime,
    leadTable,
    leads,
    kill,
    resolver,
    lines,
    log,
    ports: () => ports,
    now: () => now,
    advance: (ms) => void (now = new Date(now.getTime() + ms)),
    setNow: (at) => void (now = at),
    cut: async (scope) => void (await setKillSwitch({ store: kill }, { scope, on: true, actor: "OPERATOR" })),
  };
}

export interface FormOptions {
  readonly email?: string;
  readonly contact?: boolean;
  readonly terms?: boolean;
  readonly version?: string;
  readonly locale?: "es-MX" | "en";
  readonly extra?: Record<string, unknown>;
}

/** What the web sends for a start (never the password). */
export function signupForm(options: FormOptions = {}): Record<string, unknown> {
  const version = options.version ?? CONSENTS_VERSION;
  return {
    email: options.email ?? "ana.prueba@example.com",
    name: "Ana Prueba",
    company: "Fibra de Prueba",
    jobTitle: "Coordinadora de campo",
    locale: options.locale ?? "es-MX",
    consents: { TERMS_PRIVACY: { accepted: options.terms ?? true, textVersion: version }, CONTACT: { accepted: options.contact ?? false, textVersion: version } },
    attribution: { utm: { utm_source: "linkedin", utm_campaign: "fibra-2026", utm_term: "bad value!" }, referrer: "https://example.org/some/path?q=1" },
    ...options.extra,
  };
}
