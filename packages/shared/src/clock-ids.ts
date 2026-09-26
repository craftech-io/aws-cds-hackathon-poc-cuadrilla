// Clock ids (ADR-0010, docs/architecture.md §8): every item of a world carries the clock of its
// world, and each clock belongs to exactly one operator, so either id derives the other:
//
//   GLOBAL#<ispId>             demo world of the operator (GLOBAL#isp-demo)       Isp.kind DEMO
//   JUDGE#isp-judge-<nn|test>  a judge's own world, and the operator's rehearsal  Isp.kind JUDGE
//   qa-<runId>-<scenario>      a scenario of the runner  ↔ isp-qa-<runId>-<scenario>   QA
//   eval-<runId>               an evaluation run         ↔ isp-eval-<runId>            EVAL
//
// Clock ids carry `#`, so they never go raw into an S3 key or URI (media/keys.ts).
import { z } from "zod";
import { IspKind } from "./enums";
import { IspId } from "./ids";

// QA run ids may be `<github run id>-<attempt>` or `local-<ULID>` (docs/test-plan.md §4.4).
const TOKEN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const JUDGE_ISP = /^isp-judge-(?:\d{2}|test)$/;
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
    if (scope === "JUDGE" && JUDGE_ISP.test(ispId)) return { kind: "JUDGE", ispId };
    if (scope === "GLOBAL" && ispKindOfIspId(ispId) === "DEMO") return { kind: "DEMO", ispId };
    return undefined;
  }
  if (value.startsWith("qa-") && TOKEN.test(value.slice(3))) return { kind: "QA", ispId: `isp-${value}` };
  if (value.startsWith("eval-") && TOKEN.test(value.slice(5))) return { kind: "EVAL", ispId: `isp-${value}` };
  return undefined;
}

export const ClockId = z.string().refine((value) => parseClockId(value) !== undefined, "expected GLOBAL#<ispId>, JUDGE#isp-judge-<nn>, qa-<runId>-<scenario> or eval-<runId>");
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
  if (id.startsWith("isp-judge-")) return "JUDGE";
  return "DEMO";
}

/** Clock of an operator's world: `isp-demo` → `GLOBAL#isp-demo`, `isp-judge-07` → `JUDGE#isp-judge-07`. */
export function clockIdOfIsp(ispId: string): ClockId {
  const id = IspId.parse(ispId);
  switch (ispKindOfIspId(id)) {
    case "QA":
    case "EVAL":
      return ClockId.parse(id.slice("isp-".length));
    case "JUDGE":
      return ClockId.parse(`JUDGE#${id}`);
    case "DEMO":
      return ClockId.parse(`GLOBAL#${id}`);
  }
}

export function judgeClockId(judge: number | "test"): ClockId {
  const suffix = judge === "test" ? "test" : String(judge).padStart(2, "0");
  return ClockId.parse(`JUDGE#isp-judge-${suffix}`);
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
 * (docs/seed-spec.md §2): judge worlds reuse the demo numbers (`wo-24817-j03`, `wo-24817-jtest`).
 * The demo world keeps the original ids, and QA and evaluation worlds lease their own numbers.
 */
export function clockTagOf(clockId: string): string | undefined {
  const { kind, ispId } = parsed(clockId);
  return kind === "JUDGE" ? `j${ispId.slice("isp-judge-".length)}` : undefined;
}

/** The demo operator and its world (docs/seed-spec.md §3-§4). */
export const DEMO_ISP_ID: IspId = "isp-demo";
export const DEMO_CLOCK_ID: ClockId = "GLOBAL#isp-demo";

/** Operator rehearsal world, also the world of the `QaDriver`'s `JUDGE` principal (ADR-0007). */
export const JUDGE_TEST_ISP_ID: IspId = "isp-judge-test";
export const JUDGE_TEST_CLOCK_ID: ClockId = "JUDGE#isp-judge-test";

/**
 * Worlds the `QaDriver` may act on (docs/tool-catalog.md, "Acciones del QaDriver"): its own `qa-*`
 * and `eval-*` worlds, and the closed list of actions on `JUDGE#isp-judge-test`.
 */
export function isQaReachableClock(clockId: string): boolean {
  const result = parseClockId(clockId);
  return result !== undefined && (result.kind === "QA" || result.kind === "EVAL" || clockId === JUDGE_TEST_CLOCK_ID);
}
