// One step of the guided tour in the panel: its button, "Saltar a escena" (guest worlds), "Qué mirar"
// with the hours of the world's pending timers, and how long to wait. The buttons wait while the world is
// busy or another step runs; the outcome of the step stays under it.
import { useEffect } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import type { TourPanelCopy } from "./copy";
import { type PendingTimer, type TourLang, type TourStep, type TourTrackId, lookText, sceneOf } from "./steps";
import { type StepRun, useTourStep } from "./use-tour-step";

interface StepCardProps {
  readonly track: TourTrackId;
  readonly step: TourStep;
  readonly parts: number;
  readonly lang: TourLang;
  readonly copy: TourPanelCopy;
  readonly upcoming: readonly PendingTimer[];
  readonly locked: boolean;
  readonly jumpable: boolean;
  readonly onRunning: (stepId: string, running: boolean) => void;
}

function status(run: StepRun, copy: TourPanelCopy, sceneTitle: string | undefined) {
  switch (run.status) {
    case "running":
      return <p className="text-xs text-slate">{run.waiting ? copy.waiting : copy.running(run.part, run.total)}</p>;
    case "paused":
      return <p className="text-xs text-warning">{copy.stillBusy}</p>;
    case "done":
      return <p className="text-xs text-success">{run.jumped && sceneTitle ? copy.jumped(sceneTitle) : copy.done}</p>;
    case "error":
      return (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold text-danger">{copy.failed}</p>
          <ApiErrorNotice error={run.error} />
        </div>
      );
    default:
      return null;
  }
}

export function StepCard({ track, step, parts, lang, copy, upcoming, locked, jumpable, onRunning }: StepCardProps) {
  const { run, start, jump } = useTourStep(track, step, parts);
  const running = run.status === "running";
  const scene = step.sceneId === null ? undefined : sceneOf(step.sceneId);
  const from = run.status === "paused" || run.status === "error" ? run.nextPart : 0;
  const label = from > 0 ? copy.continue(from + 1, parts) : copy.run;
  useEffect(() => onRunning(step.stepId, running), [step.stepId, running, onRunning]);

  return (
    <li className="rounded-card border border-mist bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate">{copy.step(step.stepId)}</p>
      <h3 className="mt-0.5 text-base font-semibold text-navy">{step.title[lang]}</h3>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={locked || running || parts === 0} onClick={() => start(from)}>
          {label}
        </Button>
        {scene && jumpable ? (
          <Button variant="secondary" aria-label={copy.jumpLabel(scene.title[lang])} disabled={locked || running} onClick={jump}>
            {copy.jump}
          </Button>
        ) : null}
      </div>
      <p className="mt-2 text-sm text-ink">{step.action[lang]}</p>
      <dl className="mt-3 space-y-2 text-sm">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{copy.look}</dt>
          <dd className="text-ink">{lookText(step, lang, upcoming)}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{copy.wait}</dt>
          <dd className="text-ink">{step.wait[lang]}</dd>
        </div>
      </dl>
      <div className="mt-2">{status(run, copy, scene?.title[lang])}</div>
    </li>
  );
}
