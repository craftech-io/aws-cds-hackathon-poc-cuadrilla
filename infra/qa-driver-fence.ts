// What the QaDriver may write, as fenced grants (docs/architecture.md §14, ADR-0007). Plain data; only
// types come from infra/iam-capabilities.ts, which merges these grants into the QaDriver's row (the two
// modules never import each other's values).
//
// The QaDriver reads every app table (the appRouter it runs in process reads the kill switches, the
// caps and the reference data), but it writes only the keys of the worlds it may act on: `qa-*` and
// `eval-*` worlds (operators `isp-qa-*` and `isp-eval-*`) and the test guest `GUEST#isp-guest-test`
// (`isp-guest-test`, ids tagged `-gtest`). Every write is fenced by `dynamodb:LeadingKeys`, so IAM
// itself denies `KILL#ALL`, `KILL#AGENT`, `KILL#SIGNUP`, `KILL#SIMULATOR`, the global counters of the
// stage (`TURNCAP#GLOBAL#<day>`…), `LIVEWORLD`, `PHONELEASE#`, `JOINCODE#`, the sign-up's keys and any
// row of the demo world or of a real guest. Its only `KILL#` write is `KILL#AGENT#qa-*`.
//
// Residual fence in code only (documented in §14): `Cases` is keyed by `CASE#<ulid>`, which names no
// world, so its writes are not fenced by key; the generic transient keys of `Runtime` (`SESSION#`,
// `TURN#`, `NONCE#`, `IDEMP#`, `UPLOAD#`, `PROBE#`, the QA leases) name no world either. Both are
// fenced by the QaDriver's code (`isQaReachableClock`, `Isp.kind` ∈ {QA, EVAL} and the conditional
// writes `world IN (:qa, :eval)`).
//
// Objects: QA and evaluation keys (`qa/*`, `eval/*`), the test guest's own prefix
// (`guest/<sha256(GUEST#isp-guest-test)[0:16]>-e*`, packages/shared/src/media/keys.ts) and, read only,
// the simulator's uploads and the evidence of the QA and evaluation orders (`wo-7…`, `wo-8…`).
import { createHash } from "node:crypto";
import type { Condition, Grant } from "./iam-capabilities";

/** Clock ids of the worlds the QaDriver acts on, as `StringLike` patterns. */
const QA_CLOCKS = ["qa-*", "eval-*"] as const;
const GUEST_TEST_CLOCK = "GUEST#isp-guest-test";
const QA_OPERATORS = ["isp-qa-*", "isp-eval-*"] as const;
const GUEST_TEST_OPERATOR = "isp-guest-test";
/** Person, customer and cloned order ids of those worlds (docs/seed-spec.md §2). */
const QA_PERSON_IDS = ["*-qa-*", "*-eval-*", "*-gtest"] as const;
/** Order numbers QA (70000-79999) and evaluation (80000-89999) lease; the test guest's clones are `-gtest`. */
const QA_LEASED_ORDERS = ["wo-7*", "wo-8*"] as const;

const operatorKeys = (prefix: string): string[] => [...QA_OPERATORS.map((isp) => `${prefix}${isp}`), `${prefix}${GUEST_TEST_OPERATOR}`, `${prefix}${GUEST_TEST_OPERATOR}#*`];
const clockKeys = (prefix: string): string[] => [...QA_CLOCKS.map((clock) => `${prefix}#${clock}`), `${prefix}#${GUEST_TEST_CLOCK}`, `${prefix}#${GUEST_TEST_CLOCK}#*`];

/** `Runtime` keys keyed by a world's clock id (docs/architecture.md §5). */
const CLOCK_PREFIXES = ["CLOCK", "WORLDSTATE", "PENDING", "COUNTER#EPOCH", "TOMB", "FAULTS", "RATE", "SIMCAP", "JUMP"] as const;
/** The test scope of the global ceiling (`…#GLOBAL#<qa clock>#<day>`, packages/bff/src/ops/cost-caps.ts): `qa-*` only. */
const QA_GLOBAL_TEST_SCOPES = ["TURNCAP#GLOBAL#qa-*", "VALCAP#GLOBAL#qa-*", "TRANSCRIBE#GLOBAL#qa-*"] as const;
/** Transient keys that name no world; the code fences them (see the header). */
const TRANSIENT_KEYS = ["SESSION#*", "TURN#*", "NONCE#*", "IDEMP#*", "UPLOAD#*", "PROBE#*", "LEASE#PHONE#*", "LEASE#WONUM#*"] as const;

/** `dynamodb:LeadingKeys` the QaDriver may write, per table it writes by key. */
export const QA_DRIVER_WRITE_KEYS = {
  Runtime: [
    ...CLOCK_PREFIXES.flatMap(clockKeys),
    "KILL#AGENT#qa-*",
    ...QA_GLOBAL_TEST_SCOPES,
    ...operatorKeys("TURNCAP#"),
    ...QA_PERSON_IDS.map((id) => `INSTSTATE#${id}`),
    ...TRANSIENT_KEYS,
  ],
  Isps: operatorKeys("ISP#"),
  AuditLog: operatorKeys("ISP#"),
  CuadrillaMetrics: operatorKeys("ISP#"),
  People: [...QA_PERSON_IDS.map((id) => `PERSON#${id}`), "CUST#cust-7*", "CUST#cust-8*", ...QA_PERSON_IDS.map((id) => `CUST#${id}`), ...QA_CLOCKS.map((clock) => `ADDR#${clock}`), `ADDR#${GUEST_TEST_CLOCK}#*`],
  Conversations: [...QA_PERSON_IDS.map((id) => `PERSON#${id}`), ...operatorKeys("OUTBOX#")],
  WorkOrders: [...QA_LEASED_ORDERS, "wo-*-gtest"].map((id) => `WO#${id}`),
} as const;

export type QaFencedTable = keyof typeof QA_DRIVER_WRITE_KEYS;

/** Item writes (the reads come with the QaDriver's `read` access of every app table). */
export const ITEM_WRITES = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"] as const;

const leadingKeys = (values: readonly string[]): Condition => ({ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values });

/** `guest/<seg>` of the test guest's world without its epoch (`mediaKeySegment`, packages/shared/src/media/keys.ts). */
export function guestTestObjectPrefix(): string {
  return `guest/${createHash("sha256").update(GUEST_TEST_CLOCK, "utf8").digest("hex").slice(0, 16)}-e*`;
}

const QA_OBJECTS = ["qa/*", "eval/*"] as const;

/** Every data grant of the QaDriver beyond its reads; `Cases` is the documented exception (no world in its key). */
export function qaDriverDataGrants(): Grant[] {
  const guestTest = guestTestObjectPrefix();
  const own = (bucket: "Media" | "Evidence"): string[] => [...QA_OBJECTS.map((prefix) => `{${bucket}}/${prefix}`), `{${bucket}}/${guestTest}`];
  return [
    ...(Object.entries(QA_DRIVER_WRITE_KEYS) as Array<[QaFencedTable, readonly string[]]>).map(([table, keys]) => ({ actions: ITEM_WRITES, resources: [`{${table}}`], conditions: [leadingKeys(keys)] })),
    { sid: "CasesFencedInCode", actions: ITEM_WRITES, resources: ["{Cases}"] },
    { actions: ["s3:GetObject", "s3:PutObject"], resources: own("Media") },
    { actions: ["s3:GetObject"], resources: ["{Media}/sim/*", ...own("Evidence"), ...QA_LEASED_ORDERS.flatMap((id) => [`{Evidence}/photos/${id}`, `{Evidence}/certificates/${id}`])] },
    { actions: ["s3:DeleteObject"], resources: QA_OBJECTS.flatMap((prefix) => [`{Media}/${prefix}`, `{Evidence}/${prefix}`]) },
  ];
}
