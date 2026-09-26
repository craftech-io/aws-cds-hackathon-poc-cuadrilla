// Stub of the `WorldJanitor` entry (docs/build-plan.md §2: an infra work package that points at a handler
// that does not exist yet creates it answering UNAVAILABLE; WP-39 replaces it). It reads, stores and
// logs nothing and never throws, so the nightly run and MEMORY_PURGE do nothing while no world exists.
export interface HandlerUnavailable {
  readonly status: "UNAVAILABLE";
}

export async function handler(): Promise<HandlerUnavailable> {
  return { status: "UNAVAILABLE" };
}
