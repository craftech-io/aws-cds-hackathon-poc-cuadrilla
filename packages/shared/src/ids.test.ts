import { describe, expect, it } from "vitest";
import {
  DEMO_CLOCK_ID,
  GUEST_TEST_CLOCK_ID,
  clockIdOfIsp,
  clockTagOf,
  evalClockId,
  generationDateTag,
  guestOriginOfIsp,
  isQaReachableClock,
  isSignupGuestIsp,
  ispIdOfClock,
  ispKindOfClock,
  ispKindOfIspId,
  guestClockId,
  parseClockId,
  qaClockId,
  signupGenerationDay,
  signupGenerationIspId,
} from "./clock-ids";
import {
  ID_PREFIX,
  ManualSectionId,
  OnuSerial,
  PersonId,
  WORK_ORDER_NUMBER_RANGES,
  isId,
  isSetPhotoId,
  kindOfId,
  makeId,
  manualCategoryOf,
  personRoleOfId,
  seedPhotoId,
  versionTag,
  workOrderId,
  workOrderNumberOf,
  workOrderNumberRange,
} from "./ids";
import { backticked, readDoc, tableRows } from "./testing";
import { Ulid, encodeUlid, ulidTime } from "./ulid";

const SEED_SPEC = readDoc("docs/seed-spec.md");
const DOCS = ["docs/seed-spec.md", "docs/flows-catalog.md", "docs/tool-catalog.md", "docs/test-plan.md", "docs/architecture.md", "docs/architecture-integrations.md", "CONTEXT.md"];
const ID_TOKEN = /`((?:isp|zone|crew|inst|sup|zc|cust|wo|case|ev|val|ph|vn|q|usr)-[^`\s]+)`/g;
// Names of a family of renders, not ids ("distintos de todo `ph-hist`").
const FAMILY_NAMES = new Set(["ph-hist", "ph-seed"]);

function concreteTokens(pattern: RegExp): Array<{ doc: string; token: string }> {
  return DOCS.flatMap((doc) =>
    [...readDoc(doc).matchAll(pattern)]
      .map((match) => ({ doc, token: match[1] ?? "" }))
      // Placeholders (`isp-qa-<runId>-…`), ranges (`wo-24801..24812`), wildcards and file names.
      .filter(({ token }) => !/[<>*…@]|\.\.|\.(?:ts|md|json|pdf|svg|ogg|jpg)$/.test(token) && !FAMILY_NAMES.has(token)),
  );
}

describe("prefixes", () => {
  it("follow docs/seed-spec.md §2 and §4", () => {
    const formats = tableRows(SEED_SPEC, "| Entidad | Formato | Ejemplos").flatMap((cells) => backticked(cells[1] ?? ""));
    const prefixes = new Set(formats.map((format) => /^([a-z]+)-/.exec(format)?.[1]).filter((prefix) => prefix !== undefined));
    expect([...prefixes, "usr"].sort()).toEqual(Object.values(ID_PREFIX).sort());
    expect(SEED_SPEC).toContain("Usuarios de consola: `usr-adriana`");
  });

  it("every concrete id the docs cite is valid for its prefix", () => {
    const tokens = concreteTokens(ID_TOKEN);
    expect(tokens.length).toBeGreaterThan(150);
    expect(tokens.filter(({ token }) => kindOfId(token) === undefined).map(({ doc, token }) => `${doc}: ${token}`)).toEqual([]);
  });

  it("makeId, isId and kindOfId agree", () => {
    expect(makeId("workOrder", "24817")).toBe("wo-24817");
    expect(makeId("question", "A", "07")).toBe("q-A-07");
    expect(() => makeId("customer", "1042")).toThrow(RangeError);
    expect(isId("customer", "cust-10421-g03")).toBe(true);
    expect(isId("customer", "cust-10421-local-01J9ZQX-sc-02")).toBe(true);
    expect(isId("workOrder", "wo-24817-")).toBe(false);
    expect(isId("installer", "inst-qa-local-01J9ZQX-sc-02-a")).toBe(true);
    expect(isId("zone", "zone-Norte")).toBe(false);
    expect(kindOfId("val-01J9ZQXV6M3B2Y8N4T5R7K0C1D")).toBe("validation");
    expect(kindOfId("case-console")).toBeUndefined();
    expect(kindOfId("nope")).toBeUndefined();
  });

  it("people ids encode the role", () => {
    expect(personRoleOfId("inst-rogelio")).toBe("INSTALLER");
    expect(personRoleOfId("sup-adriana")).toBe("SUPERVISOR");
    expect(personRoleOfId("zc-marisol")).toBe("ZONE_CHIEF");
    expect(personRoleOfId("cust-10421")).toBe("CUSTOMER");
    expect(personRoleOfId("usr-adriana")).toBeUndefined();
    expect(PersonId.safeParse("inst-rogelio-g03").success).toBe(true);
    expect(PersonId.safeParse("cust-10421").success).toBe(false);
  });
});

describe("work orders", () => {
  it("number ranges of docs/architecture.md §5", () => {
    const match = /demo `(\d+)-(\d+)`, invitado los mismos por mundo, QA `(\d+)-(\d+)` por lease, evaluación `(\d+)-(\d+)`/.exec(readDoc("docs/architecture.md"));
    expect(match?.slice(1).map(Number)).toEqual([
      WORK_ORDER_NUMBER_RANGES.demo.min,
      WORK_ORDER_NUMBER_RANGES.demo.max,
      WORK_ORDER_NUMBER_RANGES.qa.min,
      WORK_ORDER_NUMBER_RANGES.qa.max,
      WORK_ORDER_NUMBER_RANGES.eval.min,
      WORK_ORDER_NUMBER_RANGES.eval.max,
    ]);
    expect(workOrderNumberRange("24817")).toBe("demo");
    expect(workOrderNumberRange("70412")).toBe("qa");
    expect(workOrderNumberRange("80001")).toBe("eval");
    expect(workOrderNumberRange("12345")).toBeUndefined();
  });

  it("every order of the seed is in the demo range (docs/seed-spec.md §7)", () => {
    const orders = tableRows(SEED_SPEC, "| Orden | Instalador | Cliente").flatMap((cells) => backticked(cells[0] ?? ""));
    const numbers = orders.flatMap((order) => {
      const range = /^wo-(\d{5})\.\.(\d{5})$/.exec(order);
      if (!range) return [workOrderNumberOf(order)];
      return Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, offset) => String(Number(range[1]) + offset));
    });
    expect(numbers.length).toBe(29);
    expect(numbers.every((number) => workOrderNumberRange(number) === "demo")).toBe(true);
  });

  it("clones carry the clock tag of their world", () => {
    expect(workOrderId("24817")).toBe("wo-24817");
    expect(workOrderId("24817", clockTagOf(guestClockId(3)))).toBe("wo-24817-g03");
    expect(workOrderId("24817", clockTagOf(GUEST_TEST_CLOCK_ID))).toBe("wo-24817-gtest");
    expect(workOrderNumberOf("wo-24817-g03")).toBe("24817");
    expect(() => workOrderId("2481")).toThrow();
  });
});

describe("photos, ONU, manual and versions", () => {
  it("the 60 photos of the set (docs/seed-spec.md §10), apart from historical and seeding renders", () => {
    const set = [
      ...Array.from({ length: 22 }, (_, index) => `ph-meter-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 18 }, (_, index) => `ph-label-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 16 }, (_, index) => `ph-rosette-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 4 }, (_, index) => `ph-adv-${String(index + 1).padStart(2, "0")}`),
    ];
    expect(set).toHaveLength(60);
    expect(set.every((id) => isId("photo", id) && isSetPhotoId(id))).toBe(true);
    expect(isId("photo", "ph-hist-07") && !isSetPhotoId("ph-hist-07")).toBe(true);
    expect(isId("photo", "ph-story-01") && !isSetPhotoId("ph-story-01")).toBe(true);
    expect(seedPhotoId("ONU_LABEL_PHOTO", 3)).toBe("ph-seed-ONU_LABEL_PHOTO-03");
    expect(isSetPhotoId(seedPhotoId("ROSETTE_PHOTO", 16))).toBe(false);
    expect(() => seedPhotoId("ONU_ONLINE" as never, 1)).toThrow();
    expect(isId("photo", "ph-selfie-01")).toBe(false);
  });

  it("ONU serials of the seed", () => {
    const serials = [...SEED_SPEC.matchAll(/`(DEMO[0-9A-F]+)`/g)].map((match) => match[1] ?? "");
    expect(serials.length).toBeGreaterThan(10);
    expect(serials.filter((serial) => !OnuSerial.safeParse(serial).success)).toEqual([]);
    expect(OnuSerial.safeParse("DEMO3f2c19a0").success).toBe(false);
  });

  it("manual sections and version tags", () => {
    const sections = tableRows(SEED_SPEC, "| Id | Título | Contenido clave").map((cells) => backticked(cells[0] ?? "")[0] ?? "");
    expect(sections.filter((id) => !ManualSectionId.safeParse(id).success)).toEqual([]);
    expect(manualCategoryOf("DIAG-02")).toBe("DIAG");
    expect(ManualSectionId.safeParse("XYZ-01").success).toBe(false);
    expect(versionTag(1)).toBe("v001");
    expect(() => versionTag(-1)).toThrow(RangeError);
  });
});

describe("clock ids", () => {
  it("each clock belongs to one operator and back", () => {
    const cases = [
      ["GLOBAL#isp-demo", "DEMO", "isp-demo"],
      ["GUEST#isp-guest-07", "GUEST", "isp-guest-07"],
      ["GUEST#isp-guest-test", "GUEST", "isp-guest-test"],
      ["qa-812-1-sc-02", "QA", "isp-qa-812-1-sc-02"],
      ["qa-local-01J9ZQXV6M-sc04-dup", "QA", "isp-qa-local-01J9ZQXV6M-sc04-dup"],
      ["eval-812-1", "EVAL", "isp-eval-812-1"],
    ] as const;
    for (const [clockId, kind, ispId] of cases) {
      expect(parseClockId(clockId), clockId).toEqual({ kind, ispId });
      expect(ispKindOfClock(clockId)).toBe(kind);
      expect(ispIdOfClock(clockId)).toBe(ispId);
      expect(ispKindOfIspId(ispId)).toBe(kind);
      expect(clockIdOfIsp(ispId)).toBe(clockId);
    }
  });

  it("rejects clocks of the wrong operator kind", () => {
    for (const clockId of ["GLOBAL#isp-qa-812-sc-02", "GLOBAL#isp-guest-07", "GUEST#isp-demo", "GUEST#isp-guest-abc", "GLOBAL#", "qa-", "eval-", "isp-demo", "SIM#isp-demo", "qa-a b"]) {
      expect(parseClockId(clockId), clockId).toBeUndefined();
    }
    expect(() => ispKindOfClock("isp-demo")).toThrow(RangeError);
  });

  it("builders and the concrete clocks the docs cite", () => {
    expect(guestClockId(7)).toBe("GUEST#isp-guest-07");
    expect(guestClockId("test")).toBe(GUEST_TEST_CLOCK_ID);
    expect(qaClockId("812-1", "sc-02")).toBe("qa-812-1-sc-02");
    expect(evalClockId("local-01J9ZQXV6M")).toBe("eval-local-01J9ZQXV6M");
    expect(DEMO_CLOCK_ID).toBe(clockIdOfIsp("isp-demo"));
    const cited = concreteTokens(/`((?:GLOBAL|GUEST)#[^`\s]+)`/g).map(({ token }) => token);
    expect(cited).toContain("GLOBAL#isp-demo");
    expect(cited.filter((clockId) => parseClockId(clockId) === undefined)).toEqual([]);
  });

  it("clock tags: guest worlds only", () => {
    expect(clockTagOf("GUEST#isp-guest-03")).toBe("g03");
    expect(clockTagOf(DEMO_CLOCK_ID)).toBeUndefined();
    expect(clockTagOf("qa-812-1-sc-02")).toBeUndefined();
  });

  it("[FL-107] a generation of the own sign-up is a guest world with its own tag (docs/guest-rename-map.md §A row 5)", () => {
    const ispId = "isp-guest-s261001abcde";
    const clockId = `GUEST#${ispId}`;
    expect(parseClockId(clockId)).toEqual({ kind: "GUEST", ispId });
    expect(clockIdOfIsp(ispId)).toBe(clockId);
    expect(ispKindOfIspId(ispId)).toBe("GUEST");
    expect(clockTagOf(clockId)).toBe("gs261001abcde");
    expect(workOrderId("24817", clockTagOf(clockId))).toBe("wo-24817-gs261001abcde");
    expect(isId("installer", "inst-rogelio-gs261001abcde")).toBe(true);
    expect(isQaReachableClock(clockId)).toBe(false);
    for (const bad of ["GUEST#isp-guest-s26100abcde", "GUEST#isp-guest-s261001ABCDE", "GUEST#isp-guest-s261001abcd1", "GUEST#isp-guest-s261001abcdef", "GUEST#isp-guest-sx61001abcde"]) {
      expect(parseClockId(bad), bad).toBeUndefined();
    }
  });

  it("[FL-111] generation ids carry the real creation date; every guest operator has its origin", () => {
    const createdAt = new Date("2026-10-09T23:59:59.000Z");
    expect(generationDateTag(createdAt)).toBe("261009");
    expect(signupGenerationIspId(createdAt, "vwxyz")).toBe("isp-guest-s261009vwxyz");
    expect(() => signupGenerationIspId(createdAt, "VWXYZ")).toThrow(RangeError);
    expect(() => signupGenerationIspId(createdAt, "abc01")).toThrow(RangeError);
    expect(signupGenerationDay("isp-guest-s261009vwxyz")).toBe("2026-10-09");
    expect(signupGenerationDay("isp-guest-s261332vwxyz")).toBeUndefined();
    expect(signupGenerationDay("isp-guest-07")).toBeUndefined();
    expect(isSignupGuestIsp("isp-guest-s261009vwxyz")).toBe(true);
    expect(isSignupGuestIsp("isp-guest-07")).toBe(false);
    expect(guestOriginOfIsp("isp-guest-07")).toBe("INVITED");
    expect(guestOriginOfIsp("isp-guest-test")).toBe("TEST");
    expect(guestOriginOfIsp("isp-guest-s261009vwxyz")).toBe("SIGNUP");
    expect(guestOriginOfIsp("isp-demo")).toBeUndefined();
  });

  it("the QaDriver reaches its own worlds and the guest rehearsal world only", () => {
    expect(isQaReachableClock("qa-812-1-sc-02")).toBe(true);
    expect(isQaReachableClock("eval-812-1")).toBe(true);
    expect(isQaReachableClock(GUEST_TEST_CLOCK_ID)).toBe(true);
    expect(isQaReachableClock("GUEST#isp-guest-07")).toBe(false);
    expect(isQaReachableClock(DEMO_CLOCK_ID)).toBe(false);
  });
});

describe("ulid", () => {
  it("encodes the time as the reference implementation does", () => {
    const ulid = encodeUlid(1469918176385, new Uint8Array(10));
    expect(ulid.slice(0, 10)).toBe("01ARYZ6S41");
    expect(ulidTime(ulid)).toBe(1469918176385);
    expect(Ulid.safeParse(ulid).success).toBe(true);
  });

  it("encodes the 80 bits of entropy in Crockford base32", () => {
    const entropy = new Uint8Array([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc]);
    const big = BigInt(`0x${Array.from(entropy, (byte) => byte.toString(16).padStart(2, "0")).join("")}`);
    const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const expected = [...big.toString(32).padStart(16, "0")].map((digit) => crockford[parseInt(digit, 32)]).join("");
    expect(encodeUlid(0, entropy).slice(10)).toBe(expected);
    expect(encodeUlid(2 ** 48 - 1, new Uint8Array(10).fill(255))).toBe("7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
  });

  it("rejects out of range time and entropy of the wrong size", () => {
    expect(() => encodeUlid(-1, new Uint8Array(10))).toThrow(RangeError);
    expect(() => encodeUlid(2 ** 48, new Uint8Array(10))).toThrow(RangeError);
    expect(() => encodeUlid(0, new Uint8Array(9))).toThrow(RangeError);
    expect(Ulid.safeParse("01ARYZ6S41I000000000000000").success).toBe(false);
    expect(Ulid.safeParse("81ARYZ6S410000000000000000").success).toBe(false);
  });
});
