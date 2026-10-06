import { DeleteObjectCommand, GetObjectCommand, type GetObjectCommandOutput, S3Client } from "@aws-sdk/client-s3";
import {
  BadRequestException,
  ConflictException,
  DeleteTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  LimitExceededException,
  NotFoundException,
  StartTranscriptionJobCommand,
  TranscribeClient,
} from "@aws-sdk/client-transcribe";
import { OUTPUT_KEY_PATTERN, mediaFileUri, simMediaKey, transcriptOutputKey } from "@cuadrilla/shared/media/keys";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { transcriptionJobName } from "./config";
import { ObjectTooLargeError, createS3MediaObjects } from "./objects";
import { TEST_MEDIA_BUCKET, TEST_TRANSCRIBE_CONFIG } from "./testing";
import { TranscribeError, createTranscribeClient, startJobInput } from "./transcribe-client";

const CLOCK = "GUEST#isp-guest-test";
const MESSAGE = "wamid.SIM.01JA2B3C4D5E6F7G8H9J0K1M2N";
const JOB = transcriptionJobName(CLOCK, 2, MESSAGE);
const MEDIA_KEY = simMediaKey(CLOCK, 2, "up01JA2B3C4D");
const REQUEST = { jobName: JOB, mediaFileUri: mediaFileUri(TEST_MEDIA_BUCKET, MEDIA_KEY), mediaFormat: "ogg" as const, outputKey: transcriptOutputKey(CLOCK, 2, MESSAGE, JOB) };
const metadata = { $metadata: {} };

const transcribe = mockClient(TranscribeClient);
const s3 = mockClient(S3Client);

function client() {
  return createTranscribeClient({ config: () => TEST_TRANSCRIBE_CONFIG, client: new TranscribeClient({ region: "us-east-1" }), sleep: async () => {} });
}

beforeEach(() => {
  transcribe.reset();
  s3.reset();
});

describe("Transcribe client [FL-017]", () => {
  it("starts the job with the vocabulary, the tags, mediaFileUri and transcriptOutputKey of a GUEST#isp-guest-test world", async () => {
    transcribe.on(StartTranscriptionJobCommand).resolves({ TranscriptionJob: { TranscriptionJobName: JOB, TranscriptionJobStatus: "QUEUED" } });
    expect(await client().start(REQUEST)).toBe("STARTED");
    const [call] = transcribe.commandCalls(StartTranscriptionJobCommand);
    const input = call?.args[0].input;
    expect(input).toEqual({
      TranscriptionJobName: JOB,
      LanguageCode: "es-MX",
      MediaFormat: "ogg",
      Media: { MediaFileUri: `s3://${TEST_MEDIA_BUCKET}/${MEDIA_KEY}` },
      OutputBucketName: TEST_MEDIA_BUCKET,
      OutputKey: REQUEST.outputKey,
      Settings: { VocabularyName: "cuadrilla-poc-ftth-es-mx" },
      Tags: [{ Key: "Project", Value: "aws-cds-hackathon-poc-cuadrilla" }],
    });
    expect(input?.OutputKey).toMatch(OUTPUT_KEY_PATTERN);
    expect(input?.OutputKey?.startsWith("transcripts/")).toBe(true);
    expect(input?.Media?.MediaFileUri).not.toMatch(/[#?+= ]/);
  });

  it("answers EXISTS on ConflictException: the job of the same message is already there", async () => {
    transcribe.on(StartTranscriptionJobCommand).rejects(new ConflictException({ message: "The requested job name already exists.", ...metadata }));
    expect(await client().start(REQUEST)).toBe("EXISTS");
    expect(transcribe.commandCalls(StartTranscriptionJobCommand)).toHaveLength(1);
  });

  it("answers undefined on NotFoundException while polling, and treats deleting a deleted job as done", async () => {
    transcribe.on(GetTranscriptionJobCommand).rejects(new NotFoundException({ message: "not found", ...metadata }));
    transcribe.on(DeleteTranscriptionJobCommand).rejects(new NotFoundException({ message: "not found", ...metadata }));
    expect(await client().get(JOB)).toBeUndefined();
    await expect(client().delete(JOB)).resolves.toBeUndefined();
  });

  it("reads the status and the failure reason of a job", async () => {
    transcribe.on(GetTranscriptionJobCommand).resolvesOnce({ TranscriptionJob: { TranscriptionJobStatus: "IN_PROGRESS" } }).resolvesOnce({ TranscriptionJob: { TranscriptionJobStatus: "FAILED", FailureReason: "Unsupported media" } });
    expect(await client().get(JOB)).toEqual({ status: "IN_PROGRESS" });
    expect(await client().get(JOB)).toEqual({ status: "FAILED", failureReason: "Unsupported media" });
  });

  it("retries a throttled call once with backoff and never retries an invalid request", async () => {
    transcribe.on(StartTranscriptionJobCommand).rejectsOnce(new LimitExceededException({ message: "slow down", ...metadata })).resolves({});
    expect(await client().start(REQUEST)).toBe("STARTED");
    expect(transcribe.commandCalls(StartTranscriptionJobCommand)).toHaveLength(2);

    transcribe.reset();
    transcribe.on(StartTranscriptionJobCommand).rejects(new BadRequestException({ message: "bad", ...metadata }));
    const error = await client().start(REQUEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TranscribeError);
    expect(error).toMatchObject({ code: "INVALID", retryable: false });
    expect(String((error as Error).message)).not.toContain(JOB);
    expect(transcribe.commandCalls(StartTranscriptionJobCommand)).toHaveLength(1);
  });

  it("refuses a job outside the app's prefix or an output outside transcripts/", () => {
    expect(() => startJobInput(TEST_TRANSCRIBE_CONFIG, { ...REQUEST, jobName: "other-app-123" })).toThrow(RangeError);
    expect(() => startJobInput(TEST_TRANSCRIBE_CONFIG, { ...REQUEST, outputKey: "wa/abc.json" })).toThrow(RangeError);
  });
});

// The part of the SDK's streaming body the adapter uses.
function body(bytes: Uint8Array): GetObjectCommandOutput["Body"] {
  return { transformToByteArray: async () => bytes } as unknown as GetObjectCommandOutput["Body"];
}

describe("Media objects on S3 [FL-017]", () => {
  const location = { bucket: TEST_MEDIA_BUCKET, key: REQUEST.outputKey };

  it("reads an object with one byte past the limit and refuses a larger one", async () => {
    s3.on(GetObjectCommand).resolvesOnce({ Body: body(new Uint8Array(10)) }).resolvesOnce({ Body: body(new Uint8Array(11)) });
    const objects = createS3MediaObjects(new S3Client({ region: "us-east-1" }));
    expect(await objects.read(location, 10)).toHaveLength(10);
    await expect(objects.read(location, 10)).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(s3.commandCalls(GetObjectCommand)[0]?.args[0].input).toMatchObject({ Bucket: TEST_MEDIA_BUCKET, Key: location.key, Range: "bytes=0-10" });
  });

  it("answers undefined for a missing object and deletes by bucket and key", async () => {
    s3.on(GetObjectCommand).rejects(Object.assign(new Error("missing"), { name: "NoSuchKey" }));
    s3.on(DeleteObjectCommand).resolves({});
    const objects = createS3MediaObjects(new S3Client({ region: "us-east-1" }));
    expect(await objects.read(location, 10)).toBeUndefined();
    await objects.delete(location);
    expect(s3.commandCalls(DeleteObjectCommand)[0]?.args[0].input).toEqual({ Bucket: TEST_MEDIA_BUCKET, Key: location.key });
  });
});
