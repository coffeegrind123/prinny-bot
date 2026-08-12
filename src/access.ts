/**
 * Who is allowed to talk to the bot, and how often.
 *
 * Ported from openclaude's `src/services/matrix/auth.ts`, with the persistence
 * inverted: that version called `updateMatrixState()` directly, which tied it
 * to one app's state file. Here the caller supplies a `persist` callback, so
 * the same logic backs a bot storing its allowlist in a database, a config
 * file, or nowhere at all.
 */

export type AccessDecision =
  | { allowed: true; isOwner: boolean; bootstrapped: boolean }
  | { allowed: false; reason: string };

export type AccessState = {
  ownerUserId?: string;
  allowedUserIds: string[];
};

export type AccessOptions = {
  /** Explicit owner. Set this and bootstrap never runs. */
  ownerUserId?: string;
  allowedUserIds?: string[];
  /** Called whenever the allowlist or owner changes. */
  persist?: (state: AccessState) => void | Promise<void>;
  /**
   * Let the first user who talks to the bot claim ownership.
   *
   * Convenient, and a genuine race: anyone on the homeserver who learns the
   * bot's MXID before its owner does can win it. Off by default here, unlike
   * openclaude, because a library should not hand a caller a footgun they did
   * not ask for. Set an `ownerUserId` in production.
   */
  allowBootstrap?: boolean;
};

export class AccessControl {
  private readonly allowed: Set<string>;

  private owner: string | undefined;

  private readonly persist: ((state: AccessState) => void | Promise<void>) | undefined;

  private readonly allowBootstrap: boolean;

  constructor(options: AccessOptions = {}) {
    this.allowed = new Set(options.allowedUserIds ?? []);
    this.owner = options.ownerUserId;
    this.persist = options.persist;
    this.allowBootstrap = options.allowBootstrap ?? false;
    if (this.owner !== undefined) this.allowed.add(this.owner);
  }

  /** True when nobody is allowed and nobody owns the bot. */
  get isUnclaimed(): boolean {
    return this.owner === undefined && this.allowed.size === 0;
  }

  private save(): void {
    void this.persist?.(this.list());
  }

  evaluate(userId: string): AccessDecision {
    if (this.isUnclaimed) {
      if (!this.allowBootstrap) {
        return {
          allowed: false,
          reason: 'This bot has no owner configured, so it is not accepting messages.',
        };
      }
      this.owner = userId;
      this.allowed.add(userId);
      this.save();
      return { allowed: true, isOwner: true, bootstrapped: true };
    }

    if (!this.allowed.has(userId)) {
      // Deliberately does not echo the sender's MXID: the refusal already
      // confirms something is listening here, and there is no reason to
      // confirm we also read who asked.
      return {
        allowed: false,
        reason: 'Not on this bot’s allowlist. Ask its owner to add you.',
      };
    }

    return { allowed: true, isOwner: userId === this.owner, bootstrapped: false };
  }

  isOwner(userId: string): boolean {
    return this.owner !== undefined && userId === this.owner;
  }

  /** Allowlist check with no bootstrap side effect. */
  isAllowed(userId: string): boolean {
    return this.allowed.has(userId);
  }

  list(): AccessState {
    const state: AccessState = { allowedUserIds: [...this.allowed].sort() };
    if (this.owner !== undefined) state.ownerUserId = this.owner;
    return state;
  }

  add(userId: string): boolean {
    if (this.allowed.has(userId)) return false;
    this.allowed.add(userId);
    this.save();
    return true;
  }

  /** Remove a user. The owner cannot be removed — that would orphan the bot. */
  remove(userId: string): boolean {
    if (userId === this.owner) return false;
    if (!this.allowed.delete(userId)) return false;
    this.save();
    return true;
  }
}

// ── Rate limiting ────────────────────────────────────────────────────────────

export type RateLimitOptions = {
  /** Messages allowed per window. Default 10. */
  max?: number;
  /** Window length in milliseconds. Default 5 minutes. */
  windowMs?: number;
};

/**
 * Sliding-window limiter, keyed by whatever the caller passes (room, user, or
 * a composite).
 *
 * Sliding rather than fixed-bucket: a fixed window lets a sender spend the
 * whole budget at 4:59 and the whole next budget at 5:01, which is exactly
 * double the intended rate at the moment it matters least.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  private readonly max: number;

  private readonly windowMs: number;

  constructor(options: RateLimitOptions = {}) {
    this.max = options.max ?? 10;
    this.windowMs = options.windowMs ?? 5 * 60 * 1000;
  }

  /** Record a hit. Returns false when the caller is over budget. */
  check(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);

    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Seconds until the caller's oldest hit falls out of the window. */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const recent = this.hits.get(key);
    if (!recent || recent.length === 0) return 0;
    const oldest = recent[0]!;
    return Math.max(0, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }
}
