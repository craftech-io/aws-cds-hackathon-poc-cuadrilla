// Simulador de teléfono (`/app/simulator`, docs/design-brief.md §6; FL-082, FL-083, FL-101): WhatsApp as
// each person of the user's world sees it, while the world talks over the simulated channel. Choose who
// the phone is (an installer, a supervisor or a number the world does not know), write, tap buttons,
// send photos and voice notes, or send the tour's quick messages; every action enters Cuadrilla by the
// same signed envelope a real WhatsApp event has. The limits that apply are on screen before they bite,
// and a refusal says which one and when it frees. With the live transport in the stage, "Probar con mi
// WhatsApp" and the guest's kit appear below.
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Callout } from "../../components/Callout";
import { PageHeader } from "../../components/PageHeader";
import { LoadingBlock, RemoteBlock } from "../../components/RemoteBlock";
import { SelectField } from "../../components/SelectField";
import { copy as consoleCopy } from "../../copy/console";
import type { ApiError } from "../../lib/api-error";
import { dataOf } from "../../lib/use-remote";
import type { ViewProps } from "../../lib/view-registry";
import { simulatorCopy } from "./copy";
import { LivePanel } from "./LivePanel";
import { Phone } from "./Phone";
import { QuickMessages } from "./QuickMessages";
import { type SimIdentities, type SimIdentity, UNKNOWN_IDENTITY } from "./simulator-api";
import { capNoticeOf, localTime, nameOf, simulatorErrorText } from "./simulator-model";
import { type SimulatorState, useSimulator } from "./use-simulator";

const copy = simulatorCopy;

function optionLabel(identity: SimIdentity): string {
  if (identity.identity === UNKNOWN_IDENTITY || identity.role === null) return copy.identity.unknown;
  return copy.identity.option(nameOf(identity), copy.identity.roles[identity.role], identity.active);
}

function Outcome({ error, done }: { readonly error: ApiError | undefined; readonly done: boolean }) {
  if (error !== undefined) {
    const cap = capNoticeOf(error);
    if (cap !== undefined) {
      return (
        <Callout tone="warning" title={cap.text}>
          {cap.untilIso === undefined ? null : copy.caps.until(localTime(cap.untilIso))}
        </Callout>
      );
    }
    const known = simulatorErrorText(error);
    return known === undefined ? <ApiErrorNotice error={error} /> : <Callout tone="danger" title={known} />;
  }
  return done ? <Callout tone="success" title={copy.done} /> : null;
}

function CapsNotice({ perHour }: { readonly perHour: number }) {
  return (
    <Callout tone="neutral" title={copy.caps.title}>
      <p>{copy.caps.perHour(perHour)}</p>
      <p className="mt-1">{copy.caps.shared}</p>
    </Callout>
  );
}

function Simulator({ sim, data }: { readonly sim: SimulatorState; readonly data: SimIdentities }) {
  const { identity, action } = sim;
  const thread = sim.thread.status === "loading" ? undefined : sim.thread.thread;
  const busy = action.state.status === "running";
  const current = data.identities.find((item) => item.identity === identity);
  const owner = current === undefined || current.identity === UNKNOWN_IDENTITY ? copy.identity.unknownPhone : copy.identity.phoneOf(nameOf(current));
  const options = data.identities.map((item) => ({ value: item.identity, label: optionLabel(item) }));
  const error = action.state.status === "error" ? action.state.error : undefined;
  const catalog = dataOf(sim.catalog.state);
  const quick = dataOf(sim.quick.state) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          {identity === undefined ? null : <SelectField label={copy.identity.label} value={identity} options={options} onChange={(next) => sim.choose(next)} />}
          {sim.thread.status === "error" ? <ApiErrorNotice error={sim.thread.error} /> : null}
          {identity === undefined ? null : sim.thread.status === "loading" ? (
            <LoadingBlock />
          ) : (
            <Phone identity={identity} owner={owner} thread={thread} typing={sim.typing} busy={busy} catalog={catalog} act={sim.act} />
          )}
          <div aria-live="polite">
            <Outcome error={error} done={action.state.status === "done"} />
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <CapsNotice perHour={data.messagesPerRealHourPerIdentity} />
          {sim.quick.state.status === "error" ? <ApiErrorNotice error={sim.quick.state.error} onRetry={sim.quick.reload} /> : null}
          <QuickMessages
            messages={quick}
            identities={data.identities}
            busy={busy}
            onSend={(message, request) => {
              sim.choose(message.identity);
              void sim.act(request);
            }}
          />
        </div>
      </div>
      {data.liveTransport ? <LivePanel api={sim.api} identities={data.identities} /> : null}
    </div>
  );
}

export default function SimulatorView(_props: ViewProps) {
  const sim = useSimulator();
  const view = consoleCopy.views.simulator;
  return (
    <div>
      <PageHeader title={view.title} description={view.description} />
      <p className="mb-4 max-w-3xl text-sm text-slate">{copy.lead}</p>
      <RemoteBlock state={sim.identities.state} onRetry={sim.identities.reload}>
        {(data) => (data.simulated ? <Simulator sim={sim} data={data} /> : <Callout tone="warning" title={copy.liveWorld} />)}
      </RemoteBlock>
    </div>
  );
}
