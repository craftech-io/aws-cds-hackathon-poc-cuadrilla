// "Saltar a escena" and "Reiniciar este mundo" (FL-084, FL-086). A scene loads the guest world in the seeded
// state just before a step of the guided tour (titles from views/tour/steps.ts); it has its own limit per
// real hour and never counts for the reset's. The reset reloads this world from its template, once every
// 10 real minutes, after a confirmation. Both are for supervisors and guests.
import { useState } from "react";
import { Button } from "../../components/Button";
import { Section } from "../../components/Section";
import { useSession } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { TOUR_SCENES } from "../tour/steps";
import { DEFAULT_SCENE_JUMPS, extrasOf, realTime, resetAvailable } from "./clock-model";
import { clockCopy as copy } from "./copy";
import { CommandOutcome } from "./parts";
import { useClockCommand } from "./use-clock-command";

export function ScenesSection() {
  const { trpc } = useSession();
  const { clock } = useWorldClock();
  const command = useClockCommand();
  const limit = extrasOf(clock).sceneJumpsPerRealHour ?? DEFAULT_SCENE_JUMPS;
  return (
    <Section id="clock-scenes" title={copy.scenes.title} description={copy.scenes.description(limit)}>
      <div className="flex flex-col gap-3">
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {TOUR_SCENES.map((scene) => (
            <li key={scene.sceneId} className="flex items-center justify-between gap-3 rounded-md border border-mist px-3 py-2">
              <span className="text-sm text-ink">{scene.title.es}</span>
              <Button
                variant="secondary"
                aria-label={`${copy.scenes.jump}: ${scene.title.es}`}
                disabled={clock === undefined || command.running}
                onClick={() => command.run(() => trpc.clock.jumpToScene.mutate({ sceneId: scene.sceneId }), () => copy.scenes.jumped(scene.title.es))}
              >
                {copy.scenes.jump}
              </Button>
            </li>
          ))}
        </ul>
        <CommandOutcome command={command} />
      </div>
    </Section>
  );
}

export function ResetSection() {
  const { trpc } = useSession();
  const { clock } = useWorldClock();
  const command = useClockCommand();
  const [confirming, setConfirming] = useState(false);
  const extras = extrasOf(clock);
  const available = resetAvailable(extras, Date.now());
  return (
    <Section id="clock-reset" title={copy.reset.title} description={copy.reset.description}>
      <div className="flex flex-col gap-3">
        {confirming ? (
          <div role="group" aria-label={copy.reset.title} className="flex flex-wrap items-center gap-3 rounded-md border border-warning bg-warning-soft px-4 py-3">
            <p className="text-sm font-semibold text-warning">{copy.reset.confirmLead}</p>
            <Button
              variant="danger"
              disabled={command.running}
              onClick={() => {
                setConfirming(false);
                command.run(() => trpc.clock.reset.mutate(), () => copy.reset.done);
              }}
            >
              {copy.reset.confirm}
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {copy.reset.cancel}
            </Button>
          </div>
        ) : (
          <div>
            <Button variant="danger" disabled={clock === undefined || !available || command.running} onClick={() => setConfirming(true)}>
              {copy.reset.open}
            </Button>
          </div>
        )}
        {!available && extras.nextResetAtReal ? <p className="text-sm text-slate">{copy.reset.nextAt(realTime(extras.nextResetAtReal))}</p> : null}
        <CommandOutcome command={command} />
      </div>
    </Section>
  );
}
