// The guest's portada (`/app/home`, docs/landing-spec.md §7.6, ADR-0025 §2): where every guest lands
// after signing in, the only place that tells the state of its world. It shows the four states, what
// was seeded once the world is ready, when a sign-up world expires, which parts of the console already
// work and which arrive in stages (from the view registry, without dates), and, for a guest of the own
// sign-up only, "Borrar mi cuenta". Nothing that does not work yet is offered.
import { useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { LoadingBlock } from "../../components/RemoteBlock";
import { copy as consoleCopy } from "../../copy/console";
import { useRouter } from "../../lib/router";
import type { ViewProps } from "../../lib/view-registry";
import { VIEWS } from "../../lib/view-registry";
import { ROUTES } from "../../routes";
import { type GuestHomeCopy, guestHomeCopy } from "./copy";
import { DeleteAccount } from "./DeleteAccount";
import { type Stages, langOf, stagesOf } from "./guest-home-model";
import { useGuestWorld } from "./use-guest-world";
import { WorldPanel } from "./WorldPanel";

/** The directory of this view, which the route table names `guest-home`. */
const HOME_VIEW = "guest-home";

const consoleTitles: Readonly<Record<string, { readonly title: string }>> = consoleCopy.views;

function StagesBlock({ stages, copy }: { readonly stages: Stages; readonly copy: GuestHomeCopy }) {
  return (
    <section aria-labelledby="guest-stages-title" className="rounded-card border border-mist bg-white p-6 shadow-card">
      <h2 id="guest-stages-title" className="text-lg font-semibold text-navy">
        {copy.stages.title}
      </h2>
      <h3 className="mt-3 text-sm font-semibold text-ink">{copy.stages.available}</h3>
      {stages.available.length === 0 ? (
        <p className="mt-1 text-sm text-slate">{copy.stages.availableNone}</p>
      ) : (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink">
          {stages.available.map((part) => (
            <li key={part.id}>{part.title}</li>
          ))}
        </ul>
      )}
      {stages.pending.length === 0 ? null : (
        <>
          <h3 className="mt-4 text-sm font-semibold text-ink">{copy.stages.pending}</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate">
            {stages.pending.map((part) => (
              <li key={part.id}>{part.title}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function retryNoticeOf(retry: ReturnType<typeof useGuestWorld>["retry"], copy: GuestHomeCopy): string | undefined {
  if (retry.status !== "error") return undefined;
  return retry.error.reason === "RETRY_TOO_SOON" ? copy.retryTooSoon : copy.retryFailed;
}

export default function GuestHomeView(_props: ViewProps) {
  const { search } = useRouter();
  const [lang] = useState(() => langOf(search, document.documentElement.lang));
  const copy = guestHomeCopy[lang];
  const { state, longWait, retry, runRetry } = useGuestWorld();
  const titleOf = (id: string) => (lang === "en" ? copy.parts[id] : undefined) ?? consoleTitles[id]?.title ?? id;
  const stages = stagesOf(ROUTES, VIEWS.names, titleOf, HOME_VIEW);
  const world = state.status === "loading" ? undefined : state.world;

  return (
    <div lang={copy.htmlLang} className="mx-auto flex max-w-4xl flex-col gap-6">
      <h1 className="font-display text-2xl font-semibold text-navy">{copy.heading}</h1>
      {state.status === "error" ? <ApiErrorNotice error={state.error} /> : null}
      {world === undefined ? (
        state.status === "loading" ? <LoadingBlock label={copy.provisioning.working} /> : null
      ) : (
        <WorldPanel world={world} copy={copy} longWait={longWait} retrying={retry.status === "running"} retryNotice={retryNoticeOf(retry, copy)} onRetry={runRetry} />
      )}
      {world?.status === "READY" ? <StagesBlock stages={stages} copy={copy} /> : null}
      {world?.canDeleteAccount === true ? (
        <div className="flex justify-end">
          <DeleteAccount copy={copy} />
        </div>
      ) : null}
    </div>
  );
}
