import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GUARDRAIL_KINDS, GUARDRAIL_REGEXES, SENSITIVE_KINDS, maskText } from "../packages/bff/src/lib/mask";
import { detectLanguage } from "../packages/bff/src/services/language/language";
import {
  BLOCKED_MESSAGES,
  CONTENT_FILTERS,
  DENIED_TOPICS,
  DOCUMENT_REGEXES,
  G1_PII_ENTITIES,
  G1_POLICIES,
  G2_LIMITS,
  G2_POLICIES,
  G3_PII_ENTITIES,
  G3_POLICIES,
  GROUNDING_FILTERS,
  GUARDRAIL_POLICIES,
  GUARDRAIL_TIER,
  guardrailDigest,
  type GuardrailKey,
} from "./guardrail-policies";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

// Bedrock limits of a denied topic (CLASSIC tier) and of a custom regex.
const NAME = /^[0-9a-zA-Z-_ !?.]+$/;
const KEYS: readonly GuardrailKey[] = ["g1", "g2", "g3"];

/** The quoted texts of every "Disparador" line of docs/flows-catalog.md (what an installer or a supervisor writes). */
function catalogTexts(flowId?: string): string[] {
  const catalog = read("docs/flows-catalog.md");
  const scope = flowId === undefined ? catalog : catalog.slice(catalog.indexOf(`### ${flowId} ·`)).split("\n### ")[0] ?? "";
  return scope
    .split("\n")
    .filter((line) => line.includes("Disparador:"))
    .flatMap((line) => [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? ""));
}

/** The 50 questions of the evaluation set (docs/seed-spec.md §9). */
function evaluationQuestions(): string[] {
  return [...read("docs/seed-spec.md").matchAll(/^\| `q-[AR]-\d{2}` \| ([^|]+) \|/gm)].map((match) => (match[1] ?? "").trim());
}

// Where the texts that reach the normalizer live, now or once their work package lands: channel
// fixtures, every text of copy/, the seed data and datasheets, the scenario, evaluation and local-flow
// texts and the QA cases. A directory that does not exist yet contributes nothing.
const CORPUS_ROOTS = ["packages/bff/src/channels", "packages/bff/src/copy", "scripts/seed/data", "scripts/seed/audio", "scripts/scenarios", "scripts/evaluation", "tests/flows", "tests/cases"];
const CORPUS_FILE = /\.(eml|json|txt|md|ts)$/;

function corpusFiles(path: string, out: string[] = []): string[] {
  let stats;
  try {
    stats = statSync(resolve(ROOT, path));
  } catch {
    return out;
  }
  if (stats.isDirectory()) {
    for (const entry of readdirSync(resolve(ROOT, path))) if (entry !== "node_modules") corpusFiles(join(path, entry), out);
  } else if (CORPUS_FILE.test(path)) out.push(path);
  return out;
}

const regexesOf = (key: "g1" | "g3"): RegExp[] => (GUARDRAIL_POLICIES[key].sensitiveInformationPolicyConfig?.regexesConfigs ?? []).map((regex) => new RegExp(regex.pattern));
const fires = (key: "g1" | "g3", text: string): boolean => regexesOf(key).some((regex) => regex.test(text));
/** What channels/normalizer.ts does to every inbound text and transcript (packages/bff/src/lib/mask.ts). */
const normalize = (text: string): string => maskText(text, SENSITIVE_KINDS);
const comparable = (text: string): string => text.toLowerCase().replace(/[^a-záéíóúüñ0-9]+/g, " ").trim();

describe("[FL-032] denied topics: G1 on input and output, G2 on the outbound text", () => {
  it("declares PRICING, CUSTOMER_COMPENSATION and ELECTRICAL_WORK in the order of FL-032, within the Bedrock limits", () => {
    const rules = read("docs/flows-catalog.md").split("### FL-032 ·")[1]?.split("\n").find((line) => line.startsWith("- Reglas:")) ?? "";
    expect(DENIED_TOPICS.map((topic) => topic.name)).toEqual([...rules.matchAll(/`([A-Z_]+)`/g)].map((match) => match[1]));
    expect(DENIED_TOPICS.map((topic) => topic.name)).toEqual(["PRICING", "CUSTOMER_COMPENSATION", "ELECTRICAL_WORK"]);
    for (const topic of DENIED_TOPICS) {
      expect(topic.name).toMatch(NAME);
      expect(topic.name.length).toBeLessThanOrEqual(100);
      expect(topic.definition.length, topic.name).toBeLessThanOrEqual(200);
      const examples = [...topic.examples.es, ...topic.examples.en];
      expect(examples.length, topic.name).toBeLessThanOrEqual(5);
      for (const example of examples) expect(example.length, example).toBeLessThanOrEqual(100);
    }
  });

  it("writes every definition and example in Mexican Spanish with an English gloss", () => {
    for (const topic of DENIED_TOPICS) {
      const gloss = /^(.+) \((.+)\)\.$/.exec(topic.definition);
      expect(gloss, `${topic.name}: "<es> (<en>)."`).not.toBeNull();
      expect(detectLanguage(gloss?.[1] ?? "").language, topic.name).toBe("es");
      expect(detectLanguage(gloss?.[2] ?? "").language, topic.name).toBe("en");
      expect(topic.examples.es.length, topic.name).toBeGreaterThanOrEqual(2);
      expect(topic.examples.en.length, topic.name).toBeGreaterThanOrEqual(2);
      for (const example of topic.examples.es) expect(detectLanguage(example).language, example).toBe("es");
      for (const example of topic.examples.en) expect(detectLanguage(example).language, example).toBe("en");
    }
  });

  it("never uses as an example a text the tests or the evaluation send, so they measure generalization", () => {
    const triggers = catalogTexts("FL-032");
    expect(triggers).toHaveLength(3);
    const questions = evaluationQuestions();
    expect(questions).toHaveLength(50);
    const inputs = new Set([...catalogTexts(), ...questions].map(comparable));
    for (const example of DENIED_TOPICS.flatMap((topic) => [...topic.examples.es, ...topic.examples.en])) expect(inputs.has(comparable(example)), example).toBe(false);
  });

  it("sends the same DENY topics to G1 and G2 on the CLASSIC tier", () => {
    const topics = G1_POLICIES.topicPolicyConfig;
    expect(G2_POLICIES.topicPolicyConfig).toBe(topics);
    expect(GUARDRAIL_TIER).toBe("CLASSIC");
    expect(topics?.tierConfigs).toEqual([{ tierName: "CLASSIC" }]);
    expect(topics?.topicsConfigs).toEqual(
      DENIED_TOPICS.map((topic) => ({ name: topic.name, definition: topic.definition, examples: [...topic.examples.es, ...topic.examples.en], type: "DENY" })),
    );
  });
});

describe("G1 blocks only what the worker can classify (docs/architecture.md §9.1)", () => {
  it("sets prompt attack to HIGH on input and has no other content filter", () => {
    expect(CONTENT_FILTERS).toEqual([{ type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE" }]);
    expect(G1_POLICIES.contentPolicyConfig).toEqual({
      tierConfigs: [{ tierName: "CLASSIC" }],
      filtersConfigs: [{ type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE", inputModalities: ["TEXT"], outputModalities: ["TEXT"] }],
    });
  });

  it("can only block on a denied topic, a prompt attack or a card number", () => {
    const sensitive = G1_POLICIES.sensitiveInformationPolicyConfig;
    const blocking = [
      ...(G1_POLICIES.topicPolicyConfig?.topicsConfigs ?? []).map(() => "TOPIC"),
      ...(G1_POLICIES.contentPolicyConfig?.filtersConfigs ?? []).filter((filter) => filter.inputStrength !== "NONE" || filter.outputStrength !== "NONE").map((filter) => filter.type),
      ...[...(sensitive?.piiEntitiesConfigs ?? []), ...(sensitive?.regexesConfigs ?? [])]
        .filter((entry) => [entry.action, entry.inputAction, entry.outputAction].includes("BLOCK"))
        .map((entry) => ("type" in entry ? entry.type : entry.name)),
    ];
    expect([...new Set(blocking)].sort()).toEqual(["CREDIT_DEBIT_CARD_NUMBER", "PROMPT_ATTACK", "TOPIC"]);
    expect(Object.keys(G1_POLICIES).sort()).toEqual(["contentPolicyConfig", "sensitiveInformationPolicyConfig", "topicPolicyConfig"]);
  });
});

describe("PII: G1 is the second layer of the normalizer, G3 is PII only", () => {
  it("anonymizes CURP, RFC and CLABE with mask.ts's own regexes: on input in G1, on both sides in G3", () => {
    expect(DOCUMENT_REGEXES).toBe(GUARDRAIL_REGEXES);
    expect(DOCUMENT_REGEXES.map((regex) => regex.kind).sort()).toEqual([...GUARDRAIL_KINDS].sort());
    const entries = (input: string, output: string, outputEnabled: boolean) =>
      GUARDRAIL_REGEXES.map((regex) => ({ name: regex.name, description: regex.description, pattern: regex.pattern, action: input, inputAction: input, inputEnabled: true, outputAction: output, outputEnabled }));
    expect(G1_POLICIES.sensitiveInformationPolicyConfig?.regexesConfigs).toEqual(entries("ANONYMIZE", "NONE", false));
    expect(G3_POLICIES.sensitiveInformationPolicyConfig?.regexesConfigs).toEqual(entries("ANONYMIZE", "ANONYMIZE", true));
  });

  it("keeps no copy of a document regex in infra/", () => {
    for (const file of ["infra/guardrail-policies.ts", "infra/guardrail.ts"]) {
      const source = read(file);
      for (const token of ["[0-9]", "\\\\d", "\\\\b", "{6}", "{11}"]) expect(source.includes(token), `${file} contains ${token}`).toBe(false);
    }
    expect(read("infra/guardrail-policies.ts")).toContain('import { GUARDRAIL_REGEXES } from "../packages/bff/src/lib/mask";');
  });

  it("fits Bedrock's custom regex rules: named, short, no lookaround, no \\d", () => {
    for (const regex of DOCUMENT_REGEXES) {
      expect(regex.name).toMatch(NAME);
      expect(regex.name.length).toBeLessThanOrEqual(100);
      expect(regex.description.length).toBeLessThanOrEqual(1000);
      expect(regex.pattern.length).toBeLessThanOrEqual(500);
      for (const unsupported of ["(?=", "(?!", "(?<=", "(?<!", "\\d"]) expect(regex.pattern.includes(unsupported), `${regex.name}: ${unsupported}`).toBe(false);
    }
  });

  it("blocks cards in G1 and G3, leaves contacts alone in G1 and anonymizes them in G3", () => {
    expect(G1_PII_ENTITIES).toEqual([
      { type: "CREDIT_DEBIT_CARD_NUMBER", inputAction: "BLOCK", outputAction: "BLOCK" },
      { type: "EMAIL", inputAction: "NONE", outputAction: "NONE" },
      { type: "PHONE", inputAction: "NONE", outputAction: "NONE" },
    ]);
    expect(G3_PII_ENTITIES).toEqual([
      { type: "CREDIT_DEBIT_CARD_NUMBER", inputAction: "BLOCK", outputAction: "BLOCK" },
      { type: "EMAIL", inputAction: "ANONYMIZE", outputAction: "ANONYMIZE" },
      { type: "PHONE", inputAction: "ANONYMIZE", outputAction: "ANONYMIZE" },
    ]);
    for (const key of ["g1", "g3"] as const) {
      for (const entity of GUARDRAIL_POLICIES[key].sensitiveInformationPolicyConfig?.piiEntitiesConfigs ?? []) {
        expect(entity.action).toBe(entity.inputAction);
        expect([entity.inputEnabled, entity.outputEnabled]).toEqual([true, true]);
      }
    }
    expect(Object.keys(G3_POLICIES)).toEqual(["sensitiveInformationPolicyConfig"]);
  });

  it("has the normalizer mask every kind G1 anonymizes, first", () => {
    for (const kind of GUARDRAIL_KINDS) expect(SENSITIVE_KINDS).toContain(kind);
    for (const sample of ["mi CURP es TAMR800101MDFMZS09", "el RFC ABC010203XY9", "CLABE 002 180 70012345678 9"]) {
      expect(fires("g1", sample), sample).toBe(true);
      expect(fires("g1", normalize(sample)), sample).toBe(false);
    }
  });

  it("lets no normalized fixture, copy text, catalog trigger or evaluation question trigger a G1 regex", () => {
    const files = CORPUS_ROOTS.flatMap((root) => corpusFiles(root));
    expect(files.length).toBeGreaterThan(0);
    const sources = [
      ...catalogTexts().map((text) => ({ source: `docs/flows-catalog.md "${text}"`, text })),
      ...evaluationQuestions().map((text) => ({ source: `docs/seed-spec.md "${text}"`, text })),
      ...files.map((file) => ({ source: file, text: read(file) })),
    ];
    expect(sources.filter(({ text }) => fires("g1", normalize(text))).map(({ source }) => source)).toEqual([]);
  });

  it("never rewrites the order facts the agent quotes and the certificate prints", () => {
    const serials = Array.from({ length: 64 }, (_, index) => `DEMO${((index * 0x9e3779b1) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`);
    const facts = [
      ...serials,
      "DEMO12345678",
      "DEMO3F2C19A0",
      "Orden 24817 (wo-24817, wo-24817-j03), cliente cust-10421, operadora isp-judge-07, instalador inst-rogelio",
      "Potencia −22,8 dBm a 1490 nm, clase B+ (de −8 a −25 dBm), puerto OLT-N3/1/4",
      "Manual v1, §DIAG-02 y §COM-04; foto ph-label-06, nota vn-01, pregunta q-A-14",
      "hoy 11:30 a 13:30 · 2026-10-13T09:20:00-06:00 · Fibra 100",
    ];
    for (const fact of facts) for (const key of ["g1", "g3"] as const) expect(fires(key, fact), `${key}: ${fact}`).toBe(false);
  });
});

describe("grounding (G2)", () => {
  it("uses grounding 0.75 and relevance 0.5 and nothing that rewrites the outbound text", () => {
    expect(GROUNDING_FILTERS).toEqual([
      { type: "GROUNDING", threshold: 0.75 },
      { type: "RELEVANCE", threshold: 0.5 },
    ]);
    expect(G2_POLICIES.contextualGroundingPolicyConfig?.filtersConfigs).toEqual([...GROUNDING_FILTERS]);
    expect(Object.keys(G2_POLICIES).sort()).toEqual(["contextualGroundingPolicyConfig", "topicPolicyConfig"]);
  });

  it("states the input limits of docs/architecture.md §9.4", () => {
    expect(G2_LIMITS).toEqual({ queryMaxChars: 1_000, groundingSourceMaxChars: 100_000, contentMaxChars: 5_000 });
  });
});

describe("versions and blocked messages", () => {
  it("publishes a new version whenever a policy or a blocked message changes", () => {
    const digests = KEYS.map((key) => guardrailDigest(GUARDRAIL_POLICIES[key], BLOCKED_MESSAGES[key]));
    for (const digest of digests) expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(digests).size).toBe(3);
    expect(guardrailDigest(structuredClone(G2_POLICIES), BLOCKED_MESSAGES.g2)).toBe(digests[1]);
    const changed = { ...G2_POLICIES, contextualGroundingPolicyConfig: { filtersConfigs: [{ type: "GROUNDING", threshold: 0.7 }] } };
    expect(guardrailDigest(changed, BLOCKED_MESSAGES.g2)).not.toBe(digests[1]);
    expect(guardrailDigest(G2_POLICIES, { ...BLOCKED_MESSAGES.g2, output: "OTHER" })).not.toBe(digests[1]);
  });

  it("uses sentinels that name their guardrail and could never pass the outbound language check", () => {
    const messages = KEYS.flatMap((key) => [BLOCKED_MESSAGES[key].input, BLOCKED_MESSAGES[key].output]);
    expect(new Set(messages).size).toBe(6);
    for (const key of KEYS) for (const message of Object.values(BLOCKED_MESSAGES[key])) expect(message).toContain(`_${key.toUpperCase()}_`);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(500);
      expect(detectLanguage(message).language).toBe("und");
    }
  });
});
