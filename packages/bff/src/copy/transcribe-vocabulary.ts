// Custom vocabulary `cuadrilla-poc-ftth-es-mx` of Amazon Transcribe (es-MX) for FTTH terms
// (docs/architecture-integrations.md §5). Table format, the one Transcribe still supports: a plain
// text `.txt` file, UTF-8, TAB-separated, header `Phrase\tSoundsLike\tIPA\tDisplayAs`, with the
// SoundsLike and IPA columns always empty (Transcribe ignores them and will drop them). infra/media.ts
// uploads `vocabularyFile()` to `Seed/<VOCABULARY_OBJECT_KEY>` and creates the vocabulary from it.
//
// Phrase rules (a wrong row leaves CreateVocabulary FAILED and breaks the deploy; the test checks
// them): only a-z, A-Z, apostrophe, hyphen, á é í ó ú ñ ü and their capitals except Ü; no spaces, no
// digits and no periods (es-MX rejects the period that other Spanish locales take for spelled-out
// acronyms); words joined by hyphens; a spelled-out acronym written as the Spanish names of its
// letters joined by hyphens ("o-ene-u"). DisplayAs holds the written form, and may use spaces, digits
// and symbols ("SC/APC").
//
// Pure module: infra/ imports it at synth time.

export const VOCABULARY_NAME = "cuadrilla-poc-ftth-es-mx";
export const VOCABULARY_VERSION = "v002";
/** Key in the `Seed` bucket; Transcribe requires the `.txt` extension for a table file. */
export const VOCABULARY_OBJECT_KEY = `transcribe/vocabulary-${VOCABULARY_VERSION}.txt`;
export const VOCABULARY_CONTENT_TYPE = "text/plain; charset=utf-8";
export const VOCABULARY_HEADER = ["Phrase", "SoundsLike", "IPA", "DisplayAs"] as const;

export interface VocabularyRow {
  readonly phrase: string;
  /** Written form in the transcript; empty keeps the phrase as is. */
  readonly displayAs?: string;
}

export const VOCABULARY_ROWS: readonly VocabularyRow[] = [
  // Acronyms spelled out letter by letter, as the Spanish names of the letters.
  { phrase: "o-ene-u", displayAs: "ONU" },
  { phrase: "o-ene-te", displayAs: "ONT" },
  { phrase: "o-ele-te", displayAs: "OLT" },
  { phrase: "pe-o-ene", displayAs: "PON" },
  { phrase: "ge-pe-o-ene", displayAs: "GPON" },
  { phrase: "ele-o-ese", displayAs: "LOS" },
  { phrase: "ese-ce-a-pe-ce", displayAs: "SC/APC" },
  { phrase: "de-be-eme", displayAs: "dBm" },
  { phrase: "luz-pe-o-ene", displayAs: "luz PON" },
  // Phrases of several words.
  { phrase: "luz-roja", displayAs: "luz roja" },
  { phrase: "medidor-de-potencia", displayAs: "medidor de potencia" },
  { phrase: "potencia-óptica", displayAs: "potencia óptica" },
  { phrase: "caja-terminal", displayAs: "caja terminal" },
  { phrase: "patch-cord", displayAs: "patch cord" },
  { phrase: "limpiador-de-un-clic", displayAs: "limpiador de un clic" },
  { phrase: "localizador-visual", displayAs: "localizador visual" },
  { phrase: "catorce-noventa", displayAs: "1490" },
  { phrase: "mil-cuatrocientos-noventa", displayAs: "1490" },
  // Single words of the trade.
  { phrase: "roseta" },
  { phrase: "drop" },
  { phrase: "acometida" },
  { phrase: "conector" },
  { phrase: "fusión" },
  { phrase: "fusionadora" },
  { phrase: "empalme" },
  { phrase: "parpadea" },
  { phrase: "cordón" },
  { phrase: "pigtail" },
  { phrase: "splitter" },
  { phrase: "eliminador" },
  { phrase: "férula" },
];

/** One row of the table: exactly four TAB-separated columns, SoundsLike and IPA empty. */
export function vocabularyLine(row: VocabularyRow): string {
  return [row.phrase, "", "", row.displayAs ?? ""].join("\t");
}

/** The file Transcribe reads: header and rows separated by LF, no trailing empty row. */
export function vocabularyFile(rows: readonly VocabularyRow[] = VOCABULARY_ROWS): string {
  return [VOCABULARY_HEADER.join("\t"), ...rows.map(vocabularyLine)].join("\n");
}
