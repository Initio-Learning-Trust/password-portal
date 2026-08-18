// Fixed-window rate limiting for the public generation endpoints.
//
// Design note — why this batches writes instead of sharding counters.
// Firestore sustains roughly one write per second to a single document. A
// 50,000/hour allowlist tier is ~14 writes/second, so a document-per-caller
// counter incremented on every request would sit permanently in contention.
// Rather than fan out across shard documents (which multiplies reads on every
// check), each instance counts in memory and flushes the delta with a single
// atomic increment at most every SYNC_INTERVAL_MS. That keeps the hot document
// under one write per second per instance, and collapses the cost of a caller
// hammering a spent quota to zero I/O.
//
// The tradeoff is bounded overshoot: several instances can each admit a few
// requests against slightly stale totals before their next flush. Overshoot is
// capped at roughly (instances x requests-per-sync-interval), which is
// immaterial against limits in the thousands. This is the usual accuracy
// bargain for distributed rate limiting and is documented for integrators.

import * as admin from 'firebase-admin';
// Imported from the modular entry point rather than reached for as
// `admin.firestore.FieldValue`: the Firebase emulator replaces the
// `firebase-admin` default export with a proxy that does not carry those
// statics, so the namespace form is undefined under local emulation.
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import * as crypto from 'crypto';

export const WINDOW_SECONDS = 3600;

/** Longest an instance will serve from its own cached total before re-reading. */
const SYNC_INTERVAL_MS = 2000;

/** Above this fraction of the limit, re-read on every request for accuracy. */
const STRICT_FRACTION = 0.8;

/** Cached buckets held per instance before the oldest are dropped. */
const MAX_CACHE_ENTRIES = 10_000;

const COLLECTION = 'rate_limits';

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch seconds at which the current window rolls over. */
  resetAt: number;
  /** Seconds until the window resets. Only meaningful when denied. */
  retryAfter: number;
}

interface CacheEntry {
  bucket: number;
  /** Window total as of the last successful read. */
  confirmed: number;
  /** Counted by this instance but not yet flushed. */
  pending: number;
  syncedAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Identity for a rate-limit bucket. The address is hashed rather than stored:
 * these documents are operational plumbing, and there is no reason to keep a
 * log of who called from where in order to count requests.
 */
export function bucketKey(canonicalIp: string): string {
  return crypto.createHash('sha256').update(canonicalIp).digest('hex').slice(0, 32);
}

function currentBucket(nowMs: number): number {
  return Math.floor(nowMs / 1000 / WINDOW_SECONDS);
}

/** Drop entries from expired windows once the cache grows past its cap. */
function prune(bucket: number): void {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  for (const [key, entry] of cache) {
    if (entry.bucket !== bucket) cache.delete(key);
  }
  // Still oversized means this window genuinely has that many distinct
  // callers; clear outright rather than grow without bound. Counts survive in
  // Firestore, so this costs accuracy only until the next read.
  if (cache.size > MAX_CACHE_ENTRIES) cache.clear();
}

async function flush(
  db: admin.firestore.Firestore,
  key: string,
  entry: CacheEntry,
  resetAt: number
): Promise<void> {
  const delta = entry.pending;
  entry.pending = 0;

  const ref = db.collection(COLLECTION).doc(`${key}_${entry.bucket}`);
  try {
    if (delta > 0) {
      await ref.set(
        {
          count: FieldValue.increment(delta),
          // Retained one window past reset so a TTL policy on `expiresAt` can
          // reclaim these without a cleanup job.
          expiresAt: Timestamp.fromMillis((resetAt + WINDOW_SECONDS) * 1000),
        },
        { merge: true }
      );
    }
    const snapshot = await ref.get();
    const count = snapshot.data()?.count;
    entry.confirmed = typeof count === 'number' ? count : delta;
    entry.syncedAt = Date.now();
  } catch (error) {
    // Put the delta back so it is retried, and keep counting locally. A
    // Firestore outage degrades the limiter to per-instance accuracy rather
    // than taking the endpoint down with it.
    entry.pending += delta;
    console.error(`Rate limit flush failed for bucket ${key}:`, error);
  }
}

/**
 * Record one request against `key` and decide whether it may proceed.
 * Never throws: a limiter failure must not become an API failure.
 */
export async function consume(
  db: admin.firestore.Firestore,
  key: string,
  limit: number,
  nowMs: number = Date.now()
): Promise<RateLimitDecision> {
  const bucket = currentBucket(nowMs);
  const resetAt = (bucket + 1) * WINDOW_SECONDS;
  const retryAfter = Math.max(1, resetAt - Math.floor(nowMs / 1000));

  let entry = cache.get(key);
  if (!entry || entry.bucket !== bucket) {
    entry = { bucket, confirmed: 0, pending: 0, syncedAt: 0 };
    cache.set(key, entry);
    prune(bucket);
  }

  // Already known to be spent. Refuse without any Firestore work, so a client
  // ignoring 429s costs nothing to keep refusing.
  if (entry.confirmed >= limit) {
    return { allowed: false, limit, remaining: 0, resetAt, retryAfter };
  }

  entry.pending += 1;
  const projected = entry.confirmed + entry.pending;

  const stale = nowMs - entry.syncedAt >= SYNC_INTERVAL_MS;
  const nearLimit = projected > limit * STRICT_FRACTION;
  if (entry.syncedAt === 0 || stale || nearLimit) {
    await flush(db, key, entry, resetAt);
  }

  const used = entry.confirmed + entry.pending;
  const allowed = used <= limit;

  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - used),
    resetAt,
    retryAfter,
  };
}

/** Standard rate-limit headers, set on every response including 429s. */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(decision.limit),
    'X-RateLimit-Remaining': String(decision.remaining),
    'X-RateLimit-Reset': String(decision.resetAt),
  };
  if (!decision.allowed) headers['Retry-After'] = String(decision.retryAfter);
  return headers;
}

/** Test seam: drop cached windows so a test starts from a known state. */
export function resetCacheForTesting(): void {
  cache.clear();
}
