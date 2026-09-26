// Stub created by WP-02 (docs/build-plan.md): Cognito user pool of the console: groups SUPERVISOR,
// OPS and JUDGE, informative custom:ispId, SRP client with writeAttributes ["name"], 15-minute tokens.
// Owned by WP-10, which replaces this file. Until then it creates no resource; it only exports the
// build-time environment of the console (infra/web.ts), empty so the console builds without a pool.

/** Variables Vite reads at build time (packages/web/src/lib/env.ts); filled by WP-10. */
export const authWebEnvironment: Record<string, $util.Input<string>> = {};
