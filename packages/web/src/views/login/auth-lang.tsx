// Language of the sign-in and the sign-up (docs/landing-spec.md §7.9): Mexican Spanish by default,
// English with `?lang=en` (the landing's links carry the language it was showing), and a switch on the
// page. The choice lives in this provider, above the step machines, so moving from one step to the next
// never loses it; it never goes back into the URL. The document's `lang` follows it, so assistive
// technology reads each language with its own voice. Outside a provider (the console's drawers) the
// texts are Spanish, the console's language.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { type LoginCopy, loginCopy } from "./copy";
import { loginCopyEn } from "./copy.en";

export type AuthLang = "es" | "en";

const HTML_LANG: Readonly<Record<AuthLang, string>> = { es: "es-MX", en: "en" };
const LOGIN_COPY: Readonly<Record<AuthLang, LoginCopy>> = { es: loginCopy, en: loginCopyEn };

export function authLangFromSearch(search: URLSearchParams): AuthLang {
  return search.get("lang")?.toLowerCase().startsWith("en") ? "en" : "es";
}

/** `path` with `lang=` set to the language shown (`/signup?lang=en`), keeping its other parameters. */
export function withAuthLang(path: string, lang: AuthLang): string {
  const [pathname = path, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set("lang", HTML_LANG[lang]);
  return `${pathname}?${params.toString()}`;
}

interface AuthLangValue {
  readonly lang: AuthLang;
  setLang(lang: AuthLang): void;
}

const AuthLangContext = createContext<AuthLangValue | undefined>(undefined);

export function AuthLangProvider({ initial, children }: { readonly initial: AuthLang; readonly children: ReactNode }) {
  const [lang, setLang] = useState<AuthLang>(initial);
  const value = useMemo<AuthLangValue>(() => ({ lang, setLang }), [lang]);
  useEffect(() => {
    document.documentElement.lang = HTML_LANG[lang];
  }, [lang]);
  return <AuthLangContext.Provider value={value}>{children}</AuthLangContext.Provider>;
}

/** The language shown; Spanish outside a provider. */
export function useAuthLang(): AuthLangValue {
  return useContext(AuthLangContext) ?? { lang: "es", setLang: () => undefined };
}

export function useLoginCopy(): LoginCopy {
  return LOGIN_COPY[useAuthLang().lang];
}

/** The switch of the AuthShell: one button that offers the other language (≥ 44 px, its own `lang`). */
export function AuthLangSwitch() {
  const context = useContext(AuthLangContext);
  const copy = useLoginCopy();
  if (context === undefined) return null;
  const next: AuthLang = context.lang === "es" ? "en" : "es";
  return (
    <button
      type="button"
      lang={HTML_LANG[next]}
      title={copy.lang.label}
      aria-label={`${copy.lang.label}: ${copy.lang.switchTo}`}
      onClick={() => context.setLang(next)}
      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-mist bg-white px-3 text-xs font-semibold text-navy hover:bg-paper"
    >
      <span className="sm:hidden">{copy.lang.short}</span>
      <span className="hidden sm:inline">{copy.lang.switchTo}</span>
    </button>
  );
}
