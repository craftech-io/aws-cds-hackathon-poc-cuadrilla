// The simulated phone of one identity: a frame that always says it is a simulator, the chat with
// Cuadrilla grouped by simulated day, "El agente está escribiendo…" while a turn runs, "Marcar como
// leídos" while Cuadrilla's messages are unread, and the composer (text, photo, voice note). The number
// the world does not know only writes: Cuadrilla answers it with a fixed notice that stays out of the world.
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { FIELD_CLASS } from "../../components/form-classes";
import { copy as consoleCopy } from "../../copy/console";
import { Bubble } from "./Bubble";
import { simulatorCopy } from "./copy";
import { PhotoPanel, VoicePanel } from "./MediaPanels";
import { type Catalog, type SimAction, type Thread, UNKNOWN_IDENTITY } from "./simulator-api";
import { byDay, phoneItems, unreadCount } from "./simulator-model";

const copy = simulatorCopy;

type Attach = "none" | "photo" | "voice";

interface PhoneProps {
  readonly identity: string;
  /** "Teléfono de Rogelio Méndez". */
  readonly owner: string;
  readonly thread: Thread | undefined;
  readonly typing: boolean;
  readonly busy: boolean;
  readonly catalog: Catalog | undefined;
  readonly act: (action: SimAction) => Promise<boolean>;
}

function Composer({ identity, busy, catalog, act }: Pick<PhoneProps, "identity" | "busy" | "catalog" | "act">) {
  const [text, setText] = useState("");
  const [attach, setAttach] = useState<Attach>("none");
  const inputId = useId();
  const send = async () => {
    const value = text.trim();
    if (value === "") return;
    if (await act({ kind: "text", identity, text: value })) setText("");
  };
  const toggle = (next: Attach) => setAttach((current) => (current === next ? "none" : next));
  const media = identity !== UNKNOWN_IDENTITY && catalog !== undefined;
  return (
    <div>
      {media && attach === "photo" ? <PhotoPanel identity={identity} busy={busy} act={act} photos={catalog.photos} /> : null}
      {media && attach === "voice" ? <VoicePanel identity={identity} busy={busy} act={act} voices={catalog.voices} /> : null}
      <form
        className="flex flex-col gap-2 border-t border-mist bg-paper p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {media ? (
          <div className="flex gap-1">
            <Button variant="ghost" aria-pressed={attach === "photo"} onClick={() => toggle("photo")}>
              {copy.composer.photo}
            </Button>
            <Button variant="ghost" aria-pressed={attach === "voice"} onClick={() => toggle("voice")}>
              {copy.composer.voice}
            </Button>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <label htmlFor={inputId} className="sr-only">
            {copy.composer.label}
          </label>
          <input
            id={inputId}
            className={`${FIELD_CLASS} min-w-0 flex-1`}
            value={text}
            maxLength={4096}
            placeholder={copy.composer.placeholder}
            autoComplete="off"
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" disabled={busy || text.trim() === ""}>
            {copy.composer.send}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function Phone({ identity, owner, thread, typing, busy, catalog, act }: PhoneProps) {
  const items = phoneItems(thread?.bubbles ?? []);
  const groups = byDay(items, consoleCopy.clock.weekdays);
  const unread = unreadCount(items);
  const chat = useRef<HTMLDivElement>(null);
  const last = items.at(-1)?.bubble.messageId;
  // New messages scroll into view, as on a phone.
  useEffect(() => {
    const element = chat.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [last, typing]);
  const tap: Parameters<typeof Bubble>[0]["onTap"] = (bubble, button) => void act({ kind: "tap", identity, messageId: bubble.messageId, buttonId: button.id });

  return (
    <section aria-label={owner} className="mx-auto flex w-full max-w-md flex-col overflow-hidden rounded-4xl border-8 border-navy-deep bg-mist shadow-float">
      <header className="bg-navy px-4 py-3 text-white">
        <p className="text-2xs font-semibold tracking-wide text-cyan uppercase">{copy.frameLabel}</p>
        <p className="mt-1 font-semibold">{copy.chatName}</p>
        <p className="text-xs text-mist">{copy.chatSubtitle}</p>
        <p className="mt-1 text-xs text-mist">{owner}</p>
      </header>
      <div ref={chat} role="log" aria-label={copy.phone.messages} aria-live="polite" className="flex h-112 flex-col gap-3 overflow-y-auto px-3 py-4">
        {identity === UNKNOWN_IDENTITY ? <p className="rounded-lg bg-white px-3 py-2 text-xs text-slate">{copy.identity.unknownNote}</p> : null}
        {groups.length === 0 && identity !== UNKNOWN_IDENTITY ? <p className="text-center text-sm text-slate">{copy.phone.empty}</p> : null}
        {groups.map((group) => (
          <div key={group.day} className="flex flex-col gap-2">
            <p className="mx-auto rounded-full bg-white px-3 py-0.5 text-xs text-slate shadow-card">{group.day}</p>
            <ul className="flex flex-col gap-2">
              {group.items.map((item) => (
                <Bubble key={item.bubble.messageId} item={item} onTap={tap} tapping={busy} />
              ))}
            </ul>
          </div>
        ))}
        {typing ? (
          <p role="status" className="flex items-center gap-2 self-start rounded-bubble rounded-tl-sm bg-white px-3 py-2 text-sm text-slate italic shadow-card">
            <span aria-hidden="true" className="flex gap-1">
              {[0, 1, 2].map((dot) => (
                <span key={dot} className="h-1.5 w-1.5 rounded-full bg-slate motion-safe:animate-typing-dot" style={{ animationDelay: `${dot * 160}ms` }} />
              ))}
            </span>
            {copy.phone.typing}
          </p>
        ) : null}
      </div>
      {unread > 0 ? (
        <div className="flex justify-end bg-paper px-3 pt-2">
          <Button variant="ghost" disabled={busy} onClick={() => void act({ kind: "markRead", identity })}>
            {copy.phone.markRead}
          </Button>
        </div>
      ) : null}
      <Composer key={identity} identity={identity} busy={busy} catalog={catalog} act={act} />
    </section>
  );
}
