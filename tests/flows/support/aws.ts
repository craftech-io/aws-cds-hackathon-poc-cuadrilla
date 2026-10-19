// What a local world answers where the stage calls AWS (docs/test-plan.md §2, level LF), at the level of
// the SDK call each client makes, so every client of the product runs as it does in a Lambda:
//
//   guardrails  `ApplyGuardrail` of G1 (input) and G2 (output). G1 blocks the denied topics of
//               infra/guardrail-policies.ts by their words and a prompt attack by its phrases; G2 passes
//               with fixed scores unless a test scripts the next verdicts. Every input is recorded.
//   SES         `SendEmail` recorded with its message id; `events()` answers what the SES mailbox
//               simulator answers to each address (`success+` delivers, `bounce+` bounces for good,
//               `complaint+` complains), as EventBridge would deliver it.
//   Knowledge   `Retrieve` over the manual's sections (scripts/seed/data/manual/v001) by the words of the
//               query (a plural matching its singular), weighted by how rare each word is in the manual;
//               `outage` throws as Bedrock does.
//   Transcribe  the fake of media/testing.ts writing the transcript of the voice notes' datasheet
//               (scripts/seed/audio/datasheet.json), found by the bytes of the note it is asked for.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ApplyGuardrailCommandInput, ApplyGuardrailCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { RetrieveCommandInput, RetrieveCommandOutput } from "@aws-sdk/client-bedrock-agent-runtime";
import type { SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import type { StartTranscriptionJobCommandInput } from "@aws-sdk/client-transcribe";
import { DENIED_TOPICS, GROUNDING_FILTERS } from "../../../infra/guardrail-policies";
import { localTranscribeConfig } from "../../../packages/bff/src/media/config";
import { type FakeJobScript, type FakeTranscribe, createFakeTranscribe } from "../../../packages/bff/src/media/testing";
import { type FlowObjects, LOCAL_BUCKETS } from "./objects";

const ROOT = join(import.meta.dirname, "../../..");
const MANUAL_DIR = join(ROOT, "scripts/seed/data/manual/v001");

// ---- Guardrails ---------------------------------------------------------------------------------

/** Words that make G1 block each denied topic (the definitions and examples of DENIED_TOPICS). */
const TOPIC_WORDS: Readonly<Record<string, readonly string[]>> = {
  PRICING: ["descuento", "promocion", "precio del plan", "cuanto cuesta al mes"],
  CUSTOMER_COMPENSATION: ["regalo un mes", "mes gratis", "bonific", "reembolso", "de regalo"],
  ELECTRICAL_WORK: ["tablero", "contacto nuevo", "cables de luz del cliente", "pastilla"],
};
const PROMPT_ATTACKS = ["ignora tus instrucciones", "ignora las instrucciones", "olvida tus reglas"];

export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export interface G2Script {
  readonly grounding?: number;
  readonly relevance?: number;
}

export interface GuardrailFake {
  /** `ApplyGuardrail` as `BedrockRuntimeClient.send` answers it. */
  send(command: { readonly input: ApplyGuardrailCommandInput }): Promise<ApplyGuardrailCommandOutput>;
  readonly g1Inputs: string[];
  /** What G2 was asked: the query, the guarded text and the grounding source. */
  readonly g2Inputs: Array<{ readonly query: string; readonly text: string; readonly source: string }>;
  /** The next G2 verdicts, in order; every other check passes. */
  readonly g2Next: G2Script[];
}

export const LOCAL_G1 = { id: "cuadrilla-local-g1", version: "1" } as const;
export const LOCAL_G2 = {
  id: "cuadrilla-local-g2",
  version: "1",
  groundingThreshold: GROUNDING_FILTERS.find((filter) => filter.type === "GROUNDING")?.threshold ?? 0.75,
  relevanceThreshold: GROUNDING_FILTERS.find((filter) => filter.type === "RELEVANCE")?.threshold ?? 0.5,
  queryMaxChars: 1_000,
  groundingSourceMaxChars: 100_000,
  contentMaxChars: 5_000,
} as const;

function g1Answer(text: string): ApplyGuardrailCommandOutput {
  const folded = fold(text);
  const topics = DENIED_TOPICS.filter((topic) => (TOPIC_WORDS[topic.name] ?? []).some((word) => folded.includes(word))).map((topic) => ({ name: topic.name, type: "DENY" as const, action: "BLOCKED" as const }));
  const attack = PROMPT_ATTACKS.some((phrase) => folded.includes(phrase));
  const intervened = topics.length > 0 || attack;
  return {
    $metadata: {},
    action: intervened ? "GUARDRAIL_INTERVENED" : "NONE",
    outputs: intervened ? [{ text: "CUADRILLA_GUARDRAIL_G1_INPUT_BLOCKED" }] : [],
    assessments: intervened ? [{ ...(topics.length > 0 ? { topicPolicy: { topics } } : {}), ...(attack ? { contentPolicy: { filters: [{ type: "PROMPT_ATTACK", confidence: "HIGH", action: "BLOCKED" }] } } : {}) }] : [],
    usage: undefined,
  } as unknown as ApplyGuardrailCommandOutput;
}

function g2Answer(script: G2Script): ApplyGuardrailCommandOutput {
  const grounding = script.grounding ?? 0.92;
  const relevance = script.relevance ?? 0.81;
  const blocked = grounding < LOCAL_G2.groundingThreshold || relevance < LOCAL_G2.relevanceThreshold;
  const filter = (type: "GROUNDING" | "RELEVANCE", score: number, threshold: number) => ({ type, threshold, score, action: score < threshold ? "BLOCKED" : "NONE" });
  return {
    $metadata: {},
    action: blocked ? "GUARDRAIL_INTERVENED" : "NONE",
    outputs: [],
    assessments: [{ contextualGroundingPolicy: { filters: [filter("GROUNDING", grounding, LOCAL_G2.groundingThreshold), filter("RELEVANCE", relevance, LOCAL_G2.relevanceThreshold)] } }],
    usage: undefined,
  } as unknown as ApplyGuardrailCommandOutput;
}

export function guardrailFake(): GuardrailFake {
  const fake: GuardrailFake = {
    g1Inputs: [],
    g2Inputs: [],
    g2Next: [],
    async send(command) {
      const { input } = command;
      const blocks = input.content ?? [];
      if (input.guardrailIdentifier === LOCAL_G1.id) {
        const text = blocks.map((block) => block.text?.text ?? "").join("\n");
        fake.g1Inputs.push(text);
        return g1Answer(text);
      }
      if (input.guardrailIdentifier !== LOCAL_G2.id) throw new Error(`a local world has no guardrail ${input.guardrailIdentifier}`);
      const part = (qualifier: string) => blocks.find((block) => block.text?.qualifiers?.includes(qualifier as never))?.text?.text ?? "";
      fake.g2Inputs.push({ query: part("query"), text: part("guard_content"), source: part("grounding_source") });
      return g2Answer(fake.g2Next.shift() ?? {});
    },
  };
  return fake;
}

// ---- SES ----------------------------------------------------------------------------------------

export interface SentEmail {
  readonly messageId: string;
  readonly input: SendEmailCommandInput;
  readonly to: string;
  readonly tags: Readonly<Record<string, string>>;
  /** Real instant SES took it. */
  readonly atReal: string;
}

export interface SesFake {
  send(command: { readonly input: SendEmailCommandInput }): Promise<{ readonly MessageId: string; readonly $metadata: object }>;
  readonly sent: SentEmail[];
  /** The EventBridge events the SES simulator produces for the mails not yet answered, oldest first. */
  events(): unknown[];
}

function outcomeOf(address: string): { readonly eventType: string; readonly extra: Record<string, unknown> } {
  const local = address.split("@")[0] ?? "";
  if (local.startsWith("bounce")) return { eventType: "Bounce", extra: { bounce: { bounceType: "Permanent", bounceSubType: "General" } } };
  if (local.startsWith("complaint")) return { eventType: "Complaint", extra: { complaint: { complaintFeedbackType: "abuse" } } };
  return { eventType: "Delivery", extra: { delivery: {} } };
}

export function sesFake(now: () => Date): SesFake {
  const sent: SentEmail[] = [];
  let answered = 0;
  return {
    sent,
    async send(command) {
      const { input } = command;
      const messageId = `0100019a-local-${String(sent.length + 1).padStart(6, "0")}`;
      const tags = Object.fromEntries((input.EmailTags ?? []).map((tag) => [tag.Name ?? "", tag.Value ?? ""]));
      sent.push({ messageId, input, to: input.Destination?.ToAddresses?.[0] ?? "", tags, atReal: now().toISOString() });
      return { MessageId: messageId, $metadata: {} };
    },
    events() {
      const pending = sent.slice(answered);
      answered = sent.length;
      return pending.map((mail) => {
        const { eventType, extra } = outcomeOf(mail.to);
        const time = now().toISOString();
        const tags = Object.fromEntries([...Object.entries(mail.tags).map(([name, value]) => [name, [value]] as const), ["ses:configuration-set", [mail.input.ConfigurationSetName ?? ""]] as const]);
        const stamped = Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, { ...(value as object), timestamp: time }]));
        return { source: "aws.ses", "detail-type": eventType, time, detail: { eventType, mail: { timestamp: mail.atReal, messageId: mail.messageId, tags }, ...stamped } };
      });
    },
  };
}

// ---- Knowledge Base -----------------------------------------------------------------------------

interface Section {
  readonly sectionId: string;
  readonly text: string;
  readonly words: ReadonlySet<string>;
  readonly metadata: Record<string, unknown>;
}

const STOPWORDS = new Set(
  "el la los las un una unos unas de del al a en y o u que se le lo me te mi tu su sus es son por para con sin como cuando donde mas pero si no ya hay este esta esto ese esa eso qué cual cuál cuanto muy".split(" "),
);

/**
 * A word and its plural as one term, as the Knowledge Base's embeddings read them ("mueble" finds "muebles",
 * "conector" finds "conectores", "poste" finds "postes"): a final "s", then a final "e" after a consonant,
 * only past four letters. Number only: no verb or gender endings, which would merge different words.
 */
export function singularOf(word: string): string {
  const base = word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word;
  return base.length > 4 && /[^aeiou]e$/.test(base) ? base.slice(0, -1) : base;
}

function wordsOf(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
    .map(singularOf);
}

let sections: Section[] | undefined;

/** The manual's sections and their sidecars, as the Knowledge Base ingested them. */
export function manualSections(): Section[] {
  sections ??= readdirSync(MANUAL_DIR)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const text = readFileSync(join(MANUAL_DIR, file), "utf8");
      const metadata = (JSON.parse(readFileSync(join(MANUAL_DIR, `${file}.metadata.json`), "utf8")) as { metadataAttributes: Record<string, unknown> }).metadataAttributes;
      return { sectionId: String(metadata.sectionId), text, words: new Set(wordsOf(text)), metadata };
    });
  return sections;
}

export interface KnowledgeFake {
  send(input: RetrieveCommandInput): Promise<RetrieveCommandOutput>;
  readonly queries: string[];
  /** While true, `Retrieve` fails as Bedrock does when it is down (FL-034). */
  outage: boolean;
}

/** Score of a section for a query: the weight of the query's words it contains over the weight of all of them. */
function scoreOf(query: readonly string[], section: Section, all: readonly Section[]): number {
  const weight = (word: string) => Math.log((all.length + 1) / (1 + all.filter((candidate) => candidate.words.has(word)).length));
  const total = query.reduce((sum, word) => sum + weight(word), 0);
  if (total <= 0) return 0;
  return query.filter((word) => section.words.has(word)).reduce((sum, word) => sum + weight(word), 0) / total;
}

/** The category of `retrievalFilter` (knowledge/client.ts), when the search asked for one. */
function categoryOf(input: RetrieveCommandInput): string | undefined {
  const filter = input.retrievalConfiguration?.vectorSearchConfiguration?.filter as { andAll?: Array<{ equals?: { key?: string; value?: unknown } }> } | undefined;
  const value = filter?.andAll?.find((term) => term.equals?.key === "category")?.equals?.value;
  return typeof value === "string" ? value : undefined;
}

export function knowledgeFake(): KnowledgeFake {
  const fake: KnowledgeFake = {
    queries: [],
    outage: false,
    async send(input) {
      const query = input.retrievalQuery?.text ?? "";
      fake.queries.push(query);
      if (fake.outage) throw Object.assign(new Error("Service unavailable"), { name: "InternalServerException" });
      const words = [...new Set(wordsOf(query))];
      const category = categoryOf(input);
      const all = manualSections();
      const ranked = all
        .filter((section) => category === undefined || section.metadata.category === category)
        .map((section) => ({ section, score: scoreOf(words, section, all) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || (a.section.sectionId < b.section.sectionId ? -1 : 1))
        .slice(0, 5);
      return {
        $metadata: {},
        retrievalResults: ranked.map(({ section, score }) => ({ content: { text: section.text, type: "TEXT" }, score: Math.round(score * 1000) / 1000, metadata: section.metadata as never })),
      } as RetrieveCommandOutput;
    },
  };
  return fake;
}

// ---- Transcribe ---------------------------------------------------------------------------------

interface VoiceNote {
  readonly voiceId: string;
  readonly sha256: string;
  readonly transcript: { readonly text: string; readonly confidence: number };
}

let voices: VoiceNote[] | undefined;

/** The 12 voice notes of the datasheet (docs/seed-spec.md §11). */
export function voiceNotes(): VoiceNote[] {
  voices ??= (JSON.parse(readFileSync(join(ROOT, "scripts/seed/audio/datasheet.json"), "utf8")) as { notes: VoiceNote[] }).notes;
  return voices;
}

export function voiceBytes(voiceId: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, `scripts/seed/audio/${voiceId}.ogg`)));
}

/** The output bucket of the local Transcribe: the same `Media` bucket the notes are in. */
export const LOCAL_TRANSCRIBE_CONFIG = localTranscribeConfig(LOCAL_BUCKETS.Media);

/** Transcribe in process: the datasheet's transcript of the note whose bytes the job names. */
export function transcribeFake(objects: FlowObjects): FakeTranscribe {
  const script = (input: StartTranscriptionJobCommandInput): FakeJobScript => {
    const uri = input.Media?.MediaFileUri ?? "";
    const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
    const bytes = match === null ? undefined : objects.bytesOf("Media", match[2] ?? "");
    const sha = bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex");
    const note = voiceNotes().find((candidate) => candidate.sha256 === sha);
    if (note === undefined) return "FAILED";
    return { text: note.transcript.text, confidence: note.transcript.confidence };
  };
  return createFakeTranscribe({ objects: objects.mediaObjects, config: LOCAL_TRANSCRIBE_CONFIG, script, pollsBeforeDone: 0 });
}
