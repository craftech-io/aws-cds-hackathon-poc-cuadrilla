// `/join` (docs/design-brief.md §7, FL-089): the staff opt-in page, public and static. It shows the
// product's opt-in poster (`optInPoster`, the one source of its words), the keyword to send and a QR.
// While the stage's WhatsApp runs on the simulated transport (P-01), the QR and the button open the
// console's phone simulator on this same site. The brand line is the stage's (`brand.get`): in
// co-branding it carries the synthetic-demo disclaimer, in the neutral mode the page labels the
// operator fictitious (ADR-0018). Mexican Spanish by default, English with `?lang=en` or the switch.
import { enGloss } from "@cuadrilla/bff/copy/en-gloss";
import { esMX } from "@cuadrilla/bff/copy/es-MX";
import { useEffect, useState } from "react";
import { BrandMark } from "../../components/brand/BrandMark";
import { useDemoBrand } from "../../context/BrandContext";
import { Link, useRouter } from "../../lib/router";
import { LANDING_PATH } from "../../routes";
import { langFromSearch } from "../landing/lang";
import { QrCode } from "../../components/QrCode";
import { joinCopy, type JoinLang } from "./copy";
import { JOIN_KEYWORD, SIMULATOR_PATH, simulatorUrl } from "./join-model";

const PRODUCT_TEXT = { es: esMX, en: enGloss } as const;

export default function JoinView() {
  const { search } = useRouter();
  const [lang, setLang] = useState<JoinLang>(() => langFromSearch(search));
  const copy = joinCopy[lang];
  const product = PRODUCT_TEXT[lang];
  const brand = useDemoBrand(lang);
  const next: JoinLang = lang === "es" ? "en" : "es";

  useEffect(() => {
    document.documentElement.lang = copy.htmlLang;
  }, [copy.htmlLang]);

  return (
    <div className="min-h-screen bg-navy px-4 py-8 text-white sm:px-8">
      <header className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
        <BrandMark brand={brand} tone="dark" size="md" />
        <button
          type="button"
          lang={joinCopy[next].htmlLang}
          title={copy.switchLabel}
          onClick={() => setLang(next)}
          className="inline-flex min-h-11 items-center justify-center rounded-md border border-navy-soft px-3 text-xs font-semibold text-white hover:bg-navy-soft"
        >
          {copy.switchTo}
        </button>
      </header>
      <main className="mx-auto mt-8 max-w-3xl">
        <h1 className="font-display text-3xl font-semibold text-white">{copy.title}</h1>
        <p className="mt-2 text-lead text-mist">{copy.lead}</p>
        <section aria-labelledby="join-keyword" className="mt-8 flex flex-col gap-6 rounded-card bg-white p-6 text-ink shadow-card sm:flex-row sm:items-center">
          <QrCode value={simulatorUrl(window.location.origin)} label={copy.qrLabel} />
          <div className="min-w-0">
            <p id="join-keyword" className="text-sm font-semibold uppercase tracking-widest text-slate">
              {copy.keyword}
            </p>
            <p className="font-display text-5xl font-semibold tracking-wide text-navy">{JOIN_KEYWORD}</p>
            <p className="mt-3 text-base text-ink">{product.optInPoster}</p>
          </div>
        </section>
        <section className="mt-6 rounded-card border border-navy-soft p-5">
          <p className="text-sm text-mist">{copy.simulated}</p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link to={SIMULATOR_PATH} className="inline-flex min-h-11 items-center rounded-md bg-cyan px-5 text-sm font-semibold text-navy-deep hover:bg-white">
              {copy.open}
            </Link>
            <Link to={LANDING_PATH} className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-cyan underline-offset-4 hover:underline">
              {copy.back}
            </Link>
          </div>
          <p className="mt-3 text-xs text-mist">{copy.signInNote}</p>
        </section>
        {/* In co-branding the brand line carries the synthetic-demo disclaimer itself. */}
        {brand.mode === "cobrand" ? null : (
          <p role="note" className="mt-6 text-sm text-cyan-soft">
            {product.fictitiousOperatorNotice}
          </p>
        )}
      </main>
    </div>
  );
}
