// Stub of the `InboundWhatsApp` entry (docs/build-plan.md §2: an infra work package that points at a
// handler that does not exist yet creates it answering UNAVAILABLE; WP-33 replaces it). It reads,
// stores and logs nothing and never throws, so an event of the WhatsApp topic is never retried and no
// body is kept anywhere; the simulator gets UNAVAILABLE.
export interface InboundUnavailable {
  readonly status: "UNAVAILABLE";
}

export async function handler(): Promise<InboundUnavailable> {
  return { status: "UNAVAILABLE" };
}
