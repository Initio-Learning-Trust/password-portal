// Cached access to the Firestore `ip_whitelist` collection.
//
// One collection now carries two independent grants, because conflating them
// would be a quiet privilege escalation: raising a caller's generation quota
// must not also hand them the ability to mint password links.
//
//   allowApi       gates POST /api (link creation)
//   generateLimit  raises the hourly quota on the generation endpoints
//
// `allowApi` is absent on documents written before this split, and those were
// all created to grant API access, so undefined reads as true. New entries
// added through Settings default it to false.

import * as admin from 'firebase-admin';
import type { Cidr } from './cidr';
import { matchCidr, parseCidr } from './cidr';

const CACHE_TTL_MS = 5 * 60 * 1000;

export interface AllowlistEntry {
  id: string;
  /** Original text, e.g. "203.0.113.7" or "203.0.113.0/24". */
  source: string;
  cidr: Cidr;
  description: string;
  allowApi: boolean;
  /** Hourly generation quota, or null to use the public default. */
  generateLimit: number | null;
}

interface AllowlistCache {
  entries: AllowlistEntry[];
  loadedAt: number;
}

let cache: AllowlistCache | null = null;

function toEntry(id: string, data: admin.firestore.DocumentData): AllowlistEntry | null {
  const source = typeof data.ip === 'string' ? data.ip.trim() : '';
  if (!source) return null;

  const cidr = parseCidr(source);
  if (!cidr) {
    // One malformed row must not break matching for every other row.
    console.warn(`Skipping ip_whitelist/${id}: "${source}" is not a valid IP or CIDR`);
    return null;
  }

  const rawLimit = data.generateLimit;
  const generateLimit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.floor(rawLimit)
      : null;

  return {
    id,
    source,
    cidr,
    description: typeof data.description === 'string' ? data.description : '',
    allowApi: data.allowApi !== false,
    generateLimit,
  };
}

async function load(db: admin.firestore.Firestore): Promise<AllowlistEntry[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.entries;

  try {
    const snapshot = await db.collection('ip_whitelist').get();
    const entries = snapshot.docs
      .map((doc) => toEntry(doc.id, doc.data()))
      .filter((entry): entry is AllowlistEntry => entry !== null);
    cache = { entries, loadedAt: Date.now() };
  } catch (error) {
    console.error('Failed to load IP allowlist:', error);
    if (!cache) throw error; // No cached copy: the caller must fail closed.
  }

  return cache.entries;
}

/**
 * The allowlist entry covering `ip`, or null. Most specific prefix wins, so a
 * /32 override beats the /16 it sits inside.
 */
export async function findEntry(
  db: admin.firestore.Firestore,
  ip: string
): Promise<AllowlistEntry | null> {
  const entries = await load(db);
  let best: AllowlistEntry | null = null;
  for (const entry of entries) {
    if (matchCidr([entry.cidr], ip) && (!best || entry.cidr.bits > best.cidr.bits)) {
      best = entry;
    }
  }
  return best;
}

export interface ApiGateResult {
  /** True when at least one entry grants API access, i.e. the gate is active. */
  configured: boolean;
  allowed: boolean;
}

/**
 * Decide whether `ip` may call POST /api.
 *
 * Preserves the original rule that an unconfigured allowlist permits any
 * address. "Unconfigured" deliberately means "no entry grants API access" —
 * not "the collection is empty" — so a deployment whose only entries are
 * generation-quota entries behaves exactly as it did before those existed,
 * rather than silently locking every caller out.
 */
export async function checkApiAccess(
  db: admin.firestore.Firestore,
  ip: string
): Promise<ApiGateResult> {
  const entries = await load(db);
  const apiEntries = entries.filter((entry) => entry.allowApi);
  if (apiEntries.length === 0) return { configured: false, allowed: true };
  return { configured: true, allowed: matchCidr(apiEntries.map((e) => e.cidr), ip) !== null };
}

/** Test seam. */
export function resetCacheForTesting(): void {
  cache = null;
}
