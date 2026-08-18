// IPv4/IPv6 address and CIDR-prefix matching.
//
// Used by both the rate-limit tier lookup and the `POST /api` IP gate, so a
// single set of rules governs every allowlist comparison in the codebase.
// Deliberately dependency-free: the whole job is parse-to-integer and mask.

export interface ParsedIp {
  version: 4 | 6;
  value: bigint;
}

export interface Cidr {
  version: 4 | 6;
  base: bigint;
  bits: number;
  /** The original text, kept for logging and error messages. */
  source: string;
}

const V4_BITS = 32;
const V6_BITS = 128;

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    // Reject leading zeros: "010" is ambiguous (octal in some parsers) and
    // allowing it would let one address be written two ways.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function ipv6ToBigInt(ip: string): bigint | null {
  let text = ip;

  // An IPv6 address may end with dotted-quad IPv4 notation (::ffff:1.2.3.4).
  // Rewrite that tail into two hex groups so the rest of the parse is uniform.
  const lastColon = text.lastIndexOf(':');
  if (lastColon !== -1 && text.slice(lastColon + 1).includes('.')) {
    const embedded = ipv4ToBigInt(text.slice(lastColon + 1));
    if (embedded === null) return null;
    const high = ((embedded >> 16n) & 0xffffn).toString(16);
    const low = (embedded & 0xffffn).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  let groups: string[];
  if (halves.length === 1) {
    // No "::" compression, so every one of the 8 groups must be written out.
    if (head.length !== 8) return null;
    groups = head;
  } else {
    // "::" must stand for at least one zero group, hence 7 not 8.
    if (head.length + tail.length > 7) return null;
    const fill = new Array(8 - head.length - tail.length).fill('0');
    groups = [...head, ...fill, ...tail];
  }

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/**
 * Reduce an address to bare text: no brackets, no port, no IPv6 zone index,
 * lowercase, and with IPv4-mapped IPv6 (::ffff:1.2.3.4) unwrapped to plain
 * IPv4. Unwrapping matters — otherwise the same host reaches us under two
 * spellings and lands in two different rate-limit buckets.
 */
export function normalizeIp(raw: string): string | null {
  let text = (raw || '').trim();
  if (!text) return null;

  if (text.startsWith('[')) {
    // Bracketed IPv6, optionally with ":port" after the closing bracket.
    const end = text.indexOf(']');
    if (end === -1) return null;
    text = text.slice(1, end);
  } else if (text.includes('.') && (text.match(/:/g) || []).length === 1) {
    // IPv4 with a port. A bare IPv6 always has 2+ colons, so this cannot
    // misfire on one.
    text = text.slice(0, text.indexOf(':'));
  }

  text = text.split('%')[0].toLowerCase();

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (mapped) text = mapped[1];

  return text || null;
}

export function parseIp(raw: string): ParsedIp | null {
  const text = normalizeIp(raw);
  if (!text) return null;

  if (text.includes(':')) {
    const value = ipv6ToBigInt(text);
    return value === null ? null : { version: 6, value };
  }

  const value = ipv4ToBigInt(text);
  return value === null ? null : { version: 4, value };
}

/**
 * A stable string identity for an address, used as a rate-limit bucket key.
 * Two spellings of one address always produce the same identity.
 */
export function canonicalizeIp(raw: string): string | null {
  const parsed = parseIp(raw);
  return parsed ? `v${parsed.version}:${parsed.value.toString(16)}` : null;
}

function maskFor(version: 4 | 6, bits: number): bigint {
  const total = version === 4 ? V4_BITS : V6_BITS;
  const hostBits = BigInt(total - bits);
  return ((1n << BigInt(total)) - 1n) ^ ((1n << hostBits) - 1n);
}

/**
 * Parse "1.2.3.4", "1.2.3.0/24", "2001:db8::/32". A bare address is treated
 * as a single-host prefix (/32 or /128).
 */
export function parseCidr(input: string): Cidr | null {
  const source = (input || '').trim();
  if (!source) return null;

  const slash = source.indexOf('/');
  const addrText = slash === -1 ? source : source.slice(0, slash);
  const bitsText = slash === -1 ? null : source.slice(slash + 1);

  const parsed = parseIp(addrText);
  if (!parsed) return null;

  const total = parsed.version === 4 ? V4_BITS : V6_BITS;
  let bits = total;
  if (bitsText !== null) {
    if (!/^\d{1,3}$/.test(bitsText)) return null;
    bits = Number(bitsText);
    if (bits > total) return null;
  }

  return {
    version: parsed.version,
    base: parsed.value & maskFor(parsed.version, bits),
    bits,
    source,
  };
}

/** True when `ip` falls inside `cidr`. Mixed address families never match. */
export function cidrContains(cidr: Cidr, ip: ParsedIp | string): boolean {
  const parsed = typeof ip === 'string' ? parseIp(ip) : ip;
  if (!parsed || parsed.version !== cidr.version) return false;
  return (parsed.value & maskFor(cidr.version, cidr.bits)) === cidr.base;
}

/** The first prefix in `cidrs` containing `ip`, or null. */
export function matchCidr(cidrs: Cidr[], ip: ParsedIp | string): Cidr | null {
  const parsed = typeof ip === 'string' ? parseIp(ip) : ip;
  if (!parsed) return null;
  for (const cidr of cidrs) {
    if (cidrContains(cidr, parsed)) return cidr;
  }
  return null;
}

/** Validates operator input before it is written to Firestore. */
export function isValidIpOrCidr(input: string): boolean {
  return parseCidr(input) !== null;
}

/** Parse a comma/whitespace separated prefix list, skipping invalid entries. */
export function parseCidrList(input: string): Cidr[] {
  return (input || '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const cidr = parseCidr(entry);
      if (!cidr) console.warn(`Ignoring unparseable CIDR entry: ${entry}`);
      return cidr;
    })
    .filter((cidr): cidr is Cidr => cidr !== null);
}
