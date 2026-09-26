// Voice notes: the Amazon Transcribe vocabulary and the TRANSCRIBE capability (docs/architecture.md
// §9.7 and §14, docs/architecture-integrations.md §5, ADR-0006, docs/build-plan.md WP-21). Imported by
// sst.config.ts right after infra/storage-kb.ts.
//
// Vocabulary `cuadrilla-poc-ftth-es-mx`, table format. Its text has one source,
// packages/bff/src/copy/transcribe-vocabulary.ts (plain `.txt`, UTF-8, TAB-separated, header
// `Phrase\tSoundsLike\tIPA\tDisplayAs` with SoundsLike and IPA always empty; its test checks every
// row). This module uploads that file with `aws.s3.BucketObjectv2` to `Seed/transcribe/vocabulary-v<nnn>.txt`
// and creates `aws.transcribe.Vocabulary` from it, with `dependsOn` of the object. Transcribe reads the
// file with the credentials of whoever calls CreateVocabulary: the CI role, which reaches the app's
// buckets by name prefix. Transcribe answers an invalid row with a vocabulary in FAILED, and the deploy
// fails there, never later in a voice note.
//
// Why the digest. The provider updates a vocabulary only when `vocabularyFileUri` changes, never when the
// file under the same key does: new rows under the same version would upload a new file and leave the
// vocabulary on the old one. So the file of each published version is pinned here by its sha256, and
// the deploy fails when the rows changed without a new VOCABULARY_VERSION (a new key, hence a new URI
// and an UpdateVocabulary). To publish new rows: bump the version in copy/transcribe-vocabulary.ts and
// pin the digest the error prints.
//
// Fences. The CI role and the boundary create the vocabulary on `Resource *` only with the app's
// `Project` tag and the app's tag keys, and read, update and delete only `vocabulary/cuadrilla-poc-*`
// (infra/bootstrap/ci-role.yaml, ADR-0009): the default tags of sst.config.ts are the only tags it
// carries, and its name must keep the prefix (checked here, before anything is created). No role of the
// app creates or changes it; the worker names it in every job.
//
// TRANSCRIBE. The `Transcribe` Linkable carries the statements of the capability, resolved against the
// `Media` bucket (infra/iam-capabilities.ts, two Transcribe statements: `StartTranscriptionJob` on
// `Resource *`, the only resource IAM offers, fenced by the output bucket and the `transcripts/*` key;
// `Get/DeleteTranscriptionJob` on `transcription-job/cuadrilla-poc-*`; plus reading the voice notes and
// writing, reading and deleting the output, because Transcribe acts with the caller's credentials).
// `transcribeLinks(fn)` hands it exactly to the roles that hold TRANSCRIBE (today `InstallerWorker`), and
// its properties are what packages/bff/src/media/ needs to start a job. The output is deleted as soon as
// it is read; the one-day expiration of `Media/transcripts/` is the backstop, declared with the rest of
// the bucket's lifecycle in infra/storage-keys.ts (one lifecycle configuration per bucket: this module
// adds none).
//
// Cost: Transcribe bills per second transcribed (capped per real day by infra/cost-caps.ts); the
// vocabulary and its file cost nothing while idle.
//
// Verify:
//   aws --profile craftech-demos transcribe get-vocabulary --vocabulary-name cuadrilla-poc-ftth-es-mx
//     → VocabularyState READY, LanguageCode es-MX
//   aws --profile craftech-demos s3api head-object --bucket <Seed> --key transcribe/vocabulary-v001.txt
//     → ContentType text/plain; charset=utf-8
//   aws --profile craftech-demos s3api get-bucket-lifecycle-configuration --bucket <Media>
//     → rule expire-transcripts, prefix transcripts/, 1 day

import { createHash } from "node:crypto";
import { VOCABULARY_CONTENT_TYPE, VOCABULARY_NAME, VOCABULARY_OBJECT_KEY, VOCABULARY_VERSION, vocabularyFile } from "../packages/bff/src/copy/transcribe-vocabulary";
import { CAPABILITIES, LAMBDA_CAPABILITIES, TRANSCRIBE_PREFIX, resolveCapabilities, type Condition, type Grant, type LambdaName } from "./iam-capabilities";
import { MEDIA_TRANSCRIPTS_PREFIX, mediaBucket, seedBucket, storageResource } from "./storage";
import { PROJECT } from "./tags";

const TRANSCRIBE_LANGUAGE_CODE = "es-MX";

/** Prefix of `Seed` that holds the vocabulary files (docs/architecture.md §6). */
const VOCABULARY_KEY_PREFIX = "transcribe/";

/** sha256 of the vocabulary file of each published version (see "Why the digest" above). */
export const VOCABULARY_FILE_SHA256: Readonly<Record<string, string>> = {
  v001: "7dd9c2a4cb7418ee0dcab2eeb95ee6d4e25aa810f06ab3307491730cfa3cde2c",
};

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Throws unless the file is the one pinned for its version. */
export function assertVocabularyPinned(file: string, version: string, pinned: Readonly<Record<string, string>> = VOCABULARY_FILE_SHA256): void {
  const digest = sha256(file);
  if (pinned[version] === digest) return;
  throw new Error(
    `Transcribe vocabulary ${version}: the file of packages/bff/src/copy/transcribe-vocabulary.ts has sha256 ${digest}, ` +
      `not the one pinned in infra/media.ts (${pinned[version] ?? "none"}). The vocabulary only picks up a new file under a new key: ` +
      `bump VOCABULARY_VERSION and pin this digest for the new version.`,
  );
}

/** Throws unless the vocabulary and its file stay inside the fences of the CI role. */
export function assertVocabularyFences(name: string = VOCABULARY_NAME, key: string = VOCABULARY_OBJECT_KEY): void {
  if (!name.startsWith(TRANSCRIBE_PREFIX) || !/^[0-9A-Za-z._-]{1,200}$/.test(name)) {
    throw new Error(`Transcribe vocabulary "${name}" must start with ${TRANSCRIBE_PREFIX}: the CI role manages vocabulary/${TRANSCRIBE_PREFIX}* only.`);
  }
  if (!key.startsWith(VOCABULARY_KEY_PREFIX) || !key.endsWith(".txt")) {
    throw new Error(`Transcribe vocabulary file "${key}" must be a .txt under Seed/${VOCABULARY_KEY_PREFIX} (table format, read by the CI role).`);
  }
}

// ---- Vocabulary ----------------------------------------------------------------------------------

assertVocabularyFences();
const vocabularyText = vocabularyFile();
assertVocabularyPinned(vocabularyText, VOCABULARY_VERSION);

const vocabularyObject = new aws.s3.BucketObjectv2("TranscribeVocabularyFile", {
  bucket: seedBucket.name,
  key: VOCABULARY_OBJECT_KEY,
  content: vocabularyText,
  contentType: VOCABULARY_CONTENT_TYPE,
});

const transcribeVocabulary = new aws.transcribe.Vocabulary(
  "TranscribeVocabulary",
  {
    vocabularyName: VOCABULARY_NAME,
    languageCode: TRANSCRIBE_LANGUAGE_CODE,
    vocabularyFileUri: $interpolate`s3://${seedBucket.name}/${VOCABULARY_OBJECT_KEY}`,
  },
  { dependsOn: [vocabularyObject] },
);

// ---- TRANSCRIBE capability -----------------------------------------------------------------------

/** An ARN, `*` or a literal stays; a storage placeholder (`{Media}/wa/*`, `{Media.name}`) is resolved. */
function resolveReference(value: string): $util.Input<string> {
  if (!value.startsWith("{")) return value;
  const resolved = storageResource(value);
  if (resolved === undefined) throw new Error(`TRANSCRIBE: "${value}" is not storage of infra/storage.ts, so nothing can resolve it.`);
  return resolved;
}

function conditionOf(condition: Condition) {
  return { test: condition.test, variable: condition.variable, values: condition.values.map(resolveReference) };
}

function permissionOf(grant: Grant) {
  return sst.aws.permission({
    actions: [...grant.actions],
    resources: grant.resources.map(resolveReference),
    ...(grant.conditions === undefined ? {} : { conditions: grant.conditions.map(conditionOf) }),
  });
}

/** The statements of TRANSCRIBE (and anything it includes), in the order iam-capabilities.ts lists them. */
const transcribePermissions = resolveCapabilities(["TRANSCRIBE"]).flatMap((name) => CAPABILITIES[name].grants.map(permissionOf));

/**
 * What the worker needs to start a job (docs/architecture-integrations.md §5): the vocabulary (READY
 * before any Lambda that links it deploys), the language, the job name prefix the IAM fence expects,
 * where the output goes, and the tags every job carries.
 */
export const Transcribe = new sst.Linkable("Transcribe", {
  properties: {
    vocabularyName: transcribeVocabulary.vocabularyName,
    languageCode: TRANSCRIBE_LANGUAGE_CODE,
    jobNamePrefix: TRANSCRIBE_PREFIX,
    outputBucket: mediaBucket.name,
    outputPrefix: MEDIA_TRANSCRIPTS_PREFIX,
    jobTags: [{ Key: "Project", Value: PROJECT }],
  },
  include: transcribePermissions,
});

/** `[Transcribe]` for a role that holds TRANSCRIBE in infra/iam-capabilities.ts, nothing otherwise. */
export function transcribeLinks(fn: LambdaName): Array<typeof Transcribe> {
  return resolveCapabilities(LAMBDA_CAPABILITIES[fn].capabilities).includes("TRANSCRIBE") ? [Transcribe] : [];
}
