// "Borrar mi cuenta" of a guest of the own sign-up (ADR-0025 §6, ADR-0026): the person confirms with its
// password, which signs it in again in place (SRP, the same step-up as the manual validation), so the
// deletion runs with a sign-in of seconds ago (`account.deleteGuest` needs one of at most 15 minutes).
// The call carries the fresh token and no input at all; the BFF deletes only the principal's own
// account. Then the session is revoked and closed. The password never leaves the SRP exchange.
import { type FormEvent, useId, useState } from "react";
import { Button } from "../../components/Button";
import { Drawer } from "../../components/Drawer";
import { ERROR_CLASS, FIELD_CLASS, HINT_CLASS } from "../../components/form-classes";
import { useSession } from "../../context/SessionContext";
import { flowDeps } from "../../lib/auth/deps";
import { INITIAL_STATE, advance } from "../../lib/auth/flow";
import { consoleApiOf } from "../../lib/console-api";
import { createConsoleClient } from "../../lib/trpc";
import type { GuestHomeCopy } from "./copy";
import { AccountDeleted, GUEST_PROCEDURES } from "./guest-home-model";

type Phase = { readonly kind: "idle" } | { readonly kind: "working" } | { readonly kind: "error"; readonly message: string };

export function DeleteAccount({ copy }: { readonly copy: GuestHomeCopy }) {
  const { auth, state, completeSignIn, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const passwordId = useId();
  const principal = state.status === "authenticated" ? state.principal : undefined;
  const previous = state.status === "authenticated" ? state.tokens : undefined;
  const text = copy.deletion;

  const close = () => {
    setOpen(false);
    setPassword("");
    setPhase({ kind: "idle" });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (auth === undefined || principal?.email === undefined || phase.kind === "working") return;
    setPhase({ kind: "working" });
    const deps = flowDeps(auth.cognito, auth.srp, { kind: "stepUp", sub: principal.sub, email: principal.email });
    const step = await advance(INITIAL_STATE, { type: "signIn", email: principal.email, password }, deps);
    setPassword("");
    if (step.state.step !== "done") {
      setPhase({ kind: "error", message: step.error === "INVALID_CREDENTIALS" ? text.wrongPassword : text.failed });
      return;
    }
    const fresh = step.state.tokens;
    if (previous?.refreshToken) void auth.cognito.revoke(previous.refreshToken).catch(() => undefined);
    completeSignIn(fresh);
    try {
      await consoleApiOf(createConsoleClient(() => fresh.idToken)).mutation(GUEST_PROCEDURES.deleteAccount, undefined, AccountDeleted);
    } catch {
      setPhase({ kind: "error", message: text.failed });
      return;
    }
    signOut();
  };

  return (
    <>
      <button type="button" className="min-h-11 text-sm font-semibold text-danger underline underline-offset-2" onClick={() => setOpen(true)}>
        {text.open}
      </button>
      <Drawer open={open} title={text.title} onClose={close} closeLabel={text.cancel}>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <p className="rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm text-ink">{text.warning}</p>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={passwordId} className="text-sm font-medium text-ink">
              {text.password}
            </label>
            <input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              className={`${FIELD_CLASS} w-full py-2.5`}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-describedby={`${passwordId}-hint`}
              required
            />
            <p id={`${passwordId}-hint`} className={HINT_CLASS}>
              {text.passwordHint}
            </p>
          </div>
          {phase.kind === "error" ? (
            <p role="alert" className={ERROR_CLASS}>
              {phase.message}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" variant="danger" disabled={password.length === 0 || phase.kind === "working"}>
              {phase.kind === "working" ? text.working : text.confirm}
            </Button>
            <Button variant="secondary" onClick={close}>
              {text.cancel}
            </Button>
          </div>
        </form>
      </Drawer>
    </>
  );
}
