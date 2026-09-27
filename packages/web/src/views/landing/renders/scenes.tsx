// The six scenes of the walkthrough (docs/landing-spec.md §1.6) as the phones and console crops of the
// main story, and the manifest's scene renders built from the same pieces. A scene's visual plays its
// phones in order while the scene is active; `still` shows the final state (reduced motion, gallery).
// The scroll sets a floor under that play, so no scene waits on how long the visitor stays: pinned
// (≥ 1024 px), `reveal` follows the visitor through the scene's block and splits over its phones in
// order; stacked, each phone follows its own way into the viewport (`scrollReveal`).
import { type ReactNode, useEffect, useState } from "react";
import { ChecklistInset, EvidenceInset, OutboxInset } from "./console-crops";
import { revealFloors } from "../motion";
import { PhoneFrame, type PhoneSize } from "./PhoneFrame";
import { type PhoneMessage, type PhoneOwner, certificateOutbox, phoneMessages, safetyOutbox } from "./sources";

export interface RenderProps {
  /** The visual is on screen and may play. */
  readonly run: boolean;
  /** Final state at once: reduced motion, posters, the gallery and the checks. */
  readonly still: boolean;
  readonly reduced: boolean;
}

export interface SceneVisualProps extends RenderProps {
  readonly desktop: boolean;
  /** How far the visitor has scrolled through the scene, 0 to 1 (desktop only). */
  readonly progress: number;
  /** Share of the scene's messages on screen whatever the clock says, 0 to 1 (desktop only). */
  readonly reveal: number;
  readonly runKey: number;
}

/** Floors of a scene's phones, in order: from `reveal` pinned, from each phone's own scroll stacked. */
function floorsFor(props: SceneVisualProps, phones: readonly (readonly PhoneMessage[])[]): number[] {
  return props.desktop ? revealFloors(phones.map((messages) => messages.length), props.reveal) : phones.map(() => 0);
}

const PHONES = {
  s1: phoneMessages("inst-rogelio", ["s1-voice-note", "s1-diagnosis-reply", "s1-connector-cleaned", "s1-onu-online-reply"]),
  s2: phoneMessages("inst-rogelio", ["s2-policy-question", "s2-policy-reply", "s2-uncovered-question", "s2-uncovered-reply"]),
  s3Reject: phoneMessages("inst-rogelio", ["s3-meter-photo", "s3-label-glare-photo", "s3-glare-reason"]),
  s3Pass: phoneMessages("inst-rogelio", ["s3-meter-photo", "s3-label-glare-photo", "s3-glare-reason", "s3-label-photo"]),
  s4: phoneMessages("inst-rogelio", ["s3-close-offer", "s4-close-tap", "s4-certificate"]),
  s5Adriana: phoneMessages("sup-adriana", ["s5-case-escalated"]),
  s5Hector: phoneMessages("sup-hector", ["s5-case-reassigned", "s5-take-case", "s5-case-brief", "s5-hector-instruction"]),
  s5Rogelio: phoneMessages("inst-rogelio", ["s5-case-opened", "s5-case-taken", "s5-hector-relay"]),
  s6Rogelio: phoneMessages("inst-rogelio", ["s6-hazard", "s6-safety-instruction", "s6-safety-case-opened"]),
  s6Adriana: phoneMessages("sup-adriana", ["s6-safety-alert"]),
} satisfies Record<string, readonly PhoneMessage[]>;

const CERTIFICATE_OUTBOX = certificateOutbox();
const SAFETY_OUTBOX = safetyOutbox();

interface PhoneProps extends RenderProps {
  readonly owner: PhoneOwner;
  readonly messages: readonly PhoneMessage[];
  readonly size?: PhoneSize;
  readonly runKey?: number;
  readonly onDone?: () => void;
  readonly floor?: number;
  readonly scrollReveal?: boolean;
}

function Phone({ owner, messages, run, still, reduced, size, runKey, onDone, floor, scrollReveal }: PhoneProps) {
  return <PhoneFrame owner={owner} messages={messages} run={run} still={still} reduced={reduced} size={size} runKey={runKey} onDone={onDone} floor={floor} scrollReveal={scrollReveal} />;
}

/** What every phone of a scene visual takes from it. */
function playing({ run, still, reduced, runKey, desktop }: SceneVisualProps) {
  return { run, still, reduced, runKey, scrollReveal: !desktop };
}

/** Content that fades in (M5-like, opacity and translate only) once `shown` holds. */
function Appear({ shown, children, className = "" }: { readonly shown: boolean; readonly children: ReactNode; readonly className?: string }) {
  return (
    <div aria-hidden={shown ? undefined : true} className={`transition duration-300 ease-out motion-reduce:transition-none ${shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"} ${className}`}>
      {children}
    </div>
  );
}

/** Stages of a scene that plays one phone after another; back to the first when `runKey` changes. */
function useStages(runKey: number): [number, (stage: number) => void] {
  const [stage, setStage] = useState(0);
  useEffect(() => setStage(0), [runKey]);
  return [stage, (next: number) => setStage((current) => Math.max(current, next))];
}

// ---- Scene visuals of the walkthrough ------------------------------------------------------------------

function S1Visual(props: SceneVisualProps) {
  const [floor] = floorsFor(props, [PHONES.s1]);
  return <Phone owner="inst-rogelio" messages={PHONES.s1} {...playing(props)} floor={floor} size="solo" />;
}

function S2Visual(props: SceneVisualProps) {
  const [floor] = floorsFor(props, [PHONES.s2]);
  return <Phone owner="inst-rogelio" messages={PHONES.s2} {...playing(props)} floor={floor} size="solo" />;
}

/** A phone with console crops beside it (left, from 1024 px) or under it (phones and tablets). */
function WithCrops({ phone, children }: { readonly phone: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="flex w-full flex-col items-center gap-4 lg:flex-row-reverse lg:items-center lg:justify-center">
      {phone}
      <div className="flex w-full max-w-sm flex-col gap-4 lg:w-60 lg:shrink-0">{children}</div>
    </div>
  );
}

function S3Visual(props: SceneVisualProps) {
  const { run, still, runKey } = props;
  const [stage, reach] = useStages(runKey);
  const [floor] = floorsFor(props, [PHONES.s3Pass]);
  return (
    <WithCrops phone={<Phone owner="inst-rogelio" messages={PHONES.s3Pass} {...playing(props)} floor={floor} size="pair" onDone={() => reach(1)} />}>
      <Appear shown={still || stage >= 1 || run}>
        <EvidenceInset />
      </Appear>
    </WithCrops>
  );
}

function S4Visual(props: SceneVisualProps) {
  const { run, still, runKey } = props;
  const [stage, reach] = useStages(runKey);
  const [floor] = floorsFor(props, [PHONES.s4]);
  return (
    <WithCrops phone={<Phone owner="inst-rogelio" messages={PHONES.s4} {...playing(props)} floor={floor} size="pair" onDone={() => reach(1)} />}>
      <Appear shown={still || run}>
        <ChecklistInset />
      </Appear>
      <Appear shown={still || stage >= 1}>
        <OutboxInset rows={CERTIFICATE_OUTBOX} />
      </Appear>
    </WithCrops>
  );
}

/** Past this share of the S5 block (pinned), the first phone becomes Rogelio's: Héctor's instruction arrives over the bridge. */
const BRIDGE_AT = 0.6;

function S5Visual(props: SceneVisualProps) {
  const { run, runKey, desktop, progress } = props;
  const [stage, reach] = useStages(runKey);
  const bridge = desktop && progress > BRIDGE_AT;
  const [adrianaFloor, hectorFloor] = floorsFor(props, [PHONES.s5Adriana, PHONES.s5Hector]);
  const rogelioFloor = desktop ? revealFloors([PHONES.s5Rogelio.length], (progress - BRIDGE_AT) / 0.15)[0] : 0;
  const adriana = <Phone owner="sup-adriana" messages={PHONES.s5Adriana} {...playing(props)} floor={adrianaFloor} size="short" onDone={() => reach(1)} />;
  const hector = <Phone owner="sup-hector" messages={PHONES.s5Hector} {...playing(props)} run={run && stage >= 1} floor={hectorFloor} size="pair" onDone={() => reach(2)} />;
  const rogelio = <Phone owner="inst-rogelio" messages={PHONES.s5Rogelio} {...playing(props)} run={run && (desktop ? bridge : stage >= 2)} floor={rogelioFloor} size="short" />;
  if (!desktop) {
    return (
      <div className="flex w-full flex-col items-center gap-4">
        {adriana}
        {hector}
        {rogelio}
      </div>
    );
  }
  return (
    <div className="flex items-end justify-center gap-4">
      <div className="relative">
        <Appear shown={!bridge}>{adriana}</Appear>
        <Appear shown={bridge} className="absolute inset-0">
          {rogelio}
        </Appear>
      </div>
      {hector}
    </div>
  );
}

function S6Visual(props: SceneVisualProps) {
  const { run, still, runKey } = props;
  const [stage, reach] = useStages(runKey);
  const [rogelioFloor, adrianaFloor] = floorsFor(props, [PHONES.s6Rogelio, PHONES.s6Adriana]);
  return (
    <div className="relative flex w-full flex-col items-center gap-4 lg:flex-row lg:items-start lg:justify-center">
      <Phone owner="inst-rogelio" messages={PHONES.s6Rogelio} {...playing(props)} floor={rogelioFloor} size="pair" onDone={() => reach(1)} />
      <div className="flex w-full max-w-sm flex-col items-center gap-4 lg:w-auto">
        <Phone owner="sup-adriana" messages={PHONES.s6Adriana} {...playing(props)} run={run && stage >= 1} floor={adrianaFloor} size="short" onDone={() => reach(2)} />
        <Appear shown={still || stage >= 2} className="w-full lg:w-72">
          <OutboxInset rows={SAFETY_OUTBOX} />
        </Appear>
      </div>
    </div>
  );
}

export const SCENE_VISUALS = { S1: S1Visual, S2: S2Visual, S3: S3Visual, S4: S4Visual, S5: S5Visual, S6: S6Visual } as const;

// ---- The manifest's scene renders, one visual each ----------------------------------------------------

export const SCENE_RENDERS = {
  "s1-voice-diagnosis": (props: RenderProps) => <Phone owner="inst-rogelio" messages={PHONES.s1} {...props} size="still" />,
  "s2-policy-cite": (props: RenderProps) => <Phone owner="inst-rogelio" messages={PHONES.s2} {...props} size="still" />,
  "s3-photo-reject": (props: RenderProps) => (
    <div className="flex flex-col items-center gap-4">
      <Phone owner="inst-rogelio" messages={PHONES.s3Reject} {...props} size="still" />
      <EvidenceInset className="w-80" />
    </div>
  ),
  "s3-photo-pass": (props: RenderProps) => <Phone owner="inst-rogelio" messages={PHONES.s3Pass} {...props} size="still" />,
  "s4-checklist-complete": () => <ChecklistInset className="w-96 max-w-full" />,
  "s4-certificate-pdf": (props: RenderProps) => <Phone owner="inst-rogelio" messages={PHONES.s4} {...props} size="still" />,
  "s4-outbox": () => <OutboxInset rows={CERTIFICATE_OUTBOX} className="w-96 max-w-full" />,
  "s5-escalation-template": (props: RenderProps) => <Phone owner="sup-adriana" messages={PHONES.s5Adriana} {...props} size="still" />,
  "s5-escalation-take": (props: RenderProps) => (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      <Phone owner="sup-hector" messages={PHONES.s5Hector} {...props} size="still" />
      <Phone owner="inst-rogelio" messages={PHONES.s5Rogelio} {...props} size="still" />
    </div>
  ),
  "s6-safety-hazard": (props: RenderProps) => <Phone owner="inst-rogelio" messages={PHONES.s6Rogelio} {...props} size="still" />,
  "s6-safety-alerts": (props: RenderProps) => (
    <div className="flex flex-col items-center gap-4">
      <Phone owner="sup-adriana" messages={PHONES.s6Adriana} {...props} size="still" />
      <OutboxInset rows={SAFETY_OUTBOX} className="w-96 max-w-full" />
    </div>
  ),
} as const;

/** Every story entry a scene render shows, for the checks of landing.test.ts. */
export const SCENE_PHONE_ENTRIES: readonly string[] = Object.values(PHONES).flatMap((messages) => messages.map((message) => message.entry.id));
