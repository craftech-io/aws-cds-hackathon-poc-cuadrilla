/// <reference path="../../sst-env.d.ts" />
// Lambda entry of `PolicyAudit` (docs/architecture.md §12; infra/bff.ts): the daily rule of EventBridge
// and `policyAudit.run` of the QaDriver. The scheduled run audits the demo world; the QaDriver names the
// world (or worlds) of its scenario. The checks are policy-audit/audit.ts; this entry hands it the
// linked tables and the certificates' bucket and answers counts only (no message, no address).
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { ClockId, DEMO_CLOCK_ID } from "@cuadrilla/shared";
import { connector } from "../connector/index";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { createLogger, newCorrelationId } from "../lib/log";
import { bucketName } from "../lib/resource";
import { type AuditReport, type PolicyAuditDeps, auditWorld } from "../policy-audit/audit";

const OneWorld = z.object({ clockId: ClockId }).strict();
const SomeWorlds = z.object({ clockIds: z.array(ClockId).min(1).max(50) }).strict();
/** The daily rule: its input (infra/observability-spec.ts `POLICY_AUDIT.event`), or a bare scheduled event. */
const Daily = z.object({ kind: z.literal("DAILY") }).strict();
const Scheduled = z.object({ source: z.literal("aws.events") }).loose();

export interface PolicyAuditResult {
  readonly worlds: ReadonlyArray<Pick<AuditReport, "clockId" | "messages" | "emails" | "certificates" | "errors"> & { readonly violations: number }>;
}

/** The worlds an event names; `undefined` for anything else. */
export function worldsOf(event: unknown): readonly string[] | undefined {
  const one = OneWorld.safeParse(event);
  if (one.success) return [one.data.clockId];
  const some = SomeWorlds.safeParse(event);
  if (some.success) return some.data.clockIds;
  return Daily.safeParse(event).success || Scheduled.safeParse(event).success ? [DEMO_CLOCK_ID] : undefined;
}

export function createPolicyAuditHandler(depsFor: () => PolicyAuditDeps) {
  return async (event: unknown): Promise<PolicyAuditResult> => {
    const clockIds = worldsOf(event);
    if (clockIds === undefined) throw new Error("PolicyAudit takes {clockId}, {clockIds} or the daily scheduled event");
    const deps = depsFor();
    const worlds = [];
    for (const clockId of clockIds) {
      const report = await auditWorld(deps, { clockId });
      worlds.push({ clockId, messages: report.messages, emails: report.emails, certificates: report.certificates, errors: report.errors, violations: report.violations.length });
    }
    return { worlds };
  };
}

let s3: S3Client | undefined;

function isMissing(error: unknown): boolean {
  return error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound");
}

/** The PDF of a certificate in the linked `Evidence` bucket (`s3:GetObject` on its certificates only). */
async function readCertificate(key: string): Promise<Uint8Array | undefined> {
  s3 ??= new S3Client({ region: "us-east-1", ...awsClientConfig(CLIENT_TIMEOUTS.s3) });
  try {
    const output = await s3.send(new GetObjectCommand({ Bucket: bucketName("Evidence"), Key: key }));
    return output.Body === undefined ? undefined : await output.Body.transformToByteArray();
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export const handler = createPolicyAuditHandler(() => ({
  connector: connector(),
  readCertificate,
  logger: createLogger({ correlationId: newCorrelationId(), bindings: { component: "policy-audit" } }),
}));
