// The tour's quick messages (FL-082): the main story's messages, each ready to send as the person who
// writes it, by scene, with its English gloss; a message that also stands for what the person did in the
// field (cleaning the connector) says so, because sending it changes the ONU too. The texts come from the
// BFF (story/main-story.ts through `simulator.quickMessages`), never from this file.
import { Badge } from "../../components/Badge";
import { Section } from "../../components/Section";
import { simulatorCopy } from "./copy";
import type { QuickMessage, SimAction, SimIdentity } from "./simulator-api";
import { nameOf } from "./simulator-model";

interface QuickMessagesProps {
  readonly messages: readonly QuickMessage[];
  readonly identities: readonly SimIdentity[];
  readonly busy: boolean;
  readonly onSend: (message: QuickMessage, action: SimAction) => void;
}

export function QuickMessages({ messages, identities, busy, onSend }: QuickMessagesProps) {
  const copy = simulatorCopy.quick;
  const scenes = [...new Set(messages.map((message) => message.scene))];
  return (
    <Section id="simulator-quick" title={copy.title} description={copy.lead}>
      {messages.length === 0 ? <p className="text-sm text-slate">{copy.empty}</p> : null}
      <div className="flex flex-col gap-4">
        {scenes.map((scene) => (
          <div key={scene}>
            <h3 className="text-xs font-semibold tracking-wide text-slate uppercase">{copy.scene(scene)}</h3>
            <ul className="mt-2 flex flex-col gap-2">
              {messages
                .filter((message) => message.scene === scene)
                .map((message) => {
                  const who = nameOf(identities.find((identity) => identity.identity === message.identity));
                  return (
                    <li key={message.quickId}>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={copy.send(message.label)}
                        className="flex min-h-11 w-full flex-col gap-1 rounded-lg border border-mist px-3 py-2 text-left hover:bg-paper disabled:opacity-50"
                        onClick={() => onSend(message, { kind: "quick", quickId: message.quickId })}
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge tone="brand">{copy.kinds[message.type]}</Badge>
                          <span className="text-xs text-slate">{copy.as(who)}</span>
                        </span>
                        <span className="text-sm text-ink">{message.label}</span>
                        <span lang="en" className="text-xs text-info italic">
                          {message.glossEn}
                        </span>
                        {message.physicalAction !== null ? <span className="text-xs font-semibold text-warning">{copy.physical}</span> : null}
                      </button>
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}
