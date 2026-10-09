// A failed BFF call as the supervisor reads it: the refusal of the BFF `reason` when there is
// one, the generic text of its kind otherwise, the way out (confirm with the password in place;
// sign in again; retry) and a short reference to quote (the first block of the correlation id).
// The English server message never becomes the headline.
import { useSession } from "../context/SessionContext";
import { dataCopy } from "../copy/console-data";
import type { ApiError } from "../lib/api-error";
import { Button } from "./Button";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The reference a person can read out: the first block of a UUID (enough to find the request in the logs). */
export function referenceOf(correlationId: string): string {
  return UUID.test(correlationId) ? correlationId.slice(0, 8).toUpperCase() : correlationId;
}

export function describeApiError(error: ApiError): string {
  const byReason = error.reason !== null ? dataCopy.byReason[error.reason] : undefined;
  return byReason ?? dataCopy.byKind[error.kind];
}

interface ApiErrorNoticeProps {
  readonly error: ApiError;
  readonly onRetry?: () => void;
  /** Extra lines under the headline (e.g. the lines of a CSV that failed). */
  readonly details?: readonly string[];
}

export function ApiErrorNotice({ error, onRetry, details }: ApiErrorNoticeProps) {
  const { openPrompt, expireSession } = useSession();
  const tone = error.kind === "recentLogin" || error.kind === "conflict" || error.kind === "precondition" ? "border-warning bg-warning-soft text-warning" : "border-danger bg-danger-soft text-danger";
  return (
    <div role="alert" className={`rounded-card border px-4 py-3 text-sm ${tone}`}>
      <p className="font-semibold">{describeApiError(error)}</p>
      {details && details.length > 0 ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-ink">
          {details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {error.kind === "recentLogin" ? (
          <Button variant="secondary" onClick={() => openPrompt("stepUp")}>
            {dataCopy.recentLogin.confirm}
          </Button>
        ) : null}
        {error.kind === "unauthorized" ? (
          <Button variant="secondary" onClick={expireSession}>
            {dataCopy.unauthorized.signIn}
          </Button>
        ) : null}
        {onRetry && (error.kind === "network" || error.kind === "unavailable" || error.kind === "unknown") ? (
          <Button variant="secondary" onClick={onRetry}>
            {dataCopy.retry}
          </Button>
        ) : null}
        {error.correlationId ? (
          <span className="text-xs text-slate">
            {dataCopy.reference}:{" "}
            <code className="font-mono" title={error.correlationId}>
              {referenceOf(error.correlationId)}
            </code>
          </span>
        ) : null}
      </div>
    </div>
  );
}
