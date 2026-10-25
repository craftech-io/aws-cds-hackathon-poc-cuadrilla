// Candidate photos (`LAM-CANDIDATE`, docs/design-brief.md §5.6): a photo the installer sent is a
// `Message IN` of content IMAGE in their thread. The turn's envelope names it by a short id derived
// from the message id (`<attachment kind="IMAGE" candidateId="ec_…"/>`), never by the `wamid` (a
// live one is base64, long and may carry `=`, `+` or `/`). The worker's envelope, the QaDriver's
// `candidates` preset and `tool.invoke` build the id with `candidateIdOf`; `validate_install_photo`
// accepts only a candidate of the session's installer, in the world, on the order it validates.
import { sha256Hex } from "../lib/crypto";
import type { ConversationsPort } from "../connector/ports";
import type { Message } from "../domain/conversations";

export const CANDIDATE_PREFIX = "ec_";
/** Messages of the installer's thread the lookup reads, newest first. */
export const CANDIDATE_LOOKBACK = 200;

/** `ec_<24 hex>`: the candidate id of an inbound photo message. */
export function candidateIdOf(messageId: string): string {
  return `${CANDIDATE_PREFIX}${sha256Hex(messageId).slice(0, 24)}`;
}

export interface CandidateQuery {
  readonly installerId: string;
  readonly clockId: string;
  readonly workOrderId: string;
  readonly candidateId: string;
}

/** Whether a message can be validated as evidence of `query`'s order. */
export function isCandidateOf(message: Message, query: Omit<CandidateQuery, "candidateId">): boolean {
  return (
    message.direction === "IN" &&
    message.content === "IMAGE" &&
    message.media?.kind === "IMAGE" &&
    message.personId === query.installerId &&
    message.author === `PERSON:${query.installerId}` &&
    message.clockId === query.clockId &&
    message.workOrderId === query.workOrderId
  );
}

/** The candidate the id names, if it is a photo of the installer on that order in that world. */
export async function findCandidate(conversations: Pick<ConversationsPort, "listMessages">, query: CandidateQuery): Promise<Message | undefined> {
  if (!query.candidateId.startsWith(CANDIDATE_PREFIX)) return undefined;
  const thread = await conversations.listMessages(query.installerId, { descending: true, limit: CANDIDATE_LOOKBACK });
  return thread.find((message) => candidateIdOf(message.messageId) === query.candidateId && isCandidateOf(message, query));
}

/**
 * The newest photo of the installer on that order sent before `before` (a message id of the thread): the
 * one a CHOOSE_ITEM tap names the item of, so the tap's turn validates it instead of asking for it again.
 */
export async function latestCandidateBefore(conversations: Pick<ConversationsPort, "listMessages">, query: Omit<CandidateQuery, "candidateId">, before: Pick<Message, "messageId" | "sentAtSim">): Promise<Message | undefined> {
  const thread = await conversations.listMessages(query.installerId, { descending: true, limit: CANDIDATE_LOOKBACK });
  return thread.find((message) => message.messageId !== before.messageId && message.sentAtSim <= before.sentAtSim && isCandidateOf(message, query));
}
