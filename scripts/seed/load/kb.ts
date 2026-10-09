// Ingestion of the manual into the Knowledge Base (docs/architecture.md §9.5, docs/architecture-integrations.md
// §8): `StartIngestionJob` on the manual's data source and `GetIngestionJob` every few seconds until
// COMPLETE (both checked in the installed `@aws-sdk/client-bedrock-agent` `.d.ts`). FAILED, STOPPED or
// the deadline fail the load: `search_procedures` must never run on half a manual. Run by `seed:load`
// with the operator's or CI's credentials, never by a Lambda; the ids come from the `KnowledgeBase` link.
import type { Ingestion } from "./run";

export type JobStatus = "STARTING" | "IN_PROGRESS" | "COMPLETE" | "FAILED" | "STOPPING" | "STOPPED";

export interface IngestionApi {
  start(): Promise<{ readonly jobId: string; readonly status: JobStatus }>;
  status(jobId: string): Promise<{ readonly status: JobStatus; readonly failureReasons?: readonly string[] }>;
}

export const INGESTION_TIMING = { pollEveryMs: 10_000, deadlineMs: 20 * 60_000 } as const;

export function pollingIngestion(api: IngestionApi, options: { readonly sleep: (ms: number) => Promise<void>; readonly now: () => number }): Ingestion {
  return {
    async ingest() {
      const started = await api.start();
      const deadline = options.now() + INGESTION_TIMING.deadlineMs;
      let status = started.status;
      while (status !== "COMPLETE") {
        if (status === "FAILED" || status === "STOPPED" || status === "STOPPING") throw new Error(`ingestion job ${started.jobId} ended ${status}`);
        if (options.now() > deadline) throw new Error(`ingestion job ${started.jobId} did not complete in ${INGESTION_TIMING.deadlineMs / 60_000} minutes`);
        await options.sleep(INGESTION_TIMING.pollEveryMs);
        const current = await api.status(started.jobId);
        status = current.status;
        if (status === "FAILED") throw new Error(`ingestion job ${started.jobId} failed: ${(current.failureReasons ?? []).slice(0, 3).join("; ")}`);
      }
      return { jobId: started.jobId, status: "COMPLETE" };
    },
  };
}
