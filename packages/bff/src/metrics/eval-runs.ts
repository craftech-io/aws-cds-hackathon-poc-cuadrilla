// The latest published run of each measurement (docs/architecture.md §6 `CuadrillaMetrics`, docs/test-plan.md
// §5): one pointer row per kind, `PK EVALRUN#LATEST` · `SK Q|P` (`Q` the manual's questions, `EV-01`; `P` the
// photos, `EV-02`) with `{ispId, runId, finishedAtReal}`. The evaluation writes it with `publishEvalRun` once
// a run's `EvalResult` rows and report are complete (WP-46); the console's "Medición del manual" and
// "Medición de fotos" tabs read the run it names (routers/metrics.ts). Neither the pointer nor the
// `EvalResult` rows carry `expiresAt` (they name no world's clock): a published run stays readable until
// the next one replaces the pointer.
import { z } from "zod";
import type { TableClient } from "../connector/table-client";

export const EVAL_RUN_POINTER_PK = "EVALRUN#LATEST";

export type EvalRunKind = "Q" | "P";

export interface EvalRunRef {
  readonly ispId: string;
  readonly runId: string;
  readonly finishedAtReal?: string;
}

export interface EvalRunIndex {
  latest(kind: EvalRunKind): Promise<EvalRunRef | undefined>;
}

const EvalRunPointer = z.object({ ispId: z.string().regex(/^isp-eval-[A-Za-z0-9-]{1,128}$/), runId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/), finishedAtReal: z.iso.datetime({ offset: true }).optional() }).loose();

export function tableEvalRuns(client: Pick<TableClient, "get">): EvalRunIndex {
  return {
    async latest(kind) {
      const parsed = EvalRunPointer.safeParse(await client.get("CuadrillaMetrics", { PK: EVAL_RUN_POINTER_PK, SK: kind }));
      if (!parsed.success) return undefined;
      return { ispId: parsed.data.ispId, runId: parsed.data.runId, ...(parsed.data.finishedAtReal === undefined ? {} : { finishedAtReal: parsed.data.finishedAtReal }) };
    },
  };
}

/** Publishes a finished run as the latest of its kind (the evaluation, WP-46): unconditional, never expires. */
export async function publishEvalRun(client: Pick<TableClient, "put">, kind: EvalRunKind, run: Required<EvalRunRef>): Promise<void> {
  const pointer = EvalRunPointer.parse(run);
  await client.put("CuadrillaMetrics", { PK: EVAL_RUN_POINTER_PK, SK: kind, entity: "EvalRunPointer", kind, ispId: pointer.ispId, runId: pointer.runId, finishedAtReal: run.finishedAtReal });
}
