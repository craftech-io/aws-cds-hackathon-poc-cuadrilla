// What the person attaches from the phone: a photo of the synthetic set (copied on the server from the
// seed) or one of their own (a presigned POST, checked here for type and size first), and a voice note
// recorded in the browser (≤ 60 s) or one of the sample notes. When the browser cannot record, the
// record button is not there and the samples are. Nothing here names a file by its id.
import { useId, useState } from "react";
import { Button } from "../../components/Button";
import { FIELD_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { simulatorCopy } from "./copy";
import type { RecordingType } from "./recorder";
import { useVoiceRecorder } from "./recorder";
import type { CatalogPhoto, CatalogVoice, SimAction } from "./simulator-api";
import { photoExpectation, photoLabel, photoProblem, voiceLabel } from "./simulator-model";

interface PanelProps {
  readonly identity: string;
  readonly busy: boolean;
  readonly act: (action: SimAction) => Promise<boolean>;
}

const PANEL = "flex flex-col gap-3 border-t border-mist bg-white p-3";
const LIST = "flex max-h-56 flex-col gap-1 overflow-y-auto";
const ROW = "flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-mist px-3 py-1.5 text-left text-sm hover:bg-paper disabled:opacity-50";

export function PhotoPanel({ identity, busy, act, photos }: PanelProps & { readonly photos: readonly CatalogPhoto[] }) {
  const copy = simulatorCopy.photos;
  const [file, setFile] = useState<File | undefined>(undefined);
  const [caption, setCaption] = useState("");
  const fileId = useId();
  const captionId = useId();
  const problem = file === undefined ? undefined : photoProblem(file);
  const sendOwn = async () => {
    if (file === undefined || problem !== undefined) return;
    const text = caption.trim();
    if (await act({ kind: "ownPhoto", identity, file, ...(text === "" ? {} : { caption: text }) })) {
      setFile(undefined);
      setCaption("");
    }
  };
  return (
    <section aria-label={copy.title} className={PANEL}>
      <h3 className="text-sm font-semibold text-navy">{copy.setTitle}</h3>
      <p className="text-xs text-slate">{copy.setLead}</p>
      <ul className={LIST}>
        {photos.map((photo) => {
          const label = photoLabel(photo);
          return (
            <li key={photo.photoId}>
              <button type="button" className={ROW} disabled={busy} aria-label={copy.send(label)} onClick={() => void act({ kind: "samplePhoto", identity, photoId: photo.photoId })}>
                <span className="font-medium text-navy">{label}</span>
                <span className="text-xs text-slate">{photoExpectation(photo)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <label htmlFor={fileId} className={LABEL_CLASS}>
        {copy.own}
        <input id={fileId} type="file" accept="image/jpeg,.jpg,.jpeg" className={FIELD_CLASS} onChange={(event) => setFile(event.target.files?.[0])} />
      </label>
      {problem ? (
        <p role="alert" className="text-xs text-danger">
          {copy[problem]}
        </p>
      ) : null}
      <label htmlFor={captionId} className={LABEL_CLASS}>
        {copy.caption}
        <input id={captionId} className={FIELD_CLASS} value={caption} maxLength={1024} autoComplete="off" onChange={(event) => setCaption(event.target.value)} />
      </label>
      <div>
        <Button variant="secondary" disabled={busy || file === undefined || problem !== undefined} onClick={() => void sendOwn()}>
          {copy.sendOwn}
        </Button>
      </div>
    </section>
  );
}

function Recorder({ identity, busy, act }: PanelProps) {
  const copy = simulatorCopy.voice;
  const recorder = useVoiceRecorder((note: Blob, type: RecordingType) => void act({ kind: "ownVoice", identity, file: note, contentType: type.contentType }));
  // No MediaRecorder, no microphone API or no container it records: the button is not offered.
  if (recorder.support === undefined) return <p className="text-xs text-slate">{copy.unsupported}</p>;
  const { state } = recorder;
  return (
    <div className="flex flex-col gap-2">
      {state.status === "recording" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" className="text-sm font-semibold text-danger">
            {copy.recording(state.seconds)}
          </span>
          <Button onClick={recorder.stop}>{copy.stop}</Button>
          <Button variant="ghost" onClick={recorder.cancel}>
            {copy.cancel}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy} onClick={() => void recorder.start()}>
            {copy.record}
          </Button>
          <span className="text-xs text-slate">{copy.limit}</span>
        </div>
      )}
      {state.status === "error" ? (
        <p role="alert" className="text-xs text-danger">
          {copy[state.problem]}
        </p>
      ) : null}
    </div>
  );
}

export function VoicePanel({ identity, busy, act, voices }: PanelProps & { readonly voices: readonly CatalogVoice[] }) {
  const copy = simulatorCopy.voice;
  return (
    <section aria-label={copy.title} className={PANEL}>
      <Recorder identity={identity} busy={busy} act={act} />
      <h3 className="text-sm font-semibold text-navy">{copy.samples}</h3>
      <ul className={LIST}>
        {voices.map((voice, index) => {
          const label = voiceLabel(voice, index);
          return (
            <li key={voice.voiceId}>
              <button type="button" className={ROW} disabled={busy} aria-label={copy.send(label)} onClick={() => void act({ kind: "sampleVoice", identity, voiceId: voice.voiceId })}>
                <span className="shrink-0 font-medium text-navy">{label}</span>
                <span className="min-w-0 truncate text-xs text-slate">«{voice.text}»</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
