// Stub of the `FeedEvents` entry (docs/build-plan.md §2: an infra work package that points at a handler
// that does not exist yet creates it answering UNAVAILABLE; WP-33 replaces it). It reads, stores and
// logs nothing and never throws, so an event of the Feeds bus is acknowledged and never retried.
export interface HandlerUnavailable {
  readonly status: "UNAVAILABLE";
}

export async function handler(): Promise<HandlerUnavailable> {
  return { status: "UNAVAILABLE" };
}
