// The shell's simulated-time bar (docs/design-brief.md §6): "Hora simulada · mar 13/10 09:20 · reloj
// de demo en pausa" with "Avanzar al próximo evento", "+10 min" and "+1 h". While the world is busy
// the controls are disabled and the bar says what it is waiting for ("Transcribiendo nota de voz
// (~15 s)"); after five busy minutes it points to the clock view, where "Avanzar igual" lives.
import { useEffect } from "react";
import { useWorldClock } from "../../context/WorldClockContext";
import { copy } from "../../copy/console";
import { Link } from "../../lib/router";
import { pathOf } from "../../routes";
import { ADVANCE_STEPS, type WorldClock, forceAvailable, formatSimTime, oldestPending } from "../../lib/world-clock";
import { describeApiError } from "../ApiErrorNotice";
import { ClockBanner, type ClockBannerAction, type ClockBannerStatus } from "../ClockBanner";

/** How long the refusal of a control stays on the bar. */
const CONTROL_ERROR_MS = 10_000;

function busyStatus(clock: WorldClock, nowMs: number): ClockBannerStatus {
  const oldest = oldestPending(clock.pending);
  const others = clock.pending.length - 1;
  const force = forceAvailable(clock, nowMs);
  const lines = [others > 0 ? copy.clock.morePending(others) : undefined, force ? copy.clock.forceHint : undefined].filter((line) => line !== undefined);
  return {
    tone: "busy",
    text: oldest ? copy.clock.busy[oldest.kind] : copy.clock.busyFallback,
    ...(lines.length > 0
      ? {
          detail: (
            <>
              {lines.join(" · ")}
              {force ? (
                <>
                  {" "}
                  <Link to={pathOf("clock")} className="font-semibold text-cyan-deep underline">
                    {copy.clock.openClock}
                  </Link>
                </>
              ) : null}
            </>
          ),
        }
      : {}),
  };
}

export function WorldClockBar() {
  const { state, clock, control, run, dismissControl } = useWorldClock();
  const running = control.status === "running";
  const failed = control.status === "error";

  useEffect(() => {
    if (!failed) return;
    const timer = window.setTimeout(dismissControl, CONTROL_ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [failed, dismissControl]);
  const locked = !clock || clock.busy || running;

  let status: ClockBannerStatus | undefined;
  if (control.status === "error") status = { tone: control.error.kind === "precondition" ? "warning" : "error", text: describeApiError(control.error) };
  else if (clock?.busy) status = busyStatus(clock, Date.now());
  // Without any answer yet the placeholder already says it; with an old one, the bar keeps it and warns.
  else if (state.status === "error" && clock) status = { tone: "warning", text: copy.clock.unavailable };

  const actions: ClockBannerAction[] = [
    { id: "next", label: copy.clock.advanceToNext, onClick: () => run({ kind: "next" }), disabled: locked },
    ...ADVANCE_STEPS.map((minutes) => ({ id: `advance-${minutes}`, label: copy.clock.advance[minutes], onClick: () => run({ kind: "advance", minutes }), disabled: locked })),
  ];

  return (
    <ClockBanner
      label={copy.clock.label}
      {...(clock ? { time: formatSimTime(clock.simNow, copy.clock.weekdays), mode: clock.mode === "RUNNING" ? copy.clock.running : copy.clock.paused, live: clock.mode === "RUNNING" } : {})}
      placeholder={state.status === "loading" ? copy.clock.loading : copy.clock.unavailable}
      {...(status ? { status } : {})}
      actions={actions}
      actionsLabel={copy.clock.controls}
    />
  );
}
