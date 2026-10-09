// "Validar manualmente" of a photo item (FL-044, ADR-0011): a supervisor or a guest writes the reason and
// confirms; the item becomes `OVERRIDDEN` with who, why and when, and the agent tells the installer what
// is left. The BFF wants a sign-in of the last 15 minutes: when the session's is older, the password
// prompt of the console (SecurityPrompts, `stepUp`) opens first, in place, and the reason stays typed;
// a refusal for the same cause opens it too. Used by the evidence review and the detail of an order.
import { useEffect, useId, useState } from "react";
import { ApiErrorNotice, describeApiError } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { Drawer } from "../../components/Drawer";
import { ERROR_CLASS, FIELD_CLASS, HINT_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { useSession } from "../../context/SessionContext";
import type { ApiError } from "../../lib/api-error";
import { useAction } from "../../lib/use-remote";
import { useConsoleApi } from "../orders/use-field-data";
import { evidenceCopy } from "./copy";
import { EVIDENCE_PROCEDURES, OverrideResult, REASON_MAX, needsFreshSignIn, reasonProblem } from "./evidence-model";

const copy = evidenceCopy.manual;

interface ManualValidationProps {
  readonly workOrderId: string;
  readonly workOrderNumber: string;
  /** Photo item code (`ONU_LABEL_PHOTO`) and its label. */
  readonly item: string;
  readonly itemLabel: string;
  /**
   * After a validation went through, with the sentence that says so: the item leaves the states this
   * control is offered in, so whoever shows the item keeps the notice and reloads.
   */
  readonly onValidated: (notice: string) => void;
}

function refusalText(error: ApiError): string {
  return (error.reason !== null ? copy.byReason[error.reason] : undefined) ?? describeApiError(error);
}

export function ManualValidation({ workOrderId, workOrderNumber, item, itemLabel, onValidated }: ManualValidationProps) {
  const { state, openPrompt } = useSession();
  const api = useConsoleApi();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const idToken = state.status === "authenticated" ? state.tokens.idToken : undefined;
  const action = useAction((input: { readonly reason: string }) => api.mutation(EVIDENCE_PROCEDURES.override, { workOrderId, item, reason: input.reason }, OverrideResult));
  const problem = reasonProblem(reason);
  const stale = needsFreshSignIn(idToken, Date.now());

  const start = () => {
    action.reset();
    setOpen(true);
    if (needsFreshSignIn(idToken, Date.now())) openPrompt("stepUp");
  };
  const close = () => setOpen(false);
  const submit = async () => {
    setTouched(true);
    if (problem !== null) return;
    if (needsFreshSignIn(idToken, Date.now())) {
      openPrompt("stepUp");
      return;
    }
    const result = await action.run({ reason: reason.trim() });
    if (result === undefined) return;
    setOpen(false);
    setReason("");
    setTouched(false);
    onValidated(copy.done(itemLabel));
  };
  const failure = action.state.status === "error" ? action.state.error : undefined;
  // The BFF refused an old sign-in: the password prompt is what fixes it.
  const refusedForAge = failure?.kind === "recentLogin";
  useEffect(() => {
    if (refusedForAge) openPrompt("stepUp");
  }, [refusedForAge, openPrompt]);

  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="secondary" onClick={start}>
        {copy.open}
      </Button>
      <Drawer open={open} title={copy.title(itemLabel, workOrderNumber)} onClose={close} closeLabel={copy.close}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="text-sm text-slate">{copy.lead}</p>
          {stale ? (
            <Callout tone="warning" title={copy.passwordFirst} action={<Button variant="secondary" onClick={() => openPrompt("stepUp")}>{copy.confirmPassword}</Button>} />
          ) : null}
          <label htmlFor={fieldId} className={LABEL_CLASS}>
            {copy.reason}
            <textarea
              id={fieldId}
              className={`${FIELD_CLASS} min-h-28`}
              value={reason}
              maxLength={REASON_MAX + 50}
              aria-invalid={touched && problem !== null ? true : undefined}
              onChange={(event) => setReason(event.target.value)}
              onBlur={() => setTouched(true)}
            />
            <span className={HINT_CLASS}>{copy.reasonHint}</span>
            {touched && problem !== null ? <span className={ERROR_CLASS}>{problem === "short" ? copy.tooShort : copy.tooLong}</span> : null}
          </label>
          {failure ? (
            failure.kind === "recentLogin" || failure.kind === "unauthorized" || failure.kind === "forbidden" || failure.kind === "network" || failure.kind === "unavailable" ? (
              <ApiErrorNotice error={failure} />
            ) : (
              <Callout tone="warning">{refusalText(failure)}</Callout>
            )
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={action.state.status === "running"}>
              {action.state.status === "running" ? copy.sending : copy.submit}
            </Button>
            <Button variant="ghost" onClick={close}>
              {copy.cancel}
            </Button>
          </div>
        </form>
      </Drawer>
    </div>
  );
}
