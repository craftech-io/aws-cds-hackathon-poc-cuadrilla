// `AuditLog` repository: append-only decisions, partitioned by operator and month
// (`ISP#<ispId>#<yyyy-mm>`), sorted by `<ts>#<ulid>`, indexed by order (`GSI1`) and by decision
// (`GSI2`). `ts` is the simulated instant of the world when there is one, real time otherwise.
import { Decision } from "../../domain/audit";
import { auditPartition, decisionKey, timelineKey } from "../keys";
import type { AuditPort } from "../ports-runtime";
import { utcIso } from "../table-client";
import { createEntity, nowIso, parseRows, type RepoContext } from "./repo";

const TABLE = "AuditLog";

export function auditRepo(ctx: RepoContext): AuditPort {
  const { client } = ctx;

  return {
    append(input) {
      const atReal = nowIso(ctx);
      const ts = utcIso(input.atSim ?? atReal);
      return createEntity(ctx, Decision, "Decision", {
        ...input,
        ruleIds: input.ruleIds === undefined ? [] : [...input.ruleIds],
        evaluated: input.evaluated === undefined ? [] : [...input.evaluated],
        decisionId: ctx.newId(),
        ts,
        atReal,
      });
    },

    async listByMonth(ispId, month, options = {}) {
      const rows = await client.query(TABLE, {
        hashValue: auditPartition(ispId, `${month}-01T00:00:00.000Z`),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.descending ? { descending: true } : {}),
      });
      return parseRows(Decision, rows, TABLE);
    },

    async listByWorkOrder(workOrderId) {
      return parseRows(Decision, await client.query(TABLE, { index: "GSI1", hashValue: timelineKey(workOrderId) }), TABLE);
    },

    async listByDecision(ispId, decision, options = {}) {
      const from = options.fromTs === undefined ? undefined : utcIso(options.fromTs);
      const to = options.toTs === undefined ? undefined : utcIso(options.toTs);
      const range = from !== undefined && to !== undefined ? { between: [from, to] as const } : from !== undefined ? { gte: from } : to !== undefined ? { lte: to } : undefined;
      const rows = await client.query(TABLE, {
        index: "GSI2",
        hashValue: decisionKey(ispId, decision),
        ...(range === undefined ? {} : { range }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      return parseRows(Decision, rows, TABLE);
    },
  };
}
