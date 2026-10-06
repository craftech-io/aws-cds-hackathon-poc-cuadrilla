// The deployed dependencies of `transcribe_voice_note`, for the `InstallerWorker`: the Transcribe and S3
// clients, the `Transcribe` Linkable (infra/media.ts), the `Media` bucket and the faults of `qa-*`
// worlds. The worker passes its own `reserve_cost` dependencies, logger and audit writer.
import { bucketName } from "../lib/resource";
import type { CostCapsDeps } from "../ops/cost-caps";
import { linkedTranscribeConfig } from "./config";
import { runtimeTranscribeFaultReader } from "./faults";
import { createS3MediaObjects } from "./objects";
import { createTranscribeClient } from "./transcribe-client";
import type { VoiceNoteDeps } from "./transcribe";

export function deployedVoiceNoteDeps(costs: CostCapsDeps, extra: Pick<VoiceNoteDeps, "audit" | "logger" | "pollTimeoutMs"> = {}): VoiceNoteDeps {
  return {
    transcribe: createTranscribeClient({ config: linkedTranscribeConfig }),
    objects: createS3MediaObjects(),
    config: linkedTranscribeConfig,
    mediaBucket: () => bucketName("Media"),
    faults: runtimeTranscribeFaultReader(),
    costs,
    ...extra,
  };
}
