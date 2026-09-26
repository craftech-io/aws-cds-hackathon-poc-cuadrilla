// Matches the Cognito `sub` of a console user with its row in the registry (`Isps/USER#…`, GSI1
// `SUB#<sub>`, docs/architecture.md §5). The row gives the `userId` that signs the audit log and the
// `active` switch: an id token lives 15 minutes and is verified offline, so deactivating a user must
// not wait for it to expire.

export interface UserMatch {
  readonly userId: string;
  readonly active: boolean;
}

/** What the directory needs from the connector (WP-07 implements it over `Isps`). */
export interface UserLookup {
  /** `undefined` when no user row of the operator names this `sub`. */
  findBySub(ispId: string, sub: string): Promise<UserMatch | undefined>;
}

export interface UserDirectory {
  find(ispId: string, sub: string): Promise<UserMatch | undefined>;
}

// One read per user per minute per container instead of one per request.
const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  readonly expiresAt: number;
  readonly match: UserMatch | undefined;
}

export function createUserDirectory(lookup: UserLookup, now: () => Date = () => new Date(), ttlMs: number = DEFAULT_TTL_MS): UserDirectory {
  const cache = new Map<string, CacheEntry>();

  return {
    async find(ispId, sub) {
      const key = `${ispId}#${sub}`;
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now().getTime()) return cached.match;

      const match = await lookup.findBySub(ispId, sub);
      cache.set(key, { expiresAt: now().getTime() + ttlMs, match });
      return match;
    },
  };
}
