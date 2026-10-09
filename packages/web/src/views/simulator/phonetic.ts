// Pronunciation help of the guest's kit (docs/architecture-integrations.md §4.4.1): the Spanish of the
// script respelled for someone who reads English, so a guest who does not speak Spanish can record the
// story's lines from a real phone. A plain, rule-based respelling (Latin American Spanish: "c"/"z" as
// "s", "ll"/"y" as "y", silent "h"), syllables split by hyphens, the stressed syllable in capitals.
// No React here: phonetic.test.ts.

const VOWELS = "aeiouáéíóú";
const ACCENTED: Readonly<Record<string, string>> = { á: "a", é: "e", í: "i", ó: "o", ú: "u", ü: "u" };
const SOUND: Readonly<Record<string, string>> = { a: "ah", e: "eh", i: "ee", o: "oh", u: "oo" };
/** Consonant pairs that start a syllable together. */
const ONSETS: ReadonlySet<string> = new Set(["bl", "br", "cl", "cr", "dr", "fl", "fr", "gl", "gr", "pl", "pr", "tr", "ch", "ll", "rr", "qu", "gu"]);

const isVowel = (char: string | undefined) => char !== undefined && VOWELS.includes(char);

/** Syllables of one lowercase word (a simple split: enough for a reading aid). */
export function syllables(word: string): string[] {
  const result: string[] = [];
  let current = "";
  let index = 0;
  while (index < word.length) {
    const char = word[index] ?? "";
    current += char;
    if (isVowel(char)) {
      // Diphthongs stay together: a weak vowel (i, u) next to another vowel without an accent mark.
      while (isVowel(word[index + 1]) && ("iu".includes(char) || "iu".includes(word[index + 1] ?? ""))) {
        index += 1;
        current += word[index];
      }
      let consonants = "";
      let ahead = index + 1;
      while (ahead < word.length && !isVowel(word[ahead])) consonants += word[ahead++];
      if (ahead >= word.length) {
        current += consonants;
        index = ahead;
        break;
      }
      const keep = consonants.length <= 1 ? 0 : ONSETS.has(consonants.slice(-2)) ? consonants.length - 2 : consonants.length - 1;
      current += consonants.slice(0, keep);
      result.push(current);
      current = "";
      index += 1 + keep;
      continue;
    }
    index += 1;
  }
  if (current !== "") result.push(current);
  return result;
}

/** Index of the stressed syllable: the accent mark, else the second to last before n, s or a vowel, else the last. */
function stressOf(word: string, parts: readonly string[]): number {
  const marked = parts.findIndex((part) => /[áéíóú]/.test(part));
  if (marked !== -1) return marked;
  if (parts.length < 2) return 0;
  return /[aeiouns]$/.test(word) ? parts.length - 2 : parts.length - 1;
}

/** One syllable respelled for an English reader: "pié" → "pyeh", "que" → "keh", "ge" → "heh". */
export function respell(syllable: string): string {
  const plain = syllable
    .split("")
    .map((char) => ACCENTED[char] ?? char)
    .join("");
  const text = plain
    .replace(/qu([ei])/g, "k$1")
    .replace(/g([ei])/g, "\u0002$1")
    .replace(/gu([ei])/g, "g$1")
    .replace(/c([ei])/g, "s$1")
    .replace(/ll/g, "y")
    .replace(/ch/g, "\u0001")
    .replace(/h/g, "")
    .replace(/ñ/g, "ny")
    .replace(/j/g, "\u0002")
    .replace(/z/g, "s")
    .replace(/c/g, "k")
    .replace(/v/g, "b")
    .replace(/x/g, "ks")
    .replace(/\u0001/g, "ch")
    .replace(/\u0002/g, "h")
    // A weak vowel before another vowel glides: "pie" → "pye", "cuento" → "kwento".
    .replace(/i(?=[aeou])/g, "y")
    .replace(/u(?=[aeio])/g, "w");
  const last = text.at(-1);
  return last !== undefined && SOUND[last] !== undefined ? `${text.slice(0, -1)}${SOUND[last]}` : text;
}

/** "Ya limpié el conector" → "yah lim-PYEH el koh-nek-TOR". */
export function phoneticOf(text: string): string {
  return text
    .toLowerCase()
    .split(/(\s+)/)
    .map((token) => {
      const match = /^([^a-záéíóúüñ]*)([a-záéíóúüñ]+)([^a-záéíóúüñ]*)$/.exec(token);
      if (match === null) return token;
      const [, before = "", word = "", after = ""] = match;
      const parts = syllables(word);
      const stress = stressOf(word, parts);
      const spelled = parts.map((part, index) => {
        const sound = respell(part);
        return parts.length > 1 && index === stress ? sound.toUpperCase() : sound;
      });
      return `${before}${spelled.join("-")}${after}`;
    })
    .join("");
}
