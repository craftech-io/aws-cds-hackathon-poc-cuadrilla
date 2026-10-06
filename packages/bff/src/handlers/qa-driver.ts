// Stub of the `QaDriver` entry (docs/build-plan.md §2: an infra work package that points at a handler
// that does not exist yet creates it answering UNAVAILABLE; WP-45 replaces it). It reads, stores and
// logs nothing and never throws, so every scenario action answers UNAVAILABLE until then.
export interface HandlerUnavailable {
  readonly status: "UNAVAILABLE";
}

export async function handler(): Promise<HandlerUnavailable> {
  return { status: "UNAVAILABLE" };
}
