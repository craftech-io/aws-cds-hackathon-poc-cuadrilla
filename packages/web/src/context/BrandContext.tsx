// The demo operator's brand for every surface (ADR-0018): asked once per page load from the public
// `brand.get`, before and after sign-in alike (the landing shows it too). Until it answers, and if
// it fails or does not parse, the brand is the neutral one, "Cuadrilla · Powered by Craftech".
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BRAND_PROCEDURE, type BrandLanguage, BrandView, type DemoBrand, demoBrandOf } from "../lib/brand";
import { consoleApiOf } from "../lib/console-api";
import { useSession } from "./SessionContext";

export interface BrandValue {
  /** The answer of `brand.get`; undefined while it has not arrived or when it failed. */
  readonly view: BrandView | undefined;
}

const BrandContext = createContext<BrandValue>({ view: undefined });

export function BrandProvider({ children }: { readonly children: ReactNode }) {
  const { trpc } = useSession();
  const [view, setView] = useState<BrandView | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    consoleApiOf(trpc)
      .query(BRAND_PROCEDURE, undefined, BrandView, controller.signal)
      .then(
        (answer) => {
          if (!controller.signal.aborted) setView(answer);
        },
        // Neutral brand: a surface never waits for, nor breaks on, the brand.
        () => undefined,
      );
    return () => controller.abort();
  }, [trpc]);

  const value = useMemo<BrandValue>(() => ({ view }), [view]);
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

/** The brand line of a surface in its language (the console is Spanish; the landing switches). */
export function useDemoBrand(language: BrandLanguage = "es"): DemoBrand {
  const { view } = useContext(BrandContext);
  return useMemo(() => demoBrandOf(view, language), [view, language]);
}

/** Visible name of the demo operator (`resolveBrand`), once the stage has said it. */
export function useOperatorName(): string | undefined {
  return useContext(BrandContext).view?.displayName;
}
