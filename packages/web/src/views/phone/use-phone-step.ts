// React side of the SMS code (phone-model.ts): the session's `phone.status` once on mount, the send and
// the check of a code (one at a time), the error of the last action and a clock that ticks every second
// while the resend waits. `PASSED` is the end: the gate then shows the console.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LegalLocale } from "@cuadrilla/shared/legal/consents";
import { useSession } from "../../context/SessionContext";
import { toApiError } from "../../lib/api-error";
import { consoleApiOf } from "../../lib/console-api";
import { PHONE_PROCEDURES, type PhoneErrorCode, PhoneStatus, phoneErrorOf, secondsUntil } from "./phone-model";

/** `unauthorized`: the token itself was refused; the console's own screens ask to sign in again. */
export type PhoneStepState = { readonly kind: "loading" } | { readonly kind: "ready"; readonly status: PhoneStatus } | { readonly kind: "failed" } | { readonly kind: "unauthorized" };

export interface PhoneStep {
  readonly state: PhoneStepState;
  readonly error: PhoneErrorCode | undefined;
  readonly busy: boolean;
  /** Seconds until another code may be asked for. */
  readonly resendIn: number;
  send(locale: LegalLocale, phone?: string): void;
  verify(code: string): void;
  reload(): void;
}

export function usePhoneStep(): PhoneStep {
  const { trpc } = useSession();
  const api = useMemo(() => consoleApiOf(trpc), [trpc]);
  const [state, setState] = useState<PhoneStepState>({ kind: "loading" });
  const [error, setError] = useState<PhoneErrorCode | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  const running = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    api.query(PHONE_PROCEDURES.status, undefined, PhoneStatus, controller.signal).then(
      (status) => setState({ kind: "ready", status }),
      (failure: unknown) => {
        if (!controller.signal.aborted) setState({ kind: toApiError(failure).kind === "unauthorized" ? "unauthorized" : "failed" });
      },
    );
    return () => controller.abort();
  }, [api, attempt]);

  const resendAt = state.kind === "ready" ? state.status.resendAt : undefined;
  useEffect(() => {
    if (resendAt === undefined || secondsUntil(resendAt, Date.now()) === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [resendAt]);

  const act = useCallback(
    (path: string, input: unknown) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      api
        .mutation(path, input, PhoneStatus)
        .then(
          (status) => {
            setState({ kind: "ready", status });
            setError(undefined);
            setNow(Date.now());
          },
          (failure: unknown) => setError(phoneErrorOf(failure)),
        )
        .finally(() => {
          running.current = false;
          setBusy(false);
        });
    },
    [api],
  );

  const send = useCallback((locale: LegalLocale, phone?: string) => act(PHONE_PROCEDURES.send, phone === undefined ? { locale } : { locale, phone }), [act]);
  const verify = useCallback((code: string) => act(PHONE_PROCEDURES.verify, { code }), [act]);
  const reload = useCallback(() => {
    setState({ kind: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  return { state, error, busy, resendIn: secondsUntil(resendAt, now), send, verify, reload };
}
