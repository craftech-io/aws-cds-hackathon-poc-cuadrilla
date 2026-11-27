// The SMS code as the second factor of every session (ADR-0029, docs/landing-spec.md §7.10): the console
// shows nothing of a world until `phone.status` says PASSED; before, the whole screen is the code's card,
// in the frame of the sign-in (AuthShell, es/en). The BFF refuses everything else on its side anyway
// (`PHONE_VERIFICATION_REQUIRED`); this gate only spares the person those refusals.
import { type ReactNode, useState } from "react";
import { FullScreenMessage } from "../../components/FullScreenMessage";
import { useSession } from "../../context/SessionContext";
import { useRouter } from "../../lib/router";
import { AuthShell } from "../login/AuthShell";
import { type AuthLang, AuthLangProvider, useAuthLang } from "../login/auth-lang";
import { ErrorNote, LinkButton } from "../login/form-parts";
import { langOf } from "../guest-home/guest-home-model";
import { RichNote } from "../signup/RichNote";
import { phoneCopy } from "./copy";
import { PhoneStepCard } from "./PhoneStepCard";
import { type PhoneStep, usePhoneStep } from "./use-phone-step";

const LOCALE = { es: "es-MX", en: "en" } as const;

function PhoneScreen({ step }: { readonly step: PhoneStep }) {
  const { lang } = useAuthLang();
  const { signOut } = useSession();
  const copy = phoneCopy[lang];
  const below = <LinkButton onClick={signOut}>{copy.signOut}</LinkButton>;
  let body: ReactNode;
  if (step.state.kind === "failed") {
    body = (
      <div className="space-y-3">
        <ErrorNote>
          <RichNote text={copy.errors.UNAVAILABLE} />
        </ErrorNote>
        <LinkButton onClick={step.reload}>{copy.retry}</LinkButton>
      </div>
    );
  } else if (step.state.kind === "ready") {
    body = <PhoneStepCard copy={copy} status={step.state.status} step={step} onSend={(phone) => step.send(LOCALE[lang], phone)} onVerify={step.verify} />;
  }
  return <AuthShell below={below}>{body}</AuthShell>;
}

export function PhoneGate({ children }: { readonly children: ReactNode }) {
  const { search } = useRouter();
  const [lang] = useState<AuthLang>(() => langOf(search, document.documentElement.lang));
  const step = usePhoneStep();
  if (step.state.kind === "loading") return <FullScreenMessage title={phoneCopy[lang].loading} />;
  // A token the BFF refuses: the console's own screens ask to sign in again (nothing of a world reaches it).
  if (step.state.kind === "unauthorized" || (step.state.kind === "ready" && step.state.status.state === "PASSED")) return <>{children}</>;
  return (
    <AuthLangProvider initial={lang}>
      <PhoneScreen step={step} />
    </AuthLangProvider>
  );
}
