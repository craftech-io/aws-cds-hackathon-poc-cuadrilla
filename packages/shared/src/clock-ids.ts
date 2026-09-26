// Clock ids (ADR-0010, docs/architecture.md §8): every item of a world carries the clock of its
// world, and each clock belongs to exactly one operator, so either id derives the other:
//
//   GLOBAL#<ispId>             demo world of the operator (GLOBAL#isp-demo)       Isp.kind DEMO
//   GUEST#isp-guest-<nn|test>  a guest's own world, and the operator's rehearsal  Isp.kind GUEST
//   GUEST#isp-guest-s<yymmdd><5 base32>  one generation of an own sign-up's world    Isp.kind GUEST
//   qa-<runId>-<scenario>      a scenario of the runner  ↔ isp-qa-<runId>-<scenario>   QA
//   eval-<runId>               an evaluation run         ↔ isp-eval-<runId>            EVAL
//
// Clock ids carry `#`, so they never go raw into an S3 key or URI (media/keys.ts).
import { z } from "zod";
import { type GuestOrigin, IspKind } from "./enums";
import { IspId } from "./ids";

// QA run ids may be `<github run id>-<attempt>` or `local-<ULID>` (docs/test-plan.md §4.4).
const TOKEN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
/** Operators of guest worlds: invited (`07`), the rehearsal (`test`) and each sign-up generation (`s…`). */
const GUEST_ISP = /^isp-guest-(?:\d{2}|test|s\d{6}[a-z2-7]{5})$/;
/** One generation of an own sign-up's world (ADR-0025 §2): the real creation date and 5 random base32 letters. */
export const SIGNUP_GUEST_ISP = /^isp-guest-s(\d{2})(\d{2})(\d{2})[a-z2-7]{5}$/;
/** The random part of a generation id: 5 characters of `[a-z2-7]` (about 33.5 million per day). */
export const GENERATION_SUFFIX = /^[a-z2-7]{5}$/;
const QA_ISP_PREFIX = "isp-qa-";
const EVAL_ISP_PREFIX = "isp-eval-";

export interface ParsedClockId {
  readonly kind: IspKind;
  readonly ispId: IspId;
}

export function parseClockId(value: string): ParsedClockId | undefined {
  const hash = value.indexOf("#");
  if (hash !== -1) {
    const scope = value.slice(0, hash);
    const ispId = value.slice(hash + 1);
    if (!IspId.safeParse(ispId).success) return undefined;
    if (scope === "GUEST" && GUEST_ISP.test(ispId)) return { kind: "GUEST", ispId };
    if (scope === "GLOBAL" && ispKindOfIspId(ispId) === "DEMO") return { kind: "DEMO", ispId };
    return undefined;
  }
  if (value.startsWith("qa-") && TOKEN.test(value.slice(3))) return { kind: "QA", ispId: `isp-${value}` };
  if (value.startsWith("eval-") && TOKEN.test(value.slice(5))) return { kind: "EVAL", ispId: `isp-${value}` };
  return undefined;
}

export const ClockId = z.string().refine((value) => parseClockId(value) !== undefined, "expected GLOBAL#<ispId>, GUEST#isp-guest-<nn|test|s…>, qa-<runId>-<scenario> or eval-<runId>");
export type ClockId = z.infer<typeof ClockId>;

function parsed(clockId: string): ParsedClockId {
  const result = parseClockId(clockId);
  if (result === undefined) throw new RangeError(`invalid clock id "${clockId}"`);
  return result;
}

export function ispKindOfClock(clockId: string): IspKind {
  return parsed(clockId).kind;
}

/** Operator a clock belongs to: `qa-812-1-sc-02` → `isp-qa-812-1-sc-02`. */
export function ispIdOfClock(clockId: string): IspId {
  return parsed(clockId).ispId;
}

/** Kind of an operator by its id; the inverse of the table above. */
export function ispKindOfIspId(ispId: string): IspKind {
  const id = IspId.parse(ispId);
  if (id.startsWith(QA_ISP_PREFIX)) return "QA";
  if (id.startsWith(EVAL_ISP_PREFIX)) return "EVAL";
  if (id.startsWith("isp-guest-")) return "GUEST";
  return "DEMO";
}

/** Clock of an operator's world: `isp-demo` → `GLOBAL#isp-demo`, `isp-guest-07` → `GUEST#isp-guest-07`. */
export function clockIdOfIsp(ispId: string): ClockId {
  const id = IspId.parse(ispId);
  switch (ispKindOfIspId(id)) {
    case "QA":
    case "EVAL":
      return ClockId.parse(id.slice("isp-".length));
    case "GUEST":
      return ClockId.parse(`GUEST#${id}`);
    case "DEMO":
      return ClockId.parse(`GLOBAL#${id}`);
  }
}

export function guestClockId(guest: number | "test"): ClockId {
  const suffix = guest === "test" ? "test" : String(guest).padStart(2, "0");
  return ClockId.parse(`GUEST#isp-guest-${suffix}`);
}

/** `qa-<runId>-<scenario>`, e.g. `qa-812-1-sc-02` or `qa-local-01J9ZQX-sc04-dup`. */
export function qaClockId(runId: string, scenario: string): ClockId {
  return ClockId.parse(`qa-${runId}-${scenario}`);
}

export function evalClockId(runId: string): ClockId {
  return ClockId.parse(`eval-${runId}`);
}

/**
 * Tag the ids of a cloned world carry where the table is shared and the numbers repeat
 * (docs/seed-spec.md §2): guest worlds reuse the demo numbers (`wo-24817-g03`, `wo-24817-gtest`,
 * `wo-24817-gs260926abcde`). The demo world keeps the original ids, and QA and evaluation worlds
 * lease their own numbers.
 */
export function clockTagOf(clockId: string): string | undefined {
  const { kind, ispId } = parsed(clockId);
  return kind === "GUEST" ? `g${ispId.slice("isp-guest-".length)}` : undefined;
}

/** The demo operator and its world (docs/seed-spec.md §3-§4). */
export const DEMO_ISP_ID: IspId = "isp-demo";
export const DEMO_CLOCK_ID: ClockId = "GLOBAL#isp-demo";

/** Operator rehearsal world, also the world of the `QaDriver`'s `GUEST` principal (ADR-0007). */
export const GUEST_TEST_ISP_ID: IspId = "isp-guest-test";
export const GUEST_TEST_CLOCK_ID: ClockId = "GUEST#isp-guest-test";

/**
 * Worlds the `QaDriver` may act on (docs/tool-catalog.md, "Acciones del QaDriver"): its own `qa-*`
 * and `eval-*` worlds, and the closed list of actions on `GUEST#isp-guest-test`.
 */
export function isQaReachableClock(clockId: string): boolean {
  const result = parseClockId(clockId);
  return result !== undefined && (result.kind === "QA" || result.kind === "EVAL" || clockId === GUEST_TEST_CLOCK_ID);
}

// ---- Guest worlds by origin (ADR-0024, ADR-0025 §2) ----------------------------------------------

/** Whether an operator is a generation of an own sign-up's world (`isp-guest-s<yymmdd><5 base32>`). */
export function isSignupGuestIsp(ispId: string): boolean {
  return SIGNUP_GUEST_ISP.test(ispId);
}

/** Origin of a guest operator by its id; `undefined` for any other operator. */
export function guestOriginOfIsp(ispId: string): GuestOrigin | undefined {
  if (!GUEST_ISP.test(ispId)) return undefined;
  if (ispId === GUEST_TEST_ISP_ID) return "TEST";
  return isSignupGuestIsp(ispId) ? "SIGNUP" : "INVITED";
}

/** `yymmdd` of a real instant, in UTC: the creation date a generation id carries. */
export function generationDateTag(createdAtReal: Date): string {
  const iso = createdAtReal.toISOString();
  return `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`;
}

/** `isp-guest-s<yymmdd><suffix>`: the operator of a new generation created at `createdAtReal`. */
export function signupGenerationIspId(createdAtReal: Date, suffix: string): IspId {
  if (!GENERATION_SUFFIX.test(suffix)) throw new RangeError("a generation suffix is 5 characters of [a-z2-7]");
  return IspId.parse(`isp-guest-s${generationDateTag(createdAtReal)}${suffix}`);
}

/**
 * The real creation day of a generation (`2026-09-26`, UTC) from its id; `undefined` for an operator
 * that is not a sign-up generation or whose date is not a calendar day.
 */
export function signupGenerationDay(ispId: string): string | undefined {
  const match = SIGNUP_GUEST_ISP.exec(ispId);
  if (match === null) return undefined;
  const [, yy = "", mm = "", dd = ""] = match;
  const day = `20${yy}-${mm}-${dd}`;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day ? undefined : day;
}
