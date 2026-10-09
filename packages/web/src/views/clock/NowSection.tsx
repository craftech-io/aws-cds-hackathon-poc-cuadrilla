// "Ahora en este mundo" and "Mover el reloj" (FL-084, FL-085): the simulated time and mode, what a busy
// world waits for (with "Avanzar igual" once it waited five minutes), and the moves: "Iniciar el día",
// "Avanzar al próximo evento", "+10 min", "+1 h" and the live clock for 30 minutes. Every move is closed
// while the world is busy; a refusal (`WORLD_BUSY`) says why.
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { Section } from "../../components/Section";
import { useSession } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { copy as consoleCopy } from "../../copy/console";
import { ADVANCE_STEPS, forceAvailable, formatSimTime } from "../../lib/world-clock";
import { extrasOf, pendingText, realTime } from "./clock-model";
import { clockCopy as copy } from "./copy";
import { CommandOutcome } from "./parts";
import { useClockCommand } from "./use-clock-command";

const timeOf = (iso: string) => formatSimTime(iso, consoleCopy.clock.weekdays);

export function NowSection() {
  const { trpc } = useSession();
  const { clock } = useWorldClock();
  const command = useClockCommand();
  const now = Date.now();
  const extras = extrasOf(clock);
  const busy = clock?.busy === true;
  const locked = clock === undefined || busy || command.running;
  const force = forceAvailable(clock, now);
  const running = clock?.mode === "RUNNING";
  const moved = (result: { readonly simNow: string; readonly fired: readonly unknown[] }) => copy.move.moved(timeOf(result.simNow), result.fired.length);

  return (
    <>
      <Section id="clock-now" title={copy.now.title}>
        {clock === undefined ? (
          <p className="text-sm text-slate">{copy.now.loading}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{copy.now.time}</dt>
                <dd className="text-2xl font-semibold tabular-nums text-navy">{timeOf(clock.simNow)}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{copy.now.mode}</dt>
                <dd className="text-ink">{running ? (extras.runningUntilReal ? copy.now.running(realTime(extras.runningUntilReal)) : copy.now.runningUndated) : copy.now.paused}</dd>
              </div>
              {extras.worldEpoch !== undefined ? (
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{copy.now.epoch}</dt>
                  <dd className="text-ink tabular-nums">{extras.worldEpoch}</dd>
                </div>
              ) : null}
            </dl>
            {busy ? (
              <Callout tone="warning" title={copy.now.busyTitle}>
                <p>{copy.now.busyLead}</p>
                <ul className="mt-1 list-disc pl-5">
                  {clock.pending.map((item) => (
                    <li key={`${item.kind}:${item.sinceReal}:${item.detail ?? ""}`}>{pendingText(item, now)}</li>
                  ))}
                </ul>
                {force ? <p className="mt-2 font-semibold">{copy.now.forceLead}</p> : null}
              </Callout>
            ) : (
              <p className="text-sm text-success">{copy.now.quiet}</p>
            )}
          </div>
        )}
      </Section>
      <Section id="clock-move" title={copy.move.title} description={copy.move.description}>
        <div className="flex flex-col gap-4">
          <div role="group" aria-label={copy.move.title} className="flex flex-wrap gap-2">
            <Button disabled={locked} onClick={() => command.run(() => trpc.clock.startDay.mutate(undefined), moved)}>
              {copy.move.startDay}
            </Button>
            <Button variant="secondary" disabled={locked} onClick={() => command.run(() => trpc.clock.advanceToNext.mutate(undefined), moved)}>
              {copy.move.next}
            </Button>
            {ADVANCE_STEPS.map((minutes) => (
              <Button key={minutes} variant="secondary" disabled={locked} onClick={() => command.run(() => trpc.clock.advance.mutate({ minutes }), moved)}>
                {copy.move.advance[minutes]}
              </Button>
            ))}
            <Button
              variant="ghost"
              disabled={clock === undefined || command.running}
              onClick={() => command.run(() => trpc.clock.setRunning.mutate({ running: !running }), () => (running ? copy.move.liveOff : copy.move.liveOn))}
            >
              {running ? copy.move.pause : copy.move.live}
            </Button>
          </div>
          {force ? (
            <div>
              <Button variant="danger" disabled={command.running} onClick={() => command.run(() => trpc.clock.advanceToNext.mutate({ force: true }), moved)}>
                {copy.move.force}
              </Button>
            </div>
          ) : null}
          <CommandOutcome command={command} />
        </div>
      </Section>
    </>
  );
}
