// The guest's world as the portada follows it: `guest.world` polled every 2 s while it is being built and
// every minute at rest, never while the tab is hidden; "Reintentar" (`guest.retryWorld`, once a minute);
// and, when the world moved to a new generation after the session was opened, one silent refresh of the
// tokens so the next call already carries the new operator (ADR-0025 §2).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../../context/SessionContext";
import { type ApiError, apiErrorOf, isAbortError } from "../../lib/api-error";
import { refreshTokens } from "../../lib/auth/tokens";
import { consoleApiOf } from "../../lib/console-api";
import { type Poller, createPoller } from "../../lib/poller";
import { type ActionState, useAction } from "../../lib/use-remote";
import { GUEST_PROCEDURES, GuestWorld, LONG_WAIT_MS, pollMs } from "./guest-home-model";

export type WorldState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly world: GuestWorld }
  | { readonly status: "error"; readonly error: ApiError; readonly world?: GuestWorld };

export interface GuestWorldValue {
  readonly state: WorldState;
  /** In `PROVISIONING` for longer than usual. */
  readonly longWait: boolean;
  readonly retry: ActionState<GuestWorld>;
  runRetry(): void;
}

const worldOf = (state: WorldState): GuestWorld | undefined => (state.status === "loading" ? undefined : state.world);

export function useGuestWorld(): GuestWorldValue {
  const { trpc, auth, state: session, completeSignIn } = useSession();
  const api = useMemo(() => consoleApiOf(trpc), [trpc]);
  const [state, setState] = useState<WorldState>({ status: "loading" });
  const [provisioningSince, setProvisioningSince] = useState<number | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const poller = useRef<Poller | undefined>(undefined);
  const refreshed = useRef(false);

  useEffect(() => {
    const instance = createPoller<GuestWorld>({
      load: (signal) => api.query(GUEST_PROCEDURES.world, undefined, GuestWorld, signal),
      intervalOf: (result) => pollMs(result.ok ? result.value : undefined),
      onResult: (result) => {
        if (result.ok) setState({ status: "ready", world: result.value });
        else if (!isAbortError(result.error)) setState((current) => ({ status: "error", error: apiErrorOf(result.error), ...withWorld(worldOf(current)) }));
        setNow(Date.now());
      },
    });
    poller.current = instance;
    const onVisibility = () => (document.hidden ? instance.pause() : instance.resume());
    document.addEventListener("visibilitychange", onVisibility);
    instance.start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      instance.stop();
      poller.current = undefined;
    };
  }, [api]);

  const world = worldOf(state);
  const status = world?.status;
  useEffect(() => {
    if (status === "PROVISIONING") setProvisioningSince((since) => since ?? Date.now());
    else setProvisioningSince(undefined);
  }, [status]);

  // A world of a newer generation than the session: the refresh token gets a token of the new operator.
  const stale = world?.refreshSession === true;
  useEffect(() => {
    if (!stale || refreshed.current || auth === undefined || session.status !== "authenticated") return;
    refreshed.current = true;
    void refreshTokens(auth.cognito, session.tokens)
      .then((tokens) => {
        completeSignIn(tokens);
        poller.current?.refresh();
      })
      .catch(() => undefined);
  }, [stale, auth, session, completeSignIn]);

  const action = useAction(async () => {
    try {
      const answer = await api.mutation(GUEST_PROCEDURES.retryWorld, undefined, GuestWorld);
      setState({ status: "ready", world: answer });
      return answer;
    } finally {
      poller.current?.refresh();
    }
  });
  const { run } = action;
  const runRetry = useCallback(() => void run(undefined), [run]);

  const longWait = provisioningSince !== undefined && now - provisioningSince >= LONG_WAIT_MS;
  return { state, longWait, retry: action.state, runRetry };
}

function withWorld(world: GuestWorld | undefined): { readonly world?: GuestWorld } {
  return world === undefined ? {} : { world };
}
