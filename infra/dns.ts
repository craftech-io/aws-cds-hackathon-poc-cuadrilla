// DNS for the app (docs/architecture.md §1).
//
// The only stage, `poc`, lives under `demo.craftech.io`, a hosted zone delegated to the demos
// account and shared by all demos. The zone pre-exists: it is referenced by id and never managed
// here (the only records this app creates are its own records, inside that zone). Certificates are
// DNS-validated in this same zone, so nothing touches the parent account.
//
//   cuadrilla.demo.craftech.io          console, landing, /join, /legal/*, /api/*
//   bounce.cuadrilla.demo.craftech.io   custom MAIL FROM (SES feedback MX + SPF)
//
// The app sends email but never receives it (ADR-0003): there is no inbound MX anywhere. The email
// records (DKIM, MAIL FROM, DMARC) belong to infra/messaging-email.ts; this module only names the
// domains and hands the Route 53 adapter to whoever needs one.

export const ZONE_ID = "Z043097217S4W7QWXU5O0";
export const ZONE_NAME = "demo.craftech.io";
export const PRODUCT_SUBDOMAIN = "cuadrilla";

/** Domain of the app: console, landing, legal pages and the BFF. */
export const appDomain = `${PRODUCT_SUBDOMAIN}.${ZONE_NAME}`;

/** Custom MAIL FROM domain, so SPF aligns as well as DKIM. */
export const mailFromDomain = `bounce.${appDomain}`;

/** Public URL of the app (console at `/`, `/api/*` behind the Router). */
export const appUrl = `https://${appDomain}`;

/**
 * Route 53 adapter for `domain.dns` of the Router and for the SES records. Pinned to the delegated
 * zone so SST never searches for a zone by name and never resolves to the parent `craftech.io` zone.
 */
export const dns = sst.aws.dns({ zone: ZONE_ID });
