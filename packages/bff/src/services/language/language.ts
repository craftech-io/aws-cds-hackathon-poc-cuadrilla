// Deterministic Spanish/English detector for the outbound check (outbound/verify, WP-28): every
// text to the staff must be Spanish (ADR-0013, "el idioma es español"); the English glosses of
// copy/en-gloss.ts are for the console, never for WhatsApp. No model and no dictionary service: it
// counts function words and field words that only one of the two languages uses, plus the marks only
// Spanish writes (ñ, ¿, ¡, accented vowels) and English contractions. The same text always gets the
// same answer; a text without enough evidence is `und`, never a guess.
import { z } from "zod";
import { stripMaskMarkers } from "../../lib/mask";

export const Language = z.enum(["es", "en"]);
export type Language = z.infer<typeof Language>;

// Words that exist in only one of the two languages. Ambiguous ones ("a", "no", "me", "he", "son",
// "come", "real", "plan", "total", "manual", "cable", "local") are left out on purpose, and so are
// product and brand words a Spanish text may carry ("Cuadrilla", "Powered by Craftech", "ONU", "PON").
const SPANISH = new Set([
  "de", "la", "que", "el", "en", "y", "los", "del", "las", "por", "un", "una", "para", "con", "es", "se", "lo", "al", "su", "sus",
  "pero", "más", "mas", "como", "este", "esta", "esto", "ese", "esa", "ya", "muy", "hay", "está", "están", "tiene", "tienen", "tienes",
  "puedes", "quieres", "sabes", "mándame", "manda", "revisa", "limpia", "toca", "tú", "te", "tu", "tus", "le", "les", "nos", "mi",
  "mis", "si", "sí", "también", "cuando", "hasta", "desde", "entre", "sobre", "sin", "hola", "gracias", "favor", "hoy", "mañana",
  "ayer", "día", "días", "hora", "horas", "falta", "faltan", "orden", "órdenes", "foto", "fotos", "etiqueta", "medidor", "roseta",
  "potencia", "cliente", "instalación", "supervisora", "caso", "sección", "conector", "lectura", "listo", "lista",
  "cerrar", "cierra", "necesito", "escalé", "tomó", "consultar", "aléjate", "avisa", "reflejo", "inclina", "teléfono", "costo",
  "cobra", "nunca", "siguiente", "factura", "otra", "otro", "vez", "ahora", "bien", "aquí", "dónde", "cuál", "qué",
]);

const ENGLISH = new Set([
  "the", "of", "and", "to", "in", "is", "you", "that", "for", "it", "with", "as", "on", "be", "at", "by", "this", "we", "are",
  "please", "your", "our", "will", "have", "has", "from", "dear", "regards", "thank", "thanks", "would", "could", "should",
  "can", "not", "an", "or", "if", "was", "were", "been", "send", "sent", "photo", "photos", "label", "meter", "reading", "power",
  "customer", "installation", "case", "section", "connector", "ready", "close", "need", "escalated", "took", "ask", "away",
  "glare", "tilt", "phone", "cost", "charge", "never", "next", "invoice", "another", "time", "now", "here", "where", "which",
  "what", "when", "there", "their", "they", "them", "these", "those", "before", "after", "must", "order", "orders", "today",
  "tomorrow", "missing", "hello", "take", "check", "clean", "tap", "reply", "update",
]);

const SPANISH_MARKS = /[ñ¿¡áéíóú]/g;
const ENGLISH_CONTRACTIONS = /\b[a-z]+'(?:s|t|re|ll|ve|m|d)\b/g;
const URL_OR_EMAIL = /\bhttps?:\/\/\S+|\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi;
const WORD = /[a-záéíóúüñ]+/g;

export interface LanguageGuess {
  readonly language: Language | "und";
  /** Evidence counted for each language. */
  readonly es: number;
  readonly en: number;
}

/** Evidence below this total is not enough to decide. */
export const MIN_EVIDENCE = 2;
/** The winner needs at least this many times the other's evidence. */
export const DOMINANCE = 2;

export function detectLanguage(text: string): LanguageGuess {
  const clean = stripMaskMarkers(text).replace(URL_OR_EMAIL, " ").toLowerCase().normalize("NFC");
  let es = (clean.match(SPANISH_MARKS) ?? []).length;
  let en = (clean.replace(/[’]/g, "'").match(ENGLISH_CONTRACTIONS) ?? []).length;
  for (const word of clean.match(WORD) ?? []) {
    if (SPANISH.has(word)) es += 1;
    else if (ENGLISH.has(word)) en += 1;
  }
  let language: LanguageGuess["language"] = "und";
  if (es + en >= MIN_EVIDENCE) {
    if (es >= DOMINANCE * en && es > en) language = "es";
    else if (en >= DOMINANCE * es && en > es) language = "en";
  }
  return { language, es, en };
}

/** True only when the text is detected as `language`; an undecided text is not in any language. */
export function isInLanguage(text: string, language: Language): boolean {
  return detectLanguage(text).language === language;
}
