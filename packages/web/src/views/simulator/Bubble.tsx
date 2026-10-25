// One message on the phone, drawn as WhatsApp draws it: the phone owner's own on the right, Cuadrilla's
// on the left (a template with its tag, reply buttons and list rows the person taps: the tap goes back
// through the BFF with the button's nonce), photos, voice notes (never their transcription, ADR-0023
// §6), documents, the reaction the validator put on a photo, the hour and the ticks. A text of the
// product carries its English gloss behind "EN".
import { useId, useState } from "react";
import { simulatorCopy } from "./copy";
import { buttonGloss, glossOf } from "./gloss";
import type { Bubble as BubbleData, ThreadButton } from "./simulator-api";
import { type PhoneItem, textOf, ticksOf, timeOf } from "./simulator-model";

const copy = simulatorCopy.phone;

function Gloss({ bubble, shown }: { readonly bubble: BubbleData; readonly shown: string | null }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const text = glossOf({ text: shown, templateName: bubble.templateName });
  const buttons = bubble.buttons.map((button) => buttonGloss(button.title)).filter((title): title is string => title !== undefined);
  if (text === undefined && buttons.length === 0) return null;
  return (
    <div className="mt-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={copy.glossShow}
        className="min-h-6 rounded bg-mist px-1.5 text-2xs font-bold text-navy hover:bg-paper"
        onClick={() => setOpen((value) => !value)}
      >
        {copy.gloss}
      </button>
      {open ? (
        <div id={id} lang="en" role="note" aria-label={copy.glossLabel} className="mt-1 rounded bg-info-soft px-2 py-1 text-xs whitespace-pre-line text-info italic">
          {text === undefined ? null : <p>{text}</p>}
          {buttons.length > 0 ? <p className={text === undefined ? "" : "mt-1"}>{buttons.map((title) => `[${title}]`).join(" ")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function Media({ bubble }: { readonly bubble: BubbleData }) {
  const { mediaKind, mediaUrl } = bubble;
  if (mediaKind === null) return null;
  if (mediaUrl === null) {
    const pending = mediaKind === "IMAGE" ? copy.photoPending : mediaKind === "AUDIO" ? copy.voicePending : copy.documentPending;
    return <p className="text-sm text-slate italic">{pending}</p>;
  }
  if (mediaKind === "IMAGE") return <img src={mediaUrl} alt={copy.photoAlt} loading="lazy" decoding="async" className="block max-h-64 w-full rounded-xl object-cover" />;
  if (mediaKind === "AUDIO") return <audio controls preload="metadata" src={mediaUrl} aria-label={copy.voiceLabel(timeOf(bubble))} className="h-10 w-56 max-w-full" />;
  const name = bubble.fileName ?? copy.documentPending;
  return (
    <a href={mediaUrl} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center gap-2 rounded-lg bg-paper px-2 py-1.5 text-sm text-navy hover:bg-mist" aria-label={copy.openDocument(name)}>
      <span aria-hidden="true" className="rounded bg-danger px-1 text-2xs font-bold text-white">
        PDF
      </span>
      <span className="min-w-0 break-all">{name}</span>
    </a>
  );
}

function Buttons({ bubble, onTap, disabled }: { readonly bubble: BubbleData; readonly onTap: (bubble: BubbleData, button: ThreadButton) => void; readonly disabled: boolean }) {
  if (bubble.direction !== "OUT" || bubble.buttons.length === 0) return null;
  const list = bubble.buttons.every((button) => button.kind === "list_reply");
  return (
    <div role="group" aria-label={list ? copy.listHint : undefined} className="mt-1 flex flex-col gap-1">
      {bubble.buttons.map((button) => (
        <button
          key={button.id}
          type="button"
          disabled={disabled}
          aria-label={copy.tap(button.title)}
          className={`min-h-11 rounded-lg bg-white px-3 text-sm font-semibold text-info shadow-card hover:bg-paper disabled:opacity-50 ${list ? "text-left" : "text-center"}`}
          onClick={() => onTap(bubble, button)}
        >
          {button.title}
        </button>
      ))}
    </div>
  );
}

interface BubbleProps {
  readonly item: PhoneItem;
  readonly onTap: (bubble: BubbleData, button: ThreadButton) => void;
  readonly tapping: boolean;
}

export function Bubble({ item, onTap, tapping }: BubbleProps) {
  const { bubble, reactions } = item;
  const own = bubble.direction === "IN";
  const ticks = ticksOf(bubble);
  const shown = textOf(bubble);
  // A document without a caption reads its file name, which the attachment already shows.
  const text = bubble.mediaKind === "DOCUMENT" && shown === bubble.fileName ? null : shown;
  const tapped = own && bubble.buttonAction !== null && (bubble.text === null || bubble.text === "");
  return (
    <li className={`flex flex-col ${own ? "items-end" : "items-start"}`}>
      <div className={`relative max-w-5/6 rounded-bubble px-3 py-2 shadow-card ${own ? "rounded-tr-sm bg-cyan-soft" : "rounded-tl-sm bg-white"} ${reactions.length > 0 ? "mb-3" : ""}`}>
        {bubble.templateName !== null ? <p className="mb-1 text-2xs font-semibold tracking-wide text-slate uppercase">{copy.template}</p> : null}
        <Media bubble={bubble} />
        {text !== null ? (
          <p className={`text-sm break-words whitespace-pre-line text-ink ${bubble.mediaKind === null ? "" : "mt-1"}`}>
            {tapped ? <span className="sr-only">{`${copy.tapped}: `}</span> : null}
            {text}
          </p>
        ) : null}
        <Gloss bubble={bubble} shown={text} />
        <p className="mt-0.5 flex items-center justify-end gap-1 text-2xs text-slate">
          <time dateTime={bubble.sentAtSim}>{timeOf(bubble)}</time>
          {ticks ? (
            <span role="img" aria-label={ticks.label} title={ticks.label} className={ticks.read ? "font-bold text-info" : ticks.symbol === "!" ? "font-bold text-danger" : ""}>
              {ticks.symbol}
            </span>
          ) : null}
        </p>
        {reactions.length > 0 ? (
          <span role="img" aria-label={copy.reaction(reactions.join(" "))} className={`absolute -bottom-3 ${own ? "right-2" : "left-2"} rounded-full bg-white px-1.5 text-sm shadow-card`}>
            {reactions.join("")}
          </span>
        ) : null}
      </div>
      <Buttons bubble={bubble} onTap={onTap} disabled={tapping} />
    </li>
  );
}
