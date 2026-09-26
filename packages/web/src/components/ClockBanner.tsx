// The simulated time of a world in one line ("Hora simulada · mar 13/10 09:20 · reloj de demo en
// pausa"), what the world is waiting for, and the controls that move the clock. Generic: every text
// arrives by props, so the shell's bar and the clock view draw the same component with their own
// controls. The status line is a polite live region: a screen reader hears when the world becomes
// busy and when it is quiet again.
import type { ReactNode } from "react";
import { Button } from "./Button";

export interface ClockBannerAction {
  readonly id: string;
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}

export type ClockBannerStatusTone = "busy" | "warning" | "error";

export interface ClockBannerStatus {
  readonly tone: ClockBannerStatusTone;
  readonly text: string;
  /** Under the text: a link to the full controls, how many other things are pending. */
  readonly detail?: ReactNode;
}

interface ClockBannerProps {
  /** "Hora simulada": also the accessible name of the region. */
  readonly label: string;
  /** "mar 13/10 09:20"; absent while the first answer is on its way. */
  readonly time?: string;
  /** "reloj de demo en pausa" / "reloj en vivo". */
  readonly mode?: string;
  /** A clock running in real time pulses. */
  readonly live?: boolean;
  /** Shown instead of the time while there is none ("Cargando…"). */
  readonly placeholder?: string;
  readonly status?: ClockBannerStatus;
  readonly actions?: readonly ClockBannerAction[];
  /** Accessible name of the group of controls. */
  readonly actionsLabel?: string;
}

const STATUS_TONE: Readonly<Record<ClockBannerStatusTone, string>> = {
  busy: "text-info",
  warning: "text-warning",
  error: "text-danger",
};

export function ClockBanner({ label, time, mode, live = false, placeholder, status, actions = [], actionsLabel }: ClockBannerProps) {
  return (
    <section aria-label={label} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-mist bg-cyan-soft/40 px-6 py-2">
      <div className="min-w-0">
        {/* The spaces between the parts are real text, so the line reads as a sentence to anyone. */}
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink">
          <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${live ? "animate-pulse bg-success" : "bg-slate"}`} />
          <span className="font-semibold text-navy">{label}</span>
          {time ? (
            <>
              {" "}
              <span aria-hidden="true">·</span> <span className="font-mono tabular-nums">{time}</span>
              {mode ? (
                <>
                  {" "}
                  <span aria-hidden="true">·</span> <span className="text-slate">{mode}</span>
                </>
              ) : null}
            </>
          ) : placeholder ? (
            <>
              {" "}
              <span className="text-slate">{placeholder}</span>
            </>
          ) : null}
        </p>
        <div role="status" aria-live="polite" className="text-xs">
          {status ? (
            <>
              <p className={`font-medium ${STATUS_TONE[status.tone]}`}>{status.text}</p>
              {status.detail ? <div className="text-slate">{status.detail}</div> : null}
            </>
          ) : null}
        </div>
      </div>
      {actions.length > 0 ? (
        <div role="group" aria-label={actionsLabel ?? label} className="flex flex-wrap items-center gap-2">
          {actions.map((action) => (
            <Button key={action.id} variant="secondary" onClick={action.onClick} disabled={action.disabled}>
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
