// Texts of the public landing in Mexican Spanish and English with a switch (docs/landing-spec.md §1 and
// §8): both languages carry the same keys (landing.test.ts). What the captures of the console show is
// never here: the product writes it, and story.ts reads the main story for the scenes' captions.
import { en } from "./copy-en";
import { type LandingCopy, es } from "./copy-es";

export type { LandingCopy, SceneKey } from "./copy-es";

export const LANDING_COPY = { es, en } as const satisfies Record<string, LandingCopy>;

export type LandingLang = keyof typeof LANDING_COPY;

/** The value of `?lang=` that keeps the language on the way to the signup and the login (B9). */
export const LANG_PARAM: Readonly<Record<LandingLang, string>> = { es: "es-MX", en: "en" };
