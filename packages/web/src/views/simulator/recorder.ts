// Voice notes recorded in the browser (docs/design-brief.md §6, FL-082): `MediaRecorder` with the first
// container the browser supports among Ogg, WebM and MP4 (`isTypeSupported`), at most 60 seconds, sent
// as soon as the person stops or the limit is reached. Without `MediaRecorder` or a microphone the record
// button is hidden and the simulator offers the sample notes. The type sent to the BFF is the base type
// (`audio/webm`), which the presigned POST fixes and the BFF proves again by the file's first bytes.
import { useCallback, useEffect, useRef, useState } from "react";

/** The longest voice note the simulator records. */
export const MAX_RECORDING_SECONDS = 60;

/** Containers in order of preference: what WhatsApp sends (Ogg/Opus), then what Chromium and WebKit record. */
export const RECORDING_TYPES = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm", "audio/mp4"] as const;

export interface RecordingType {
  /** What `MediaRecorder` is asked for. */
  readonly mimeType: string;
  /** What the presigned POST and the BFF are told: the base type. */
  readonly contentType: "audio/ogg" | "audio/webm" | "audio/mp4";
}

/** The first type the browser records, or undefined when it records none of them. */
export function pickRecordingType(isTypeSupported: ((type: string) => boolean) | undefined): RecordingType | undefined {
  if (isTypeSupported === undefined) return undefined;
  const mimeType = RECORDING_TYPES.find((type) => {
    try {
      return isTypeSupported(type);
    } catch {
      return false;
    }
  });
  if (mimeType === undefined) return undefined;
  return { mimeType, contentType: mimeType.split(";")[0] as RecordingType["contentType"] };
}

interface RecorderGlobals {
  readonly MediaRecorder?: { isTypeSupported?: (type: string) => boolean };
  readonly navigator?: { readonly mediaDevices?: { getUserMedia?: unknown } };
}

/** What this browser records with, or undefined (no `MediaRecorder`, no microphone API, no supported type). */
export function recordingSupport(globals: RecorderGlobals = globalThis as RecorderGlobals): RecordingType | undefined {
  if (typeof globals.navigator?.mediaDevices?.getUserMedia !== "function") return undefined;
  const recorder = globals.MediaRecorder;
  if (recorder === undefined || typeof recorder.isTypeSupported !== "function") return undefined;
  return pickRecordingType((type) => recorder.isTypeSupported?.(type) === true);
}

export type RecorderState = { readonly status: "idle" } | { readonly status: "recording"; readonly seconds: number } | { readonly status: "error"; readonly problem: "denied" | "tooShort" };

export interface VoiceRecorder {
  readonly support: RecordingType | undefined;
  readonly state: RecorderState;
  start(): Promise<void>;
  /** Stops and hands the note to `onDone`. */
  stop(): void;
  /** Stops and drops the note. */
  cancel(): void;
}

export function useVoiceRecorder(onDone: (note: Blob, type: RecordingType) => void): VoiceRecorder {
  const [support] = useState(() => recordingSupport());
  const [state, setState] = useState<RecorderState>({ status: "idle" });
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const keep = useRef(true);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  const finish = useCallback((save: boolean) => {
    keep.current = save;
    if (timer.current !== undefined) clearInterval(timer.current);
    timer.current = undefined;
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  const start = useCallback(async () => {
    if (support === undefined || recorder.current?.state === "recording") return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setState({ status: "error", problem: "denied" });
      return;
    }
    const chunks: Blob[] = [];
    const media = new MediaRecorder(stream, { mimeType: support.mimeType });
    media.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    media.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      recorder.current = undefined;
      const note = new Blob(chunks, { type: support.contentType });
      if (!keep.current) return setState({ status: "idle" });
      if (note.size === 0) return setState({ status: "error", problem: "tooShort" });
      setState({ status: "idle" });
      onDoneRef.current(note, support);
    };
    recorder.current = media;
    keep.current = true;
    const startedAt = Date.now();
    setState({ status: "recording", seconds: 0 });
    timer.current = setInterval(() => {
      const seconds = Math.min(MAX_RECORDING_SECONDS, Math.floor((Date.now() - startedAt) / 1000));
      setState({ status: "recording", seconds });
      if (seconds >= MAX_RECORDING_SECONDS) finish(true);
    }, 250);
    // A timeslice makes the browser hand over data as it records, so a long note never sits in one buffer.
    media.start(1000);
  }, [support, finish]);

  useEffect(() => () => finish(false), [finish]);

  return { support, state, start, stop: () => finish(true), cancel: () => finish(false) };
}
