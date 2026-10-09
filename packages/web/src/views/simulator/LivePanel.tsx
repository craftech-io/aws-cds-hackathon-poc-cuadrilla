// "Probar con mi WhatsApp" and the guest's kit (FL-101, docs/architecture-integrations.md §4.4.1): only
// with the live transport in the stage. A one-use join code for a person of the user's world, shown as
// the message to send, the demo's number when the BFF names it, and a QR that opens WhatsApp with the
// message ready; and the kit: the story's photos and voice note to forward from the phone (each with a
// QR that opens it there) and the script with its pronunciation for whoever does not speak Spanish.
import { useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import { RemoteBlock } from "../../components/RemoteBlock";
import { Section } from "../../components/Section";
import { SelectField } from "../../components/SelectField";
import { useAction, useRemote } from "../../lib/use-remote";
import { QrCode } from "../../components/QrCode";
import { simulatorCopy } from "./copy";
import { phoneticOf } from "./phonetic";
import type { JoinCode, Kit, SimIdentity, SimulatorApi } from "./simulator-api";
import { UNKNOWN_IDENTITY } from "./simulator-api";
import { nameOf } from "./simulator-model";

/** `https://wa.me/<digits>?text=ALTA%20…` when the number is known; the message alone otherwise. */
export function joinQrValue(join: Pick<JoinCode, "message" | "number">): string {
  if (join.number === undefined) return join.message;
  return `https://wa.me/${join.number.replace(/\D/g, "")}?text=${encodeURIComponent(join.message)}`;
}

function JoinCodeBlock({ api, people }: { readonly api: SimulatorApi; readonly people: readonly SimIdentity[] }) {
  const copy = simulatorCopy.live;
  const [personId, setPersonId] = useState(people[0]?.identity ?? "");
  const issue = useAction((id: string) => api.joinCode(id));
  const options = people.map((person) => ({ value: person.identity, label: nameOf(person) }));
  const join = issue.state.status === "done" ? issue.state.data : undefined;
  return (
    <Section id="simulator-live" title={copy.title} description={copy.lead}>
      <div className="flex flex-wrap items-end gap-3">
        <SelectField label={copy.person} value={personId} options={options} onChange={setPersonId} />
        <Button disabled={personId === "" || issue.state.status === "running"} onClick={() => void issue.run(personId)}>
          {copy.generate}
        </Button>
      </div>
      {issue.state.status === "error" ? (
        <div className="mt-3">
          <ApiErrorNotice error={issue.state.error} />
        </div>
      ) : null}
      {join ? (
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <QrCode value={joinQrValue(join)} label={join.number === undefined ? copy.qrText : copy.qr} />
          <div className="flex flex-col gap-1 text-sm text-ink">
            <p className="text-lg font-semibold text-navy">
              <code className="font-mono">{join.message}</code>
            </p>
            <p>{copy.send(join.message)}</p>
            {join.number !== undefined ? <p>{copy.number(join.number)}</p> : null}
            <p className="text-slate">{copy.expires(join.expiresInMinutes)}</p>
          </div>
        </div>
      ) : null}
    </Section>
  );
}

function KitLink({ label, url }: { readonly label: string; readonly url: string }) {
  const copy = simulatorCopy.kit;
  const [qr, setQr] = useState(false);
  return (
    <li className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <a href={url} className="inline-flex min-h-11 items-center text-sm font-semibold text-cyan-deep underline" aria-label={copy.download(label)}>
          {label}
        </a>
        <Button variant="ghost" aria-expanded={qr} onClick={() => setQr((value) => !value)}>
          {qr ? copy.hideQr : copy.showQr(label)}
        </Button>
      </div>
      {qr ? <QrCode value={url} label={copy.qrOf(label)} /> : null}
    </li>
  );
}

function Line({ text, glossEn }: { readonly text: string; readonly glossEn?: string | undefined }) {
  return (
    <li className="rounded-lg border border-mist px-3 py-2">
      <p className="text-sm text-ink">{text}</p>
      {glossEn ? (
        <p lang="en" className="text-xs text-info italic">
          {glossEn}
        </p>
      ) : null}
      <p lang="en" className="mt-1 text-xs text-slate">
        <span className="font-semibold">{simulatorCopy.kit.phonetic}: </span>
        {phoneticOf(text)}
      </p>
    </li>
  );
}

function KitBlock({ kit }: { readonly kit: Extract<Kit, { available: true }> }) {
  const copy = simulatorCopy.kit;
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-semibold text-navy">{copy.photos}</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {kit.photos.map((photo, index) => (
              <KitLink key={photo.photoId} label={copy.photo(index + 1)} url={photo.url} />
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-navy">{copy.voices}</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {kit.voices.map((voice, index) => (
              <KitLink key={voice.voiceId} label={copy.voice(index + 1)} url={voice.url} />
            ))}
          </ul>
        </div>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-navy">{copy.script}</h3>
        <ul className="mt-2 flex flex-col gap-2">
          {kit.voices.flatMap((voice) => (voice.text === null ? [] : [<Line key={voice.voiceId} text={voice.text} />]))}
          {kit.script.map((line) => (
            <Line key={line.quickId} text={line.text} glossEn={line.glossEn} />
          ))}
        </ul>
      </div>
    </div>
  );
}

export function LivePanel({ api, identities }: { readonly api: SimulatorApi; readonly identities: readonly SimIdentity[] }) {
  const kit = useRemote("simulator.kit", (signal) => api.kit(signal));
  const people = identities.filter((identity) => identity.identity !== UNKNOWN_IDENTITY);
  return (
    <>
      <JoinCodeBlock api={api} people={people} />
      <Section id="simulator-kit" title={simulatorCopy.kit.title} description={simulatorCopy.kit.lead}>
        <RemoteBlock state={kit.state} onRetry={kit.reload}>
          {(data) => (data.available ? <KitBlock kit={data} /> : null)}
        </RemoteBlock>
      </Section>
    </>
  );
}
