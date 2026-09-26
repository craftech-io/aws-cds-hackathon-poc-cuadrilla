// infra/media.ts only evaluates inside the SST program ($app, sst, aws, $util, $interpolate), so this
// test evaluates it against a recording fake of those globals: every component it creates is kept with
// its arguments and options, and every Output is a promise the test resolves. What is asserted is the
// file Transcribe reads, the vocabulary it builds from it and the statements the worker receives.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VOCABULARY_HEADER, VOCABULARY_NAME, VOCABULARY_OBJECT_KEY, VOCABULARY_ROWS, VOCABULARY_VERSION, vocabularyFile } from "../packages/bff/src/copy/transcribe-vocabulary";
import { browserBucketName, bucketPrefix } from "./ci-spec";
import { CAPABILITIES, IAM_ARNS, LAMBDA_CAPABILITIES, TRANSCRIBE_PREFIX, expectedActions, type LambdaName } from "./iam-capabilities";
import { BUCKET_SPECS, MEDIA_TRANSCRIPTS_PREFIX, TRANSCRIPTS_RETENTION_DAYS, lifecycleRules } from "./storage-keys";

const APP = "aws-cds-hackathon-poc-cuadrilla";
const ACCOUNT = "776805327629";
const SEED_BUCKET = browserBucketName(APP, "poc", "seed", ACCOUNT);
const MEDIA_BUCKET = browserBucketName(APP, "poc", "media", ACCOUNT);
const MEDIA_ARN = `arn:aws:s3:::${MEDIA_BUCKET}`;

// ---- A recording SST runtime ----------------------------------------------------------------------

class FakeOutput {
  readonly promise: Promise<unknown>;
  constructor(promise: Promise<unknown>) {
    this.promise = promise;
    promise.catch(() => undefined);
  }
  apply(fn: (value: never) => unknown): FakeOutput {
    return new FakeOutput(this.promise.then((value) => settle(fn(value as never))));
  }
}
const settle = (value: unknown): unknown => (value instanceof FakeOutput ? value.promise : value);
const output = (value: unknown): FakeOutput => (value instanceof FakeOutput ? value : new FakeOutput(Promise.resolve(value).then(settle)));

interface Created {
  readonly type: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly opts: { dependsOn?: unknown[] } | undefined;
  readonly instance: object;
}

function fakeRuntime() {
  const created: Created[] = [];
  const recorder = (type: string, outputs: (args: Record<string, unknown>) => Record<string, unknown> = () => ({})) =>
    class {
      constructor(name: string, args: Record<string, unknown>, opts?: { dependsOn?: unknown[] }) {
        Object.assign(this, outputs(args));
        created.push({ type, name, args, opts, instance: this });
      }
    };
  const sst = {
    Linkable: recorder("sst.Linkable"),
    aws: { permission: (input: object) => ({ type: "aws.permission", ...input }) },
  };
  const aws = {
    s3: {
      BucketObjectv2: recorder("aws.s3.BucketObjectv2", (args) => ({ key: output(args.key), bucket: output(args.bucket) })),
      BucketLifecycleConfiguration: recorder("aws.s3.BucketLifecycleConfiguration"),
    },
    transcribe: {
      Vocabulary: recorder("aws.transcribe.Vocabulary", (args) => ({
        vocabularyName: output(args.vocabularyName),
        arn: output(`arn:aws:transcribe:us-east-1:${ACCOUNT}:vocabulary/${String(args.vocabularyName)}`),
      })),
    },
  };
  const util = { output, all: (values: unknown[]) => new FakeOutput(Promise.all(values.map((value) => output(value).promise))) };
  const interpolate = (strings: TemplateStringsArray, ...values: unknown[]) =>
    new FakeOutput(Promise.all(values.map((value) => output(value).promise)).then((parts) => strings.reduce((text, piece, i) => `${text}${piece}${i < parts.length ? String(parts[i]) : ""}`, "")));
  return { sst, aws, util, interpolate, created };
}

async function resolveDeep(value: unknown): Promise<unknown> {
  if (value instanceof FakeOutput) return resolveDeep(await value.promise);
  if (Array.isArray(value)) return Promise.all(value.map(resolveDeep));
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = await Promise.all(Object.entries(value).map(async ([key, inner]) => [key, await resolveDeep(inner)] as const));
    return Object.fromEntries(entries);
  }
  return value;
}

const bucket = (name: string) => ({ name: output(name), arn: output(`arn:aws:s3:::${name}`) });
const BUCKETS = { Media: bucket(MEDIA_BUCKET), Evidence: bucket("evidence"), Manual: bucket("manual"), Seed: bucket(SEED_BUCKET) };

async function evaluate() {
  const runtime = fakeRuntime();
  vi.resetModules();
  vi.stubGlobal("$app", { name: APP, stage: "poc" });
  vi.stubGlobal("sst", runtime.sst);
  vi.stubGlobal("aws", runtime.aws);
  vi.stubGlobal("$util", runtime.util);
  vi.stubGlobal("$interpolate", runtime.interpolate);
  // infra/storage.ts is real (it resolves `{Media}`, `{Media.name}`); only its resources are fakes.
  vi.doMock("./storage-tables", () => ({ tables: {} }));
  vi.doMock("./storage-buckets", () => ({ buckets: BUCKETS, mediaBucket: BUCKETS.Media, evidenceBucket: BUCKETS.Evidence, manualBucket: BUCKETS.Manual, seedBucket: BUCKETS.Seed }));
  const module = await import("./media");
  const only = (type: string): Created => {
    const matching = runtime.created.filter((entry) => entry.type === type);
    expect(matching, type).toHaveLength(1);
    return matching[0] as Created;
  };
  return { ...runtime, module, only };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("./storage-tables");
  vi.doUnmock("./storage-buckets");
  vi.doUnmock("../packages/bff/src/copy/transcribe-vocabulary");
});

const integrations = readFileSync(resolve(process.cwd(), "docs/architecture-integrations.md"), "utf8");
const architecture = readFileSync(resolve(process.cwd(), "docs/architecture.md"), "utf8");
const LAMBDAS = Object.keys(LAMBDA_CAPABILITIES) as LambdaName[];

// ---- Vocabulary file -------------------------------------------------------------------------------

describe("vocabulary file in Seed/transcribe/", () => {
  it("uploads the table-format text of copy/transcribe-vocabulary.ts to Seed/transcribe/vocabulary-v002.txt as UTF-8 plain text", async () => {
    const { only } = await evaluate();
    const file = only("aws.s3.BucketObjectv2");
    expect(await resolveDeep(file.args)).toEqual({
      bucket: SEED_BUCKET,
      key: "transcribe/vocabulary-v002.txt",
      content: vocabularyFile(),
      contentType: "text/plain; charset=utf-8",
    });
    expect(VOCABULARY_OBJECT_KEY).toBe(`transcribe/vocabulary-${VOCABULARY_VERSION}.txt`);
    expect(integrations).toContain("`Seed/transcribe/vocabulary-v002.txt`");
  });

  it("writes one header and one row per phrase, each with exactly three TABs and SoundsLike and IPA empty", async () => {
    const { only } = await evaluate();
    const content = only("aws.s3.BucketObjectv2").args.content as string;
    const lines = content.split("\n");
    expect(lines[0]).toBe(VOCABULARY_HEADER.join("\t"));
    expect(lines[0]).toBe("Phrase\tSoundsLike\tIPA\tDisplayAs");
    expect(lines).toHaveLength(VOCABULARY_ROWS.length + 1);
    for (const line of lines) expect(line.split("\t"), line).toHaveLength(4);
    for (const line of lines.slice(1)) {
      const [phrase, soundsLike, ipa] = line.split("\t");
      expect(phrase, line).not.toBe("");
      expect([soundsLike, ipa], line).toEqual(["", ""]);
    }
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(Buffer.from(content, "utf8").toString("utf8")).toBe(content);
  });

  it("keeps the file under Seed/transcribe/, the prefix the CI role reads with the rest of the app's buckets", () => {
    expect(BUCKET_SPECS.Seed.prefixes).toContain("transcribe/");
    expect(BUCKET_SPECS.Seed.naming).toEqual({ kind: "browser", purpose: "seed" });
    expect(SEED_BUCKET.startsWith(bucketPrefix(APP))).toBe(true);
    const template = readFileSync(resolve(process.cwd(), "infra/bootstrap/ci-role.yaml"), "utf8");
    expect(template).toContain('s3:::${BucketPrefix}*"');
  });
});

// ---- Vocabulary -------------------------------------------------------------------------------------

describe("Transcribe vocabulary cuadrilla-poc-ftth-es-mx", () => {
  it("creates it es-MX from the file's URI, after the file, with no inline phrases and no tags of its own", async () => {
    const { only } = await evaluate();
    const vocabulary = only("aws.transcribe.Vocabulary");
    expect(await resolveDeep(vocabulary.args)).toEqual({
      vocabularyName: "cuadrilla-poc-ftth-es-mx",
      languageCode: "es-MX",
      vocabularyFileUri: `s3://${SEED_BUCKET}/transcribe/vocabulary-v002.txt`,
    });
    expect(vocabulary.opts?.dependsOn).toEqual([only("aws.s3.BucketObjectv2").instance]);
    // The default tags of sst.config.ts are its only tags: the CI role tags it with the app's keys only.
    expect(vocabulary.args).not.toHaveProperty("tags");
    expect(vocabulary.args).not.toHaveProperty("phrases");
  });

  it("stays inside the vocabulary/cuadrilla-poc-* fence of the CI role and the boundary", async () => {
    const { module } = await evaluate();
    expect(VOCABULARY_NAME).toBe("cuadrilla-poc-ftth-es-mx");
    expect(VOCABULARY_NAME.startsWith(TRANSCRIBE_PREFIX)).toBe(true);
    const template = readFileSync(resolve(process.cwd(), "infra/bootstrap/ci-role.yaml"), "utf8");
    expect(template).toContain(`vocabulary/${TRANSCRIBE_PREFIX}*"`);
    expect(() => module.assertVocabularyFences("ftth-es-mx", VOCABULARY_OBJECT_KEY)).toThrow(/must start with cuadrilla-poc-/);
    expect(() => module.assertVocabularyFences(VOCABULARY_NAME, "worlds/vocabulary-v001.txt")).toThrow(/Seed\/transcribe\//);
    expect(() => module.assertVocabularyFences(VOCABULARY_NAME, "transcribe/vocabulary-v001.csv")).toThrow(/\.txt/);
  });

  it("pins the file of v002 by its sha256, so new rows need a new version (a new key the vocabulary picks up)", async () => {
    const { module } = await evaluate();
    const digest = createHash("sha256").update(vocabularyFile(), "utf8").digest("hex");
    expect(module.VOCABULARY_FILE_SHA256[VOCABULARY_VERSION]).toBe(digest);
    expect(() => module.assertVocabularyPinned(`${vocabularyFile()}\nsplice\t\t\t`, VOCABULARY_VERSION)).toThrow(/bump VOCABULARY_VERSION/);
    expect(() => module.assertVocabularyPinned(vocabularyFile(), "v003")).toThrow(/pinned in infra\/media\.ts \(none\)/);
  });

  it("fails the deploy when the rows change under the same version", async () => {
    vi.doMock("../packages/bff/src/copy/transcribe-vocabulary", async (importOriginal) => {
      const original = await importOriginal<typeof import("../packages/bff/src/copy/transcribe-vocabulary")>();
      return { ...original, vocabularyFile: () => `${original.vocabularyFile()}\nsplice\t\t\t` };
    });
    await expect(evaluate()).rejects.toThrow(/Transcribe vocabulary v002/);
  });
});

// ---- TRANSCRIBE -------------------------------------------------------------------------------------

describe("TRANSCRIBE capability through the Transcribe link", () => {
  it("carries the two Transcribe statements: Start on * fenced by the Media bucket and transcripts/*, Get/Delete by job ARN", async () => {
    const { only } = await evaluate();
    const include = (await resolveDeep(only("sst.Linkable").args.include)) as Array<Record<string, unknown>>;
    const transcribe = include.filter((statement) => (statement.actions as string[]).some((action) => action.startsWith("transcribe:")));
    expect(transcribe).toEqual([
      {
        type: "aws.permission",
        actions: ["transcribe:StartTranscriptionJob"],
        resources: ["*"],
        conditions: [
          { test: "StringEquals", variable: "transcribe:OutputBucketName", values: [MEDIA_BUCKET] },
          { test: "StringLike", variable: "transcribe:OutputKey", values: ["transcripts/*"] },
        ],
      },
      {
        type: "aws.permission",
        actions: ["transcribe:GetTranscriptionJob", "transcribe:DeleteTranscriptionJob"],
        resources: [`arn:aws:transcribe:us-east-1:${ACCOUNT}:transcription-job/cuadrilla-poc-*`],
      },
    ]);
    expect(IAM_ARNS.transcriptionJobs).toBe(`arn:aws:transcribe:us-east-1:${ACCOUNT}:transcription-job/${TRANSCRIBE_PREFIX}*`);
  });

  it("lets the caller read the voice notes and write, read and delete the output, as Transcribe acts with its credentials", async () => {
    const { only } = await evaluate();
    const include = (await resolveDeep(only("sst.Linkable").args.include)) as Array<Record<string, unknown>>;
    expect(include.filter((statement) => (statement.actions as string[]).some((action) => action.startsWith("s3:")))).toEqual([
      { type: "aws.permission", actions: ["s3:GetObject"], resources: [`${MEDIA_ARN}/wa/*`, `${MEDIA_ARN}/sim/*`] },
      { type: "aws.permission", actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], resources: [`${MEDIA_ARN}/transcripts/*`] },
    ]);
    expect(include).toHaveLength(CAPABILITIES.TRANSCRIBE.grants.length);
    const actions = include.flatMap((statement) => statement.actions as string[]);
    expect(actions.some((action) => /Vocabulary|TagResource|\*/.test(action))).toBe(false);
  });

  it("hands the worker the vocabulary, the language, the job prefix, the output location and the job tags", async () => {
    const { only } = await evaluate();
    const link = only("sst.Linkable");
    expect(link.name).toBe("Transcribe");
    expect(await resolveDeep(link.args.properties)).toEqual({
      vocabularyName: "cuadrilla-poc-ftth-es-mx",
      languageCode: "es-MX",
      jobNamePrefix: "cuadrilla-poc-",
      outputBucket: MEDIA_BUCKET,
      outputPrefix: "transcripts/",
      jobTags: [{ Key: "Project", Value: APP }],
    });
    expect(integrations).toContain("`Tags [{Key: Project, Value: aws-cds-hackathon-poc-cuadrilla}]`");
    expect(integrations).toContain("`LanguageCode es-MX`");
  });

  it("is linked exactly to the roles that hold TRANSCRIBE", async () => {
    const { module } = await evaluate();
    const linked = LAMBDAS.filter((fn) => module.transcribeLinks(fn).length > 0);
    expect(linked).toEqual(["InstallerWorker"]);
    expect(linked).toEqual(LAMBDAS.filter((fn) => expectedActions(fn).includes("transcribe:StartTranscriptionJob")));
    expect(module.transcribeLinks("InstallerWorker")).toEqual([module.Transcribe]);
  });
});

// ---- Transcribe output ------------------------------------------------------------------------------

describe("Transcribe output in Media/transcripts/", () => {
  it("expires after one day as the backstop, in the Media lifecycle, and media.ts adds no lifecycle of its own", async () => {
    const { created } = await evaluate();
    expect(lifecycleRules(BUCKET_SPECS.Media)).toContainEqual({
      id: "expire-transcripts",
      status: "Enabled",
      filter: { prefix: MEDIA_TRANSCRIPTS_PREFIX },
      expiration: { days: TRANSCRIPTS_RETENTION_DAYS },
    });
    expect(TRANSCRIPTS_RETENTION_DAYS).toBe(1);
    expect(created.some((entry) => entry.type === "aws.s3.BucketLifecycleConfiguration")).toBe(false);
    expect(architecture).toContain("regla de ciclo de vida de 1 día como respaldo");
  });

  it("writes where the IAM fence of StartTranscriptionJob allows: the output prefix is the OutputKey condition", async () => {
    const { only } = await evaluate();
    const properties = (await resolveDeep(only("sst.Linkable").args.properties)) as { outputPrefix: string };
    const start = CAPABILITIES.TRANSCRIBE.grants.find((grant) => grant.actions.includes("transcribe:StartTranscriptionJob"));
    expect(start?.conditions?.find((condition) => condition.variable === "transcribe:OutputKey")?.values).toEqual([`${properties.outputPrefix}*`]);
    expect(BUCKET_SPECS.Media.prefixes).toContain(properties.outputPrefix);
  });

  it("creates only the file, the vocabulary and the link", async () => {
    const { created } = await evaluate();
    expect(created.map((entry) => entry.type).sort()).toEqual(["aws.s3.BucketObjectv2", "aws.transcribe.Vocabulary", "sst.Linkable"]);
  });
});
