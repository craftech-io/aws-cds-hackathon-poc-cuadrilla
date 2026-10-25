// Edge of the phone simulator with the BFF (docs/tool-catalog.md, `simulator` router; FL-082, FL-083,
// FL-101). Every answer is checked with zod before the view reads it. The console never names a phone,
// a wamid, a world or an S3 key: only an identity of the user's world and what that person did; a file
// travels by the `uploadId` of a presigned POST that `presignMedia` registered for this user and world.
//
//   simulator.identities    → who the phone can be, whether the world is simulated, the hourly limit
//   simulator.thread        { identity } → the chat as WhatsApp draws it
//   simulator.catalog       → the synthetic photos and voice notes
//   simulator.quickMessages → the tour's messages of the main story
//   simulator.sendText / tapButton / sendVoiceNote / sendPhoto / sendQuick / markRead
//   simulator.presignMedia  { kind, contentType } → { uploadId, url, fields, maxBytes }
//   simulator.joinCode / kit   with the live transport in the stage only
import { IsoInstant, PersonRole, RejectReason, TemplateName, Verdict, WaButtonAction } from "@cuadrilla/shared";
import { z } from "zod";
import type { ConsoleApi } from "../../lib/console-api";
import { fetchWithRetry } from "../../lib/http";

/** The identity of a number the world does not know (packages/bff/src/routers/simulator-views.ts). */
export const UNKNOWN_IDENTITY = "UNKNOWN";

/** A photo uploaded to the simulator: JPEG of at most 3.5 MB (the presigned POST enforces it too). */
export const MAX_PHOTO_BYTES = 3.5 * 1024 * 1024;

const P = {
  identities: "simulator.identities",
  thread: "simulator.thread",
  catalog: "simulator.catalog",
  quickMessages: "simulator.quickMessages",
  sendText: "simulator.sendText",
  tapButton: "simulator.tapButton",
  sendVoiceNote: "simulator.sendVoiceNote",
  sendPhoto: "simulator.sendPhoto",
  sendQuick: "simulator.sendQuick",
  presignMedia: "simulator.presignMedia",
  markRead: "simulator.markRead",
  joinCode: "simulator.joinCode",
  kit: "simulator.kit",
} as const;

export const SimIdentity = z.looseObject({
  identity: z.string().min(1),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  role: PersonRole.nullable(),
  active: z.boolean(),
});
export type SimIdentity = z.infer<typeof SimIdentity>;

export const SimIdentities = z.looseObject({
  simulated: z.boolean(),
  liveTransport: z.boolean(),
  messagesPerRealHourPerIdentity: z.number().int().nonnegative(),
  identities: z.array(SimIdentity),
});
export type SimIdentities = z.infer<typeof SimIdentities>;

export const ThreadButton = z.looseObject({
  id: z.string().min(1),
  title: z.string(),
  kind: z.enum(["button_reply", "list_reply", "button"]),
});
export type ThreadButton = z.infer<typeof ThreadButton>;

export const Bubble = z.looseObject({
  messageId: z.string().min(1),
  direction: z.enum(["IN", "OUT"]),
  content: z.string(),
  kind: z.string().nullable(),
  text: z.string().nullable(),
  templateName: TemplateName.nullable(),
  buttons: z.array(ThreadButton),
  buttonAction: WaButtonAction.nullable(),
  mediaKind: z.enum(["AUDIO", "IMAGE", "DOCUMENT"]).nullable(),
  mediaUrl: z.string().nullable(),
  fileName: z.string().nullable(),
  reaction: z.looseObject({ emoji: z.string(), to: z.string() }).nullable(),
  status: z.string(),
  sentAtSim: IsoInstant,
  /** When it was stored, in real time: the order of two bubbles of the same simulated instant. */
  sentAtReal: IsoInstant.nullable().optional(),
  providerMessageId: z.string().nullable(),
});
export type Bubble = z.infer<typeof Bubble>;

export const Thread = z.looseObject({ identity: z.string(), bubbles: z.array(Bubble) });
export type Thread = z.infer<typeof Thread>;

export const CatalogPhoto = z.looseObject({ photoId: z.string().min(1), expectedVerdict: Verdict, expectedReason: RejectReason.nullable() });
export type CatalogPhoto = z.infer<typeof CatalogPhoto>;

export const CatalogVoice = z.looseObject({ voiceId: z.string().min(1), durationSec: z.number().nonnegative(), speaker: z.string().nullable(), text: z.string() });
export type CatalogVoice = z.infer<typeof CatalogVoice>;

export const Catalog = z.looseObject({ photos: z.array(CatalogPhoto), voices: z.array(CatalogVoice) });
export type Catalog = z.infer<typeof Catalog>;

export const QuickMessage = z.looseObject({
  quickId: z.string().min(1),
  scene: z.string(),
  identity: z.string().min(1),
  label: z.string(),
  glossEn: z.string(),
  type: z.enum(["TEXT", "VOICE", "PHOTO", "TAP"]),
  physicalAction: z.string().nullable(),
});
export type QuickMessage = z.infer<typeof QuickMessage>;

const Sent = z.looseObject({ wamid: z.string(), sentAtReal: IsoInstant });

export const PresignedPost = z.looseObject({
  uploadId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  url: z.url({ protocol: /^https?$/ }),
  fields: z.record(z.string(), z.string()),
  maxBytes: z.number().int().positive(),
});
export type PresignedPost = z.infer<typeof PresignedPost>;

export const JoinCode = z.looseObject({
  code: z.string().min(1),
  message: z.string().min(1),
  expiresInMinutes: z.number().positive(),
  /** The demo's WhatsApp number in E.164, when the BFF names it. */
  number: z.string().regex(/^\+?\d{8,15}$/).optional(),
});
export type JoinCode = z.infer<typeof JoinCode>;

export const Kit = z.union([
  z.looseObject({ available: z.literal(false) }),
  z.looseObject({
    available: z.literal(true),
    photos: z.array(z.looseObject({ photoId: z.string(), url: z.url() })),
    voices: z.array(z.looseObject({ voiceId: z.string(), text: z.string().nullable(), url: z.url() })),
    script: z.array(z.looseObject({ quickId: z.string(), text: z.string(), glossEn: z.string() })),
  }),
]);
export type Kit = z.infer<typeof Kit>;

const Read = z.looseObject({ read: z.number().int().nonnegative() });

export type MediaKind = "PHOTO" | "VOICE";

/** What the person does on the phone. */
export type SimAction =
  | { readonly kind: "text"; readonly identity: string; readonly text: string }
  | { readonly kind: "tap"; readonly identity: string; readonly messageId: string; readonly buttonId: string }
  | { readonly kind: "samplePhoto"; readonly identity: string; readonly photoId: string }
  | { readonly kind: "sampleVoice"; readonly identity: string; readonly voiceId: string }
  | { readonly kind: "ownPhoto"; readonly identity: string; readonly file: Blob; readonly caption?: string }
  | { readonly kind: "ownVoice"; readonly identity: string; readonly file: Blob; readonly contentType: string }
  | { readonly kind: "quick"; readonly quickId: string }
  | { readonly kind: "markRead"; readonly identity: string };

export function createSimulatorApi(api: ConsoleApi, upload: typeof uploadToPresignedPost = uploadToPresignedPost) {
  async function uploaded(kind: MediaKind, contentType: string, file: Blob): Promise<string> {
    const post = await api.mutation(P.presignMedia, { kind, contentType }, PresignedPost);
    await upload(post, file, contentType);
    return post.uploadId;
  }
  return {
    identities: (signal?: AbortSignal) => api.query(P.identities, undefined, SimIdentities, signal),
    thread: (identity: string, signal?: AbortSignal) => api.query(P.thread, { identity }, Thread, signal),
    catalog: (signal?: AbortSignal) => api.query(P.catalog, undefined, Catalog, signal),
    quickMessages: (signal?: AbortSignal) => api.query(P.quickMessages, undefined, z.array(QuickMessage), signal),
    kit: (signal?: AbortSignal) => api.query(P.kit, undefined, Kit, signal),
    joinCode: (personId: string) => api.mutation(P.joinCode, { personId }, JoinCode),
    async run(action: SimAction): Promise<unknown> {
      switch (action.kind) {
        case "text":
          return api.mutation(P.sendText, { identity: action.identity, text: action.text }, Sent);
        case "tap":
          return api.mutation(P.tapButton, { identity: action.identity, messageId: action.messageId, buttonId: action.buttonId }, Sent);
        case "samplePhoto":
          return api.mutation(P.sendPhoto, { identity: action.identity, photoId: action.photoId }, Sent);
        case "sampleVoice":
          return api.mutation(P.sendVoiceNote, { identity: action.identity, voiceId: action.voiceId }, Sent);
        case "ownPhoto": {
          const uploadId = await uploaded("PHOTO", "image/jpeg", action.file);
          return api.mutation(P.sendPhoto, { identity: action.identity, uploadId, ...(action.caption ? { caption: action.caption } : {}) }, Sent);
        }
        case "ownVoice": {
          const uploadId = await uploaded("VOICE", action.contentType, action.file);
          return api.mutation(P.sendVoiceNote, { identity: action.identity, uploadId }, Sent);
        }
        case "quick":
          return api.mutation(P.sendQuick, { quickId: action.quickId }, z.looseObject({ quickId: z.string() }));
        case "markRead":
          return api.mutation(P.markRead, { identity: action.identity }, Read);
      }
    },
  };
}

export type SimulatorApi = ReturnType<typeof createSimulatorApi>;

/** The `reason` of an upload S3 refused (policy, size): the person picks the file again. */
export const UPLOAD_REFUSED = "UPLOAD_REFUSED";

/** S3 refused the upload; shaped like a refusal of the BFF, so the view tells it with its own text. */
export class UploadRefused extends Error {
  override readonly name = "UploadRefused";
  readonly data: { readonly code: "BAD_REQUEST"; readonly httpStatus: number; readonly reason: typeof UPLOAD_REFUSED };
  constructor(status: number) {
    super(`the upload was refused (${status})`);
    this.data = { code: "BAD_REQUEST", httpStatus: status, reason: UPLOAD_REFUSED };
  }
}

/** The presigned POST: its fields first, the file last (S3 ignores what follows `file`). */
export async function uploadToPresignedPost(post: PresignedPost, file: Blob, contentType: string, send: typeof fetchWithRetry = fetchWithRetry): Promise<void> {
  if (file.size < 1 || file.size > post.maxBytes) throw new UploadRefused(400);
  const form = new FormData();
  for (const [name, value] of Object.entries(post.fields)) form.append(name, value);
  form.append("file", file.type === contentType ? file : new Blob([file], { type: contentType }));
  // A POST is never retried by fetchWithRetry after an answer; a network failure before one is.
  const response = await send(post.url, { method: "POST", body: form }, { timeoutMs: 60_000 });
  if (!response.ok) throw new UploadRefused(response.status);
}
