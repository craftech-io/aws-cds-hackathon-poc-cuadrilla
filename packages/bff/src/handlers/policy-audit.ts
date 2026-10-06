// Stub of the `PolicyAudit` entry (docs/build-plan.md §2: an infra work package that points at a handler
// that does not exist yet creates it answering UNAVAILABLE; WP-40 replaces it). It reads, stores and
// logs nothing and never throws, so the daily run and `policyAudit.run` audit nothing until then.
export interface HandlerUnavailable {
  readonly status: "UNAVAILABLE";
}

export async function handler(): Promise<HandlerUnavailable> {
  return { status: "UNAVAILABLE" };
}
