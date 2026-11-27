// The one retention of every log group the app creates (ADR-0030, docs/architecture.md §12): 14 days, so
// an incident can still be read two weeks later and nothing is kept longer than that. The functions take it
// from the `$transform` of sst.config.ts (SST's `logging.retention` names it in words), the Harness's `live`
// runtime group from infra/agentcore.ts, and the DEFAULT runtime group is set by hand with the command of
// infra/agentcore-spec.ts (`DEFAULT_RUNTIME_LOG_RETENTION`). No group of the app keeps logs longer on
// purpose (the audit trail is the `AuditLog` table, not a log group) and none shorter.
export const LOG_RETENTION_DAYS = 14;

/** `logging.retention` of `sst.aws.Function` for LOG_RETENTION_DAYS. */
export const FUNCTION_LOG_RETENTION = "2 weeks" as const;
