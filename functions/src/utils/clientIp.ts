// Resolving the real client IP from behind Google's front end.
//
// This is security-critical: the rate-limit allowlist grants elevated quota
// purely on the strength of an IP, so a caller who can influence which address
// we resolve can help themselves to someone else's limit.
//
// The rule that makes it safe: `X-Forwarded-For` is *append-only*. Anything a
// client sends arrives as a prefix, and every proxy in front of us appends its
// view of who it heard from. So the trustworthy entry is a fixed number of
// hops from the RIGHT, never `chain[0]`, and every entry to the right of it
// must itself be one of our known proxies. That is the same model as nginx's
// `set_real_ip_from` + `real_ip_recursive`.
//
// Both facts are deployment-specific, so both are configuration rather than
// guesses baked into the code. Until an operator supplies them, elevation is
// disabled and every caller gets the default tier — see `docs/API.md`.

import type { Cidr } from './cidr';
import { canonicalizeIp, matchCidr, normalizeIp } from './cidr';

export interface ProxyConfig {
  /**
   * How many proxies append to XFF between the real client and this function.
   * null when unconfigured, which disables elevation.
   */
  hops: number | null;
  /** Prefixes those appending proxies are expected to come from. */
  trustedProxies: Cidr[];
}

export interface ResolvedClient {
  /** Display form of the resolved address, or 'unknown'. */
  ip: string;
  /** Stable bucket identity for rate limiting, or null when unresolvable. */
  key: string | null;
  /** The parsed XFF chain, left (client-supplied) to right (nearest proxy). */
  chain: string[];
  /**
   * True only when the address is provably infrastructure-attested and may
   * therefore be matched against the allowlist for elevated quota.
   */
  trusted: boolean;
  /** Why `trusted` is false, for logs and the /whoami diagnostic. */
  reason?: string;
}

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  ip?: string;
}

function readChain(req: RequestLike): string[] {
  const raw = req.headers['x-forwarded-for'];
  const text = Array.isArray(raw) ? raw.join(',') : raw || '';
  return text
    .split(',')
    .map((entry) => normalizeIp(entry))
    .filter((entry): entry is string => entry !== null);
}

/**
 * Resolve the caller's address and decide whether it is trustworthy enough to
 * grant elevated quota. Always returns a usable bucket key when it can, even
 * when the address is untrusted — an untrusted caller still gets rate limited,
 * just never elevated.
 */
export function resolveClient(req: RequestLike, config: ProxyConfig): ResolvedClient {
  const chain = readChain(req);
  const socket = normalizeIp(req.socket?.remoteAddress || req.ip || '');

  // Fallback identity, used whenever the address cannot be trusted. The
  // right-most entry is the one written by the nearest proxy, so it is the
  // least forgeable thing available even if it is not the true client.
  const fallback = chain.length > 0 ? chain[chain.length - 1] : socket;

  const untrusted = (reason: string): ResolvedClient => ({
    ip: fallback || 'unknown',
    key: fallback ? canonicalizeIp(fallback) : null,
    chain,
    trusted: false,
    reason,
  });

  if (config.hops === null) {
    return untrusted('proxy hop count is not configured');
  }
  if (config.trustedProxies.length === 0 && config.hops > 0) {
    return untrusted('no trusted proxy prefixes are configured');
  }
  if (chain.length === 0) {
    return untrusted('no X-Forwarded-For header on the request');
  }

  const index = chain.length - 1 - config.hops;
  if (index < 0) {
    // Fewer entries than the configured chain depth. Either the request came
    // in by a route we are not configured for, or the config is wrong. Either
    // way we cannot say who the client is.
    return untrusted(
      `chain has ${chain.length} entr${chain.length === 1 ? 'y' : 'ies'}, need more than ${config.hops}`
    );
  }

  // Everything to the right of the client must be one of our own proxies.
  // This is what stops a caller reaching us by a shorter route (for example
  // the raw *.cloudfunctions.net URL, which has fewer hops) and sliding a
  // forged address into the position we would otherwise trust.
  const suffix = chain.slice(index + 1);
  for (const hop of suffix) {
    if (!matchCidr(config.trustedProxies, hop)) {
      return untrusted(`proxy hop ${hop} is not in the trusted proxy list`);
    }
  }

  const client = chain[index];
  const key = canonicalizeIp(client);
  if (!key) {
    return untrusted(`resolved address ${client} is not a valid IP`);
  }

  return { ip: client, key, chain, trusted: true };
}
