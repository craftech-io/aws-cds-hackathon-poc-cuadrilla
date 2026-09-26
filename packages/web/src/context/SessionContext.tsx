// Session of the console: Cognito tokens, the principal decoded from the id token, the tRPC client
// that carries it, and the two security prompts of the console (sign in again to approve, or enrol
// the optional TOTP). React Context + useState only (CLAUDE.md: no state libraries).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type CognitoApi, createCognitoApi } from "../lib/auth/cognito";
import { type SrpClient, createSrpClient } from "../lib/auth/srp";
import { type TokenSet, clearTokens, isExpired, refreshTokens, restoreSession, revokeSession, saveTokens } from "../lib/auth/tokens";
import { principalFromIdToken, type Principal } from "../lib/auth-claims";
import { readAuthEnv, type AuthEnv } from "../lib/env";
import { useRouter } from "../lib/router";
import { createConsoleClient, type ConsoleClient } from "../lib/trpc";
import { LOGIN_PATH } from "../routes";

export type SessionState =
  | { readonly status: "loading" }
  | { readonly status: "unconfigured"; readonly missing: readonly string[] }
  | { readonly status: "anonymous"; readonly reason?: "expired" }
  | { readonly status: "authenticated"; readonly principal: Principal; readonly tokens: TokenSet };

/** `stepUp`: sign in again (BFF `LOGIN_NOT_RECENT`); `enrollTotp`: turn on the optional TOTP. */
export type SecurityPrompt = "stepUp" | "enrollTotp";

export interface AuthServices {
  readonly cognito: CognitoApi;
  readonly srp: SrpClient;
}

export interface SessionValue {
  readonly state: SessionState;
  readonly env: AuthEnv | undefined;
  /** Cognito client and SRP of this build; undefined when the build has no Cognito variables. */
  readonly auth: AuthServices | undefined;
  readonly trpc: ConsoleClient;
  readonly prompt: SecurityPrompt | undefined;
  /** Stores the tokens of a finished sign-in (or step-up) and opens the session. */
  completeSignIn(tokens: TokenSet): void;
  /** Revokes the refresh token, clears the session and goes to the login screen. */
  signOut(): void;
  /** The BFF refused the token: drop it and send the user through the login with a way back. */
  expireSession(): void;
  openPrompt(prompt: SecurityPrompt): void;
  closePrompt(): void;
}

const SessionContext = createContext<SessionValue | undefined>(undefined);

/** Refresh this long before the id token expires so no request goes out with a stale one. */
const REFRESH_LEAD_MS = 60_000;

function authenticated(tokens: TokenSet): SessionState {
  return { status: "authenticated", principal: principalFromIdToken(tokens.idToken), tokens };
}

export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const { navigate } = useRouter();
  const [envResult] = useState(readAuthEnv);
  const env = envResult.ok ? envResult.env : undefined;
  const auth = useMemo<AuthServices | undefined>(
    () => (env ? { cognito: createCognitoApi({ region: env.region, clientId: env.clientId }), srp: createSrpClient(env.userPoolId) } : undefined),
    [env],
  );
  const [state, setState] = useState<SessionState>(() => (envResult.ok ? { status: "loading" } : { status: "unconfigured", missing: envResult.missing }));
  const [prompt, setPrompt] = useState<SecurityPrompt | undefined>(undefined);

  // The client reads the token through a ref so it never rebuilds on refresh.
  const tokensRef = useRef<TokenSet | undefined>(undefined);
  tokensRef.current = state.status === "authenticated" ? state.tokens : undefined;
  const trpc = useMemo(() => createConsoleClient(() => tokensRef.current?.idToken), []);

  useEffect(() => {
    if (!auth) return;
    let cancelled = false;
    void restoreSession(auth.cognito).then((tokens) => {
      if (cancelled) return;
      setState(tokens ? authenticated(tokens) : { status: "anonymous" });
    });
    return () => {
      cancelled = true;
    };
  }, [auth]);

  // Silent refresh ahead of expiry; on failure the user is sent back to login.
  useEffect(() => {
    if (!auth || state.status !== "authenticated") return;
    const { tokens } = state;
    const delay = Math.max(0, tokens.expiresAt - REFRESH_LEAD_MS - Date.now());
    const timer = window.setTimeout(() => {
      if (!tokens.refreshToken) {
        if (isExpired(tokens)) {
          clearTokens();
          setState({ status: "anonymous", reason: "expired" });
        }
        return;
      }
      void refreshTokens(auth.cognito, tokens)
        .then((refreshed) => setState(authenticated(refreshed)))
        .catch(() => {
          clearTokens();
          setState({ status: "anonymous", reason: "expired" });
        });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [auth, state]);

  const completeSignIn = useCallback((tokens: TokenSet) => {
    saveTokens(tokens);
    setState(authenticated(tokens));
  }, []);

  const signOut = useCallback(() => {
    const tokens = tokensRef.current;
    setPrompt(undefined);
    setState({ status: "anonymous" });
    if (auth) void revokeSession(auth.cognito, tokens);
    else clearTokens();
    navigate(LOGIN_PATH, { replace: true });
  }, [auth, navigate]);

  const expireSession = useCallback(() => {
    clearTokens();
    setPrompt(undefined);
    setState({ status: "anonymous", reason: "expired" });
  }, []);

  const closePrompt = useCallback(() => setPrompt(undefined), []);

  const value = useMemo<SessionValue>(
    () => ({ state, env, auth, trpc, prompt, completeSignIn, signOut, expireSession, openPrompt: setPrompt, closePrompt }),
    [state, env, auth, trpc, prompt, completeSignIn, signOut, expireSession, closePrompt],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}

/** Principal of an authenticated session; throws if used outside the guarded area of app.tsx. */
export function usePrincipal(): Principal {
  const { state } = useSession();
  if (state.status !== "authenticated") throw new Error("usePrincipal requires an authenticated session");
  return state.principal;
}
