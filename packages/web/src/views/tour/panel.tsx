// The "Recorrido guiado" panel of the shell (docs/design-brief.md §6 and §15; FL-084): the express (~5 min)
// and the full (~15 min) tour, in Spanish or English, each step with its button, "Saltar a escena", what
// to look at (hours from the world's pending timers, `tour.steps`) and how long to wait. The texts come
// from steps.ts, the single source the README and SC-18 follow too; the buttons run the BFF's parts.
// While the world is busy, or a step is running, the other buttons wait.
import { useCallback, useState } from "react";
import { FilterPills } from "../../components/FilterPills";
import { RemoteBlock } from "../../components/RemoteBlock";
import { usePrincipal, useSession } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { useRemote } from "../../lib/use-remote";
import { isGuestWorld } from "../clock/clock-model";
import { tourCopy } from "./copy";
import { StepCard } from "./StepCard";
import { TOUR_STEPS, TOUR_TRACKS, TOUR_TRACK_IDS, type TourLang, type TourTrackId } from "./steps";
import { canJump, initialLang } from "./tour-model";

export default function TourPanel() {
  const { trpc } = useSession();
  const { role, ispId } = usePrincipal();
  const { clock, tick } = useWorldClock();
  const [lang, setLang] = useState<TourLang>(() => initialLang(typeof navigator === "undefined" ? undefined : navigator.language));
  const [track, setTrack] = useState<TourTrackId>("EXPRESS");
  const [runningStep, setRunningStep] = useState<string | undefined>(undefined);
  const copy = tourCopy[lang];
  const steps = useRemote(`tour.steps:${track}:${tick}`, (signal) => trpc.tour.steps.query({ track }, { signal }));
  const jumpable = canJump(role, isGuestWorld(ispId));
  const busy = clock?.busy === true;
  const onRunning = useCallback((stepId: string, running: boolean) => setRunningStep((current) => (running ? stepId : current === stepId ? undefined : current)), []);

  return (
    <div lang={copy.htmlLang} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FilterPills
          label={copy.tracks}
          value={track}
          onChange={setTrack}
          options={TOUR_TRACK_IDS.map((id) => ({ value: id, label: copy.track(TOUR_TRACKS[id].title[lang], TOUR_TRACKS[id].minutes) }))}
        />
        <button type="button" aria-label={copy.language} className="rounded-md px-2 py-1 text-sm font-semibold text-cyan-deep underline" onClick={() => setLang(lang === "es" ? "en" : "es")}>
          {copy.otherLanguage}
        </button>
      </div>
      <p className="text-sm text-slate">{copy.intro}</p>
      {busy ? <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">{copy.busy}</p> : null}
      {jumpable ? null : <p className="text-xs text-slate">{copy.scenesOnlyGuest}</p>}
      <RemoteBlock state={steps.state} onRetry={steps.reload}>
        {(data) => (
          <ol className="flex flex-col gap-3">
            {TOUR_STEPS[track].map((step) => (
              <StepCard
                key={`${track}:${step.stepId}`}
                track={track}
                step={step}
                parts={data.steps.find((candidate) => candidate.stepId === step.stepId)?.parts.length ?? 0}
                lang={lang}
                copy={copy}
                upcoming={data.upcoming}
                locked={busy || (runningStep !== undefined && runningStep !== step.stepId)}
                jumpable={jumpable}
                onRunning={onRunning}
              />
            ))}
          </ol>
        )}
      </RemoteBlock>
    </div>
  );
}
