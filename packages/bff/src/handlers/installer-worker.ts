// Stub of the `InstallerWorker` entry (docs/build-plan.md §2: an infra work package that points at a handler
// that does not exist yet creates it answering UNAVAILABLE; WP-32 replaces it). It reads, stores and
// logs nothing and never throws, so a message of InstallerEvents.fifo is consumed once and never dead-lettered while nothing produces installer events yet.
export interface HandlerUnavailable {
  readonly status: "UNAVAILABLE";
}

export async function handler(): Promise<HandlerUnavailable> {
  return { status: "UNAVAILABLE" };
}
