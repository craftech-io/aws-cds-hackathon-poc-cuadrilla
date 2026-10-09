// Pieces the sections of the demo clock view share: the outcome of the last command (a success sentence,
// the view's own words for a refusal it knows, the generic notice otherwise).
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Callout } from "../../components/Callout";
import { refusalText } from "./clock-model";
import type { ClockCommand } from "./use-clock-command";

export function CommandOutcome({ command }: { readonly command: ClockCommand }) {
  const { state } = command;
  if (state.status === "done") return <Callout tone="success">{state.data}</Callout>;
  if (state.status !== "error") return null;
  const own = refusalText(state.error);
  return own ? <Callout tone="warning">{own}</Callout> : <ApiErrorNotice error={state.error} />;
}
