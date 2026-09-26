// The storage spec (storage-keys.ts) against docs/architecture.md §5, §6 and §14, the CI fences
// (ci-spec.ts) and the capabilities of every role (iam-capabilities.ts). The tables and buckets are
// built from this spec, so a table that drifts from §5, a bucket that loses a lifecycle rule or gains
// a CORS rule, or a grant that points outside the key layout fails here, before any deploy.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_BUCKETS, CONSOLE_CSP, UPLOAD_BUCKETS, bucketPrefix, browserBucketName } from "./ci-spec";
import { LAMBDA_CAPABILITIES, SERVICE_ROLES, expectedGrants, expectedTables, type BucketName, type LambdaName, type RoleName } from "./iam-capabilities";
import {
  ABORT_MULTIPART_AFTER_DAYS,
  BUCKET_LOGICAL_NAME_MAX_LENGTH,
  BUCKET_SPECS,
  MANUAL_PREFIX,
  MEDIA_TRANSCRIPTS_PREFIX,
  MOCK_TABLES,
  PRIMARY_KEY,
  QA_PREFIXES,
  QA_RETENTION_DAYS,
  STORAGE_BUCKETS,
  STORAGE_TABLES,
  TABLE_SPECS,
  TRANSCRIPTS_RETENTION_DAYS,
  TTL_ATTRIBUTE,
  assertBucketLogicalName,
  browserUploadCors,
  expectedBuckets,
  lifecycleRules,
  parseStorageRef,
  storageFor,
  tableFields,
  type BucketSpec,
  type IndexSpec,
  type TableSpec,
} from "./storage-keys";

const APP = "aws-cds-hackathon-poc-cuadrilla";
const STAGE = "poc";
const ACCOUNT = "776805327629";
const APP_ORIGIN = "https://cuadrilla.demo.craftech.io";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const architecture = read("docs/architecture.md");
const allDocs = readdirSync(resolve(process.cwd(), "docs"))
  .filter((file) => file.endsWith(".md"))
  .map((file) => read(`docs/${file}`))
  .join("\n");
const infraSource = (file: string): string => read(`infra/${file}`);
/** An infra module without its comment lines, for checks on what the code does. */
const infraCode = (file: string): string =>
  infraSource(file)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

function section(start: string, end: string): string {
  return architecture.slice(architecture.indexOf(start), architecture.indexOf(end));
}

/** Cells of every markdown table row of a section whose first cell is a code literal. */
function rows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim()));
}

const LAMBDAS = Object.keys(LAMBDA_CAPABILITIES) as LambdaName[];
const ROLES = [...LAMBDAS, ...(Object.keys(SERVICE_ROLES) as RoleName[])];
const spec = (name: BucketName): BucketSpec => BUCKET_SPECS[name];
const wholeBucketDays = (bucket: BucketName): number | undefined => spec(bucket).expirations.find((rule) => rule.prefix === undefined)?.days;
const prefixDays = (bucket: BucketName, prefix: string): number | undefined =>
  spec(bucket).expirations.find((rule) => rule.prefix === prefix)?.days;

// ---- §5 -------------------------------------------------------------------------------------------

/** GSIs and TTL of every table of §5: `GSIn` `hashKey` … + `rangeKey`; "(igual que `T`)"; TTL "—" = none. */
function documentedTables(): Map<string, TableSpec> {
  const tables = new Map<string, { indexes: Record<string, IndexSpec>; ttl: boolean }>();
  const sameAs: Array<{ table: string; index: string; other: string }> = [];
  for (const [first = "", , , , gsis = "", ttl = ""] of rows(section("## 5. DynamoDB", "## 6. S3"))) {
    const name = /^`(\w+)`$/.exec(first)?.[1];
    if (!name) continue;
    const indexes: Record<string, IndexSpec> = {};
    for (const part of gsis.split(/(?=`GSI\d`)/)) {
      const head = /^`(GSI\d)` `(\w+)`/.exec(part);
      if (!head?.[1] || !head[2]) continue;
      const rangeKey = /\+ `(\w+)`/.exec(part)?.[1];
      indexes[head[1]] = rangeKey ? { hashKey: head[2], rangeKey } : { hashKey: head[2] };
      const other = /igual que `(\w+)`/.exec(part)?.[1];
      if (other) sameAs.push({ table: name, index: head[1], other });
    }
    tables.set(name, { indexes, ttl: ttl !== "—" });
  }
  // "`GSI4` `clockDueKey` (igual que `WorkOrders`)": the index of that table with the same hash key.
  for (const { table, index, other } of sameAs) {
    const indexes = tables.get(table)?.indexes ?? {};
    const hashKey = indexes[index]?.hashKey;
    const source = Object.values(tables.get(other)?.indexes ?? {}).find((candidate) => candidate.hashKey === hashKey);
    expect(source, `${table}.${index} like ${other}`).toBeDefined();
    if (source) indexes[index] = source;
  }
  return tables;
}

describe("DynamoDB tables of docs/architecture.md §5", () => {
  const documented = documentedTables();

  it("declares every table of §5 except the two the mocks own", () => {
    expect(documented.size).toBe(11);
    expect([...MOCK_TABLES]).toEqual(["Network", "Dispatch"]);
    expect([...STORAGE_TABLES, ...MOCK_TABLES].sort()).toEqual([...documented.keys()].sort());
  });

  it.each(STORAGE_TABLES)("keeps the GSIs and the TTL of %s exactly as §5", (name) => {
    expect(TABLE_SPECS[name].indexes).toEqual(documented.get(name)?.indexes);
    expect(TABLE_SPECS[name].ttl).toBe(documented.get(name)?.ttl);
  });

  it("gives Cases the same due-timer index as WorkOrders, so advancing the clock queries both alike", () => {
    expect(TABLE_SPECS.Cases.indexes.GSI4).toEqual({ hashKey: "clockDueKey", rangeKey: "dueAtSim" });
    expect(TABLE_SPECS.WorkOrders.indexes.GSI3).toEqual(TABLE_SPECS.Cases.indexes.GSI4);
  });

  it("keys every table by PK and SK and expires items by expiresAt everywhere but Reference", () => {
    expect(PRIMARY_KEY).toEqual({ hashKey: "PK", rangeKey: "SK" });
    expect(TTL_ATTRIBUTE).toBe("expiresAt");
    expect(section("## 5. DynamoDB", "## 6. S3")).toContain("`world` y `expiresAt` (TTL)");
    expect(STORAGE_TABLES.filter((name) => !TABLE_SPECS[name].ttl)).toEqual(["Reference"]);
  });

  it("declares only key attributes, all strings, and numbers the GSIs without gaps", () => {
    expect(tableFields(TABLE_SPECS.WorkOrders)).toEqual({
      PK: "string",
      SK: "string",
      installerDayKey: "string",
      windowStartSim: "string",
      ispDayKey: "string",
      status: "string",
      clockDueKey: "string",
      dueAtSim: "string",
      evidenceHash: "string",
    });
    expect(tableFields(TABLE_SPECS.Runtime)).toEqual({ PK: "string", SK: "string" });
    for (const name of STORAGE_TABLES) {
      const indexes = Object.keys(TABLE_SPECS[name].indexes);
      expect(indexes, name).toEqual(indexes.map((_, position) => `GSI${position + 1}`));
      for (const index of Object.values<IndexSpec>(TABLE_SPECS[name].indexes)) expect(["PK", "SK"]).not.toContain(index.hashKey);
    }
  });

  it("creates one encrypted component per table of the spec, under its logical name, without streams", () => {
    const source = infraCode("storage-tables.ts");
    const created = [...source.matchAll(/\btable\("([A-Za-z]+)"\)/g)].map((match) => match[1]);
    expect(created.sort()).toEqual([...STORAGE_TABLES].sort());
    expect(source).toContain("args.serverSideEncryption = { enabled: true };");
    expect(source).not.toMatch(/stream:|deletionProtection/);
  });
});

// ---- §6 -------------------------------------------------------------------------------------------

/** Static part of a documented key (`photos/<workOrderId>/…` → `photos/`). */
function staticPrefix(key: string): string {
  const head = key.includes("<") ? key.slice(0, key.indexOf("<")) : key;
  return head.slice(0, head.lastIndexOf("/") + 1);
}

interface DocumentedBucket {
  readonly prefixes: string[];
  readonly retention: string;
}

function documentedBuckets(): Map<string, DocumentedBucket> {
  const buckets = new Map<string, DocumentedBucket>();
  for (const [first = "", layout = "", , retention = ""] of rows(section("## 6. S3", "## 7."))) {
    const name = /^`(\w+)`$/.exec(first)?.[1];
    if (!name) continue;
    const keys = [...layout.replace(/\([^()]*\)/g, "").matchAll(/`([^`]*\/[^`]*)`/g)].map((match) => staticPrefix(match[1] ?? ""));
    buckets.set(name, { prefixes: keys, retention });
  }
  return buckets;
}

describe("S3 buckets of docs/architecture.md §6", () => {
  const documented = documentedBuckets();
  const days = (bucket: BucketName, pattern: RegExp): number | undefined => {
    const found = pattern.exec(documented.get(bucket)?.retention ?? "")?.[1];
    return found === undefined ? undefined : Number(found);
  };

  it("declares every bucket of §6", () => {
    expect([...documented.keys()].sort()).toEqual([...STORAGE_BUCKETS].sort());
  });

  it.each(STORAGE_BUCKETS)("keeps the retention of %s as §6 states it", (name) => {
    expect(wholeBucketDays(name)).toBe(days(name, /^(\d+) días?/));
    for (const prefix of QA_PREFIXES) {
      const qa = days(name, /`qa\/` y `eval\/` (\d+) días/);
      if (qa !== undefined) expect(prefixDays(name, prefix)).toBe(qa);
    }
  });

  it("expires the Transcribe output of Media after one day, the backstop of §6 and WP-21", () => {
    expect(days("Media", /regla de ciclo de vida de (\d+) día/)).toBe(TRANSCRIPTS_RETENTION_DAYS);
    expect(prefixDays("Media", MEDIA_TRANSCRIPTS_PREFIX)).toBe(1);
    expect(read("docs/build-plan.md")).toContain("regla de ciclo de vida de 1 día en `Media/transcripts/`");
  });

  it.each(STORAGE_BUCKETS)("keeps the key layout of %s as the docs state it", (name) => {
    const inTable = documented.get(name)?.prefixes ?? [];
    expect(inTable.length).toBeGreaterThan(0);
    for (const key of inTable) expect(spec(name).prefixes.some((prefix) => key.startsWith(prefix)), key).toBe(true);
    for (const prefix of spec(name).prefixes) {
      const documentedAnywhere = inTable.some((key) => key.startsWith(prefix)) || allDocs.includes(`\`${name}/${prefix}`);
      expect(documentedAnywhere, `${name}/${prefix}`).toBe(true);
    }
    expect(BUCKET_SPECS.Manual.prefixes).toEqual([MANUAL_PREFIX]);
  });

  it("aborts incomplete multipart uploads in every bucket and never reuses a rule id", () => {
    for (const name of STORAGE_BUCKETS) {
      const rules = lifecycleRules(spec(name));
      expect(rules[0]).toEqual({
        id: "abort-incomplete-multipart",
        status: "Enabled",
        filter: {},
        abortIncompleteMultipartUpload: { daysAfterInitiation: ABORT_MULTIPART_AFTER_DAYS },
      });
      expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
    }
    expect(lifecycleRules(spec("Evidence")).slice(1)).toEqual([
      { id: "expire-qa", status: "Enabled", filter: { prefix: "qa/" }, expiration: { days: 2 } },
      { id: "expire-eval", status: "Enabled", filter: { prefix: "eval/" }, expiration: { days: 2 } },
    ]);
  });

  it("expires qa/ and eval/ within two days in exactly the buckets QA and evaluation worlds write to", () => {
    const qaDeletes = expectedGrants("QaDriver")
      .filter((grant) => grant.actions.includes("s3:DeleteObject"))
      .flatMap((grant) => grant.resources);
    const written = [...new Set(qaDeletes.map((resource) => /^\{(\w+)\}\/(?:qa|eval)\/\*$/.exec(resource)?.[1]))].sort();
    expect(written).toEqual(["Evidence", "Media"]);
    for (const name of STORAGE_BUCKETS) {
      for (const prefix of QA_PREFIXES) {
        const expected = written.includes(name) ? QA_RETENTION_DAYS : undefined;
        expect(prefixDays(name, prefix), `${name}/${prefix}`).toBe(expected);
        expect(qaDeletes.includes(`{${name}}/${prefix}*`), `${name}/${prefix}`).toBe(expected !== undefined);
      }
    }
  });

  it("keeps the evaluation set of Seed and the manual for the life of the stage", () => {
    expect(BUCKET_SPECS.Seed.prefixes).toContain("eval/");
    for (const name of ["Seed", "Manual"] as const) expect(lifecycleRules(spec(name)).map((rule) => rule.id)).toEqual(["abort-incomplete-multipart"]);
  });

  it("names buckets within the 16 characters the CI bucket fence allows, apart from every other component", () => {
    expect(section("## 6. S3", "## 7.")).toContain(`Nombres lógicos ≤ ${BUCKET_LOGICAL_NAME_MAX_LENGTH} caracteres`);
    const created = [...infraSource("storage-buckets.ts").matchAll(/\bbucket\("([A-Za-z]+)"\)/g)].map((match) => match[1] ?? "");
    expect(created.sort()).toEqual([...STORAGE_BUCKETS].sort());
    for (const name of created) expect(assertBucketLogicalName(name)).toBe(name);
    expect(() => assertBucketLogicalName("B".repeat(BUCKET_LOGICAL_NAME_MAX_LENGTH + 1))).toThrow(/at most 16/);
    expect(() => assertBucketLogicalName("media")).toThrow(/PascalCase/);
    expect(infraSource("storage-buckets.ts")).toContain("new sst.aws.Bucket(assertBucketLogicalName(name)");

    // SST rejects two components with the same name, case-insensitively, anywhere in the app.
    const others = readdirSync(resolve(process.cwd(), "infra"))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.startsWith("storage"))
      .flatMap((file) => [...infraSource(file).matchAll(/new sst\.(?:aws\.)?\w+\(\s*"([A-Za-z0-9]+)"/g)].map((match) => (match[1] ?? "").toLowerCase()));
    for (const name of [...STORAGE_TABLES, ...STORAGE_BUCKETS]) expect(others, name).not.toContain(name.toLowerCase());
    expect(new Set([...STORAGE_TABLES, ...STORAGE_BUCKETS].map((name) => name.toLowerCase())).size).toBe(STORAGE_TABLES.length + STORAGE_BUCKETS.length);
  });

  it("gives the browser buckets the names the CSP allows and leaves Manual under SST's name", () => {
    const browser = STORAGE_BUCKETS.flatMap((name) => {
      const naming = spec(name).naming;
      return naming.kind === "browser" ? [[name, naming.purpose] as const] : [];
    });
    expect(browser).toEqual([
      ["Media", "media"],
      ["Evidence", "evidence"],
      ["Seed", "seed"],
    ]);
    expect(browser.map(([, purpose]) => purpose).sort()).toEqual([...BROWSER_BUCKETS].sort());
    expect(BUCKET_SPECS.Manual.naming).toEqual({ kind: "sst" });
    for (const [, purpose] of browser) {
      const name = browserBucketName(APP, STAGE, purpose, ACCOUNT);
      expect(name.startsWith(bucketPrefix(APP))).toBe(true);
      expect(name.length).toBeLessThanOrEqual(63);
      expect(CONSOLE_CSP).toContain(`-${purpose}-\${AWS::AccountId}.s3.`);
    }
    expect(infraSource("storage-buckets.ts")).toContain("browserBucketName($app.name, $app.stage, naming.purpose, account)");
  });

  it("keeps every bucket private, HTTPS-only and SSE-S3, with one lifecycle configuration built here", () => {
    const source = infraCode("storage-buckets.ts");
    // SST's defaults: public access blocked, Deny without aws:SecureTransport. Never switched off, and
    // no extra policy (a bucket has exactly one, the component's).
    expect(source).not.toMatch(/enforceHttps|access:|public:|publicAccessBlock|policy:|lifecycle:|versioning:/);
    expect(source).toContain('sseAlgorithm: "AES256"');
    expect(source).toContain("rules: lifecycleRules(spec)");
    expect(section("## 6. S3", "## 7.")).toContain("Todos privados, SSE-S3, `BlockPublicAccess` total, TLS obligatorio");
  });
});

describe("CORS of the bucket the browser uploads to", () => {
  const cors = section("## 6. S3", "## 7.")
    .split("\n")
    .find((line) => line.startsWith("- **CORS**"));

  it("allows only POST from the console origin, for five minutes, as §6 states", () => {
    expect(browserUploadCors(APP_ORIGIN)).toEqual({
      allowOrigins: [APP_ORIGIN],
      allowMethods: ["POST"],
      allowHeaders: ["*"],
      exposeHeaders: [],
      maxAgeSeconds: 300,
    });
    for (const text of ["en `Media`", `\`AllowedOrigins = ${APP_ORIGIN}\``, "`POST`", "`MaxAge 300`"]) expect(cors).toContain(text);
    expect(infraSource("storage-buckets.ts")).toContain("browserUploadCors(appUrl)");
  });

  it("puts a rule only on Media, the one upload bucket of the CSP; the rest get none", () => {
    const uploads = STORAGE_BUCKETS.filter((name) => spec(name).browserUploads);
    expect(uploads).toEqual(["Media"]);
    const purposes = uploads.map((name) => {
      const naming = spec(name).naming;
      return naming.kind === "browser" ? naming.purpose : undefined;
    });
    expect(purposes).toEqual([...UPLOAD_BUCKETS]);
    // SST's default CORS rule allows every origin and method: every other bucket must get `false`.
    expect(infraSource("storage-buckets.ts")).toMatch(/if \(!spec\.browserUploads\) return false;/);
  });
});

// ---- §14: storage each role reaches -----------------------------------------------------------------

describe("storage each Lambda links", () => {
  it.each(LAMBDAS)("gives %s exactly the tables of its capabilities", (fn) => {
    const needs = storageFor(fn);
    expect([...needs.tables, ...needs.mockTables].sort()).toEqual(Object.keys(expectedTables(fn)).sort());
    for (const table of needs.mockTables) expect(MOCK_TABLES).toContain(table);
  });

  it("links every table to some Lambda and reaches every bucket but Manual by a link or a grant", () => {
    const linked = LAMBDAS.map(storageFor);
    for (const table of STORAGE_TABLES) expect(linked.some((needs) => needs.tables.includes(table)), table).toBe(true);
    const granted = ROLES.flatMap((role) => expectedGrants(role).flatMap((grant) => grant.resources));
    const reached = STORAGE_BUCKETS.filter((bucket) => linked.some((needs) => needs.buckets.includes(bucket)) || granted.some((resource) => resource.startsWith(`{${bucket}}`)));
    // Manual is read only by the Knowledge Base role (infra/storage-kb.ts) and written by the loader.
    expect(reached.sort()).toEqual(["Evidence", "Media", "Seed"]);
  });

  it("links a table only as data access: CostGuard reaches Runtime through its fenced grant alone", () => {
    expect(storageFor("CostGuard")).toEqual({ tables: ["AuditLog"], mockTables: [], buckets: [] });
    expect(expectedBuckets("Bff")).toEqual(["Evidence", "Media"]);
    expect(storageFor("WorldJanitor").mockTables).toEqual(["Dispatch", "Network"]);
  });
});

describe("storage references of the IAM grants", () => {
  const references = ROLES.flatMap((role) =>
    expectedGrants(role).flatMap((grant) => [...grant.resources, ...(grant.conditions ?? []).flatMap((condition) => condition.values)].map((value) => [role, value] as const)),
  );

  it("resolves every table, bucket, object prefix and bucket name the grants name", () => {
    expect(parseStorageRef("{Runtime}")).toEqual({ kind: "table", name: "Runtime" });
    expect(parseStorageRef("{Evidence}/photos/*")).toEqual({ kind: "bucket", name: "Evidence", objects: "photos/*" });
    expect(parseStorageRef("{Seed}/*")).toEqual({ kind: "bucket", name: "Seed", objects: "*" });
    expect(parseStorageRef("{Media.name}")).toEqual({ kind: "bucket-name", name: "Media" });
    const storage = references.filter(([, value]) => /^\{(\w+)[}.]/.test(value) && parseStorageRef(value) !== undefined);
    expect(storage.length).toBeGreaterThan(10);
  });

  it("leaves ARNs, wildcards and the components of other modules to their owners", () => {
    for (const value of ["*", "{G1}", "{InstallerEvents}", "{NetworkMock}", "{Network}", "{model:HARNESS}", "arn:aws:sns:us-east-1:1:topic"]) {
      expect(parseStorageRef(value), value).toBeUndefined();
    }
  });

  it("rejects a storage placeholder in a shape nothing resolves", () => {
    for (const value of ["{Runtime}/items", "{Runtime.name}", "{Media.name}/wa/*"]) expect(() => parseStorageRef(value), value).toThrow(/cannot resolve/);
  });

  it("points every object grant inside the key layout of §6 or the QA prefixes", () => {
    for (const [role, value] of references) {
      const ref = parseStorageRef(value);
      if (ref?.kind !== "bucket" || ref.objects === undefined || ref.objects === "*") continue;
      const allowed = [...spec(ref.name).prefixes, ...(ref.name === "Seed" ? [] : QA_PREFIXES)];
      expect(allowed.some((prefix) => ref.objects?.startsWith(prefix)), `${role}: ${value}`).toBe(true);
    }
  });
});
