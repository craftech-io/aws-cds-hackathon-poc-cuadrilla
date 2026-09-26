// Language of the landing: Mexican Spanish by default, English with `?lang=en` so a shared link opens
// in the same language, and a switch on the page. The document's `lang` follows the switch
// (`es-MX` / `en`), so assistive technology reads each language with its own voice. React context, no
// state library.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { LANDING_COPY, type LandingCopy, type LandingLang } from "./copy";

interface LandingLangValue {
  readonly lang: LandingLang;
  readonly copy: LandingCopy;
  setLang(lang: LandingLang): void;
}

const LandingLangContext = createContext<LandingLangValue | undefined>(undefined);

export function langFromSearch(search: URLSearchParams): LandingLang {
  return search.get("lang")?.toLowerCase().startsWith("en") ? "en" : "es";
}

export function LandingLangProvider({ initial, children }: { readonly initial: LandingLang; readonly children: ReactNode }) {
  const [lang, setLang] = useState<LandingLang>(initial);
  const value = useMemo<LandingLangValue>(() => ({ lang, copy: LANDING_COPY[lang], setLang }), [lang]);
  useEffect(() => {
    document.documentElement.lang = LANDING_COPY[lang].htmlLang;
  }, [lang]);
  return <LandingLangContext.Provider value={value}>{children}</LandingLangContext.Provider>;
}

/** Spanish outside a provider, so a reused figure never renders without text. */
export function useLandingCopy(): LandingCopy {
  return useContext(LandingLangContext)?.copy ?? LANDING_COPY.es;
}

export function useLandingLang(): LandingLangValue | undefined {
  return useContext(LandingLangContext);
}
