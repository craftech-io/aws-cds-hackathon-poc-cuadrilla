// The options of `npm run scenarios` (scripts/scenarios/run.ts), parsed apart so the tests read them without
// AWS: the suite, the scenarios, the run id (`<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>` in CI, `local-<ULID>` from
// a laptop), the budget (docs/test-plan.md §4.4: 400 turns for `full`, 120 per `EV-01`), the edge's URLs of
// `SC-00`, where the reports go, and the two modes that never reach the stage (`--dry-run`, `--aggregate`).
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { RunId } from "../../../packages/bff/src/qa-driver/contract";

export type SuiteName = "smoke" | "full" | "eval" | "load";

export interface CliOptions {
  readonly suite: SuiteName;
  readonly only?: readonly string[];
  readonly runId: string;
  readonly maxTurns: number;
  /** `--suite eval`: validations of `EV-02` (docs/test-plan.md §4.4: 80). */
  readonly maxValidations?: number;
  readonly maxCostUsd?: number;
  readonly parallel: number;
  readonly baseUrl?: string;
  readonly bffUrl?: string;
  readonly reportDir: string;
  readonly aggregate?: string;
  readonly dryRun: boolean;
  /** `SC-17` with the live transport enabled (P-01): someone holds the team phone and answers the runner's prompts. */
  readonly liveOperator: boolean;
  readonly livePhoto: "PASS" | "NOT_PASS";
}

const SUITES: readonly SuiteName[] = ["smoke", "full", "eval", "load"];
const DEFAULT_TURNS: Readonly<Record<SuiteName, number>> = { smoke: 40, full: 400, eval: 120, load: 80 };
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** `local-<26 Crockford characters>`: time first, so two local runs sort by when they started. */
export function localRunId(now: number = Date.now(), random: Buffer = randomBytes(16)): string {
  let time = "";
  let rest = now;
  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD.charAt(rest % 32) + time;
    rest = Math.floor(rest / 32);
  }
  const tail = Array.from({ length: 16 }, (_, index) => CROCKFORD.charAt((random[index] ?? 0) % 32)).join("");
  return `local-${time}${tail}`;
}

export function runIdOf(explicit: string | undefined, env: Readonly<Record<string, string | undefined>>): string {
  const candidate = explicit ?? (env.GITHUB_RUN_ID === undefined ? undefined : `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? "1"}`) ?? localRunId();
  return RunId.parse(candidate);
}

function positive(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new RangeError(`--${name} expects a positive number`);
  return parsed;
}

export function parseCli(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      suite: { type: "string", default: "smoke" },
      only: { type: "string" },
      "run-id": { type: "string" },
      "max-turns": { type: "string" },
      "max-validations": { type: "string" },
      "max-cost-usd": { type: "string" },
      parallel: { type: "string" },
      "base-url": { type: "string" },
      "bff-url": { type: "string" },
      "report-dir": { type: "string", default: "scenario-report" },
      aggregate: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "live-operator": { type: "boolean", default: false },
      "live-photo": { type: "string", default: "NOT_PASS" },
    },
  });
  const suite = values.suite as SuiteName;
  if (!SUITES.includes(suite)) throw new RangeError(`--suite expects one of ${SUITES.join(", ")}`);
  const livePhoto = values["live-photo"];
  if (livePhoto !== "PASS" && livePhoto !== "NOT_PASS") throw new RangeError("--live-photo expects PASS or NOT_PASS");
  const parallel = positive("parallel", values.parallel) ?? 4;
  if (!Number.isInteger(parallel) || parallel > 4) throw new RangeError("--parallel expects 1 to 4");
  const maxCostUsd = positive("max-cost-usd", values["max-cost-usd"]);
  const maxValidations = positive("max-validations", values["max-validations"]);
  return {
    suite,
    ...(values.only === undefined ? {} : { only: values.only.split(",").map((id) => id.trim().toUpperCase()).filter((id) => id.length > 0) }),
    runId: runIdOf(values["run-id"], env),
    maxTurns: positive("max-turns", values["max-turns"]) ?? DEFAULT_TURNS[suite],
    ...(maxValidations === undefined ? {} : { maxValidations }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    parallel,
    ...(values["base-url"] === undefined ? {} : { baseUrl: values["base-url"] }),
    ...(values["bff-url"] === undefined ? {} : { bffUrl: values["bff-url"] }),
    reportDir: values["report-dir"] ?? "scenario-report",
    ...(values.aggregate === undefined ? {} : { aggregate: values.aggregate }),
    dryRun: values["dry-run"] ?? false,
    liveOperator: values["live-operator"] ?? false,
    livePhoto,
  };
}
