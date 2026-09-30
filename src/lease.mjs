/**
 * Thread leases for connectd.
 *
 * The problem: Connect and Codex Remote Control now drive the SAME app-server
 * (verified — `thread/list` over the daemon socket returns the user's real
 * threads). Codex assumes roughly one controlling client per thread, so two
 * writers issuing `turn/start` / `turn/steer` at once can interleave.
 *
 * A TTL lease alone is not enough: a holder that stalls past expiry still
 * believes it holds the lease and can issue a write. So every mutation carries
 * a monotonically increasing fencing token which is validated here, at the one
 * place all writes funnel through. A stale token is refused even if its clock
 * says the lease is live.
 *
 * States: unheld -> held(WRITE) -> unheld
 *                      \-> expired (any write with an old token is refused)
 * Non-holders are never blocked from READ; only mutations are gated.
 */

export const MUTATING_METHODS = new Set([
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread/compact/start",
  "thread/rollback",
  "thread/inject_items",
  "thread/settings/update",
  "process/writeStdin",
  "process/kill",
  "thread/backgroundTerminals/terminate",
]);

export class LeaseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LeaseError";
    this.code = code; // "held" | "stale_token" | "not_held" | "expired"
  }
}

export class LeaseRegistry {
  #leases = new Map(); // threadId -> { owner, token, expiresAt }
  #token = 0n; // process-wide monotonic; never resets, never reused
  #ttlMs;
  #now;

  constructor({ ttlMs = 30_000, now = () => Date.now() } = {}) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  #live(threadId) {
    const l = this.#leases.get(threadId);
    if (!l) return null;
    if (l.expiresAt <= this.#now()) {
      this.#leases.delete(threadId); // lazily reap; the token still fences
      return null;
    }
    return l;
  }

  /** @returns {{threadId,owner,token,expiresAt}} */
  acquire(threadId, owner, { ttlMs = this.#ttlMs } = {}) {
    const held = this.#live(threadId);
    if (held && held.owner !== owner) {
      throw new LeaseError(`thread ${threadId} is held by ${held.owner}`, "held");
    }
    // Re-acquiring by the same owner issues a fresh token, invalidating any
    // write still in flight from that owner's previous lease.
    const lease = {
      threadId,
      owner,
      token: (++this.#token).toString(),
      expiresAt: this.#now() + ttlMs,
    };
    this.#leases.set(threadId, lease);
    return { ...lease };
  }

  renew(threadId, token, { ttlMs = this.#ttlMs } = {}) {
    const l = this.#live(threadId);
    if (!l) throw new LeaseError(`no live lease on ${threadId}`, "expired");
    if (l.token !== token) throw new LeaseError("stale fencing token", "stale_token");
    l.expiresAt = this.#now() + ttlMs;
    return { ...l };
  }

  release(threadId, token) {
    const l = this.#leases.get(threadId);
    if (!l) return false;
    if (l.token !== token) throw new LeaseError("stale fencing token", "stale_token");
    this.#leases.delete(threadId);
    return true;
  }

  /** Non-throwing view, for the HUD. */
  inspect(threadId) {
    const l = this.#live(threadId);
    return l ? { ...l, msRemaining: l.expiresAt - this.#now() } : null;
  }

  /**
   * The fence. Every mutation passes through here; reads never do.
   * Refuses stale tokens even when a newer lease is live, which is the case a
   * pure TTL check gets wrong.
   */
  guard(method, threadId, token) {
    if (!MUTATING_METHODS.has(method)) return; // reads are always allowed
    const l = this.#live(threadId);
    if (!l) throw new LeaseError(`${method} on ${threadId} requires a lease`, "not_held");
    if (l.token !== token) {
      throw new LeaseError(
        `${method} refused: fencing token ${token ?? "(none)"} is stale, current is ${l.token}`,
        "stale_token"
      );
    }
  }
}
