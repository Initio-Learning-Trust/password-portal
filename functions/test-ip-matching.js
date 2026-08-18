// Tests for CIDR matching and client-IP resolution.
//   npm run build && node test-ip-matching.js
//
// The resolveClient cases are the important ones: they encode the attacks the
// allowlist has to survive, since an IP alone is enough to claim elevated
// quota.

const { parseCidr, cidrContains, canonicalizeIp, normalizeIp, isValidIpOrCidr, parseCidrList } = require('./lib/utils/cidr');
const { resolveClient } = require('./lib/utils/clientIp');

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
  }
}

function inCidr(cidrText, ip) {
  const cidr = parseCidr(cidrText);
  return cidr ? cidrContains(cidr, ip) : null;
}

console.log('\nCIDR matching');
check('v4 /24 contains member', inCidr('203.0.113.0/24', '203.0.113.7'), true);
check('v4 /24 excludes neighbour', inCidr('203.0.113.0/24', '203.0.114.7'), false);
check('v4 bare address is /32', inCidr('203.0.113.7', '203.0.113.7'), true);
check('v4 bare address excludes other', inCidr('203.0.113.7', '203.0.113.8'), false);
check('v4 /32 boundary', inCidr('10.0.0.1/32', '10.0.0.1'), true);
check('v4 /0 matches everything', inCidr('0.0.0.0/0', '198.51.100.9'), true);
check('v4 /31 upper', inCidr('10.0.0.0/31', '10.0.0.1'), true);
check('v4 /31 excludes .2', inCidr('10.0.0.0/31', '10.0.0.2'), false);
check('non-aligned prefix is masked', inCidr('203.0.113.77/24', '203.0.113.1'), true);

console.log('\nIPv6');
check('v6 /32 contains', inCidr('2001:db8::/32', '2001:db8:1234::1'), true);
check('v6 /32 excludes', inCidr('2001:db8::/32', '2001:db9::1'), false);
check('v6 compressed equals expanded', canonicalizeIp('2001:db8::1'), canonicalizeIp('2001:0db8:0000:0000:0000:0000:0000:0001'));
check('v6 loopback', inCidr('::1/128', '::1'), true);
check('v6 /0 matches', inCidr('::/0', '2001:db8::5'), true);
check('v4 does not match v6 prefix', inCidr('::/0', '203.0.113.7'), false);
check('v6 does not match v4 prefix', inCidr('0.0.0.0/0', '2001:db8::5'), false);

console.log('\nNormalisation');
check('strips v4 port', normalizeIp('203.0.113.7:443'), '203.0.113.7');
check('strips brackets', normalizeIp('[2001:db8::1]'), '2001:db8::1');
check('strips bracketed port', normalizeIp('[2001:db8::1]:443'), '2001:db8::1');
check('strips zone index', normalizeIp('fe80::1%eth0'), 'fe80::1');
check('unwraps v4-mapped v6', normalizeIp('::ffff:203.0.113.7'), '203.0.113.7');
check('mapped and bare share identity', canonicalizeIp('::ffff:203.0.113.7'), canonicalizeIp('203.0.113.7'));
check('mapped v6 matches v4 prefix', inCidr('203.0.113.0/24', '::ffff:203.0.113.7'), true);
check('trims whitespace', normalizeIp('  203.0.113.7  '), '203.0.113.7');
check('uppercase v6 folds', canonicalizeIp('2001:DB8::1'), canonicalizeIp('2001:db8::1'));

console.log('\nRejects malformed input');
check('leading zero octet', isValidIpOrCidr('010.0.0.1'), false);
check('octet over 255', isValidIpOrCidr('256.0.0.1'), false);
check('three octets', isValidIpOrCidr('1.2.3'), false);
check('prefix over 32', isValidIpOrCidr('10.0.0.0/33'), false);
check('v6 prefix over 128', isValidIpOrCidr('2001:db8::/129'), false);
check('double compression', isValidIpOrCidr('2001::db8::1'), false);
check('empty string', isValidIpOrCidr(''), false);
check('not an address', isValidIpOrCidr('example.com'), false);
check('negative prefix', isValidIpOrCidr('10.0.0.0/-1'), false);
check('list skips bad entries', parseCidrList('10.0.0.0/8, nonsense, 192.168.0.0/16').length, 2);

// --- Client IP resolution -------------------------------------------------
// Scenario: one proxy appends between the client and us, and it comes from
// 10.0.0.0/8. So the real client is the 2nd entry from the right.
const CONFIG = { hops: 1, trustedProxies: parseCidrList('10.0.0.0/8') };
const OPEN = { hops: null, trustedProxies: [] };

const req = (xff, socketAddr) => ({
  headers: xff === null ? {} : { 'x-forwarded-for': xff },
  socket: { remoteAddress: socketAddr || '10.0.0.9' },
});

console.log('\nClient IP resolution');
let r = resolveClient(req('203.0.113.7, 10.0.0.9'), CONFIG);
check('honest request resolves client', [r.ip, r.trusted], ['203.0.113.7', true]);

// The headline attack: caller prepends the allowlisted address hoping we read
// chain[0]. We count from the right, so they only reach their own position.
r = resolveClient(req('203.0.113.7, 198.51.100.66, 10.0.0.9'), CONFIG);
check('prefixed forgery does not win', [r.ip, r.trusted], ['198.51.100.66', true]);

// Shorter route (raw function URL, no Hosting hop). The entry that would sit
// in the trusted position is attacker-supplied, so the suffix check must fire.
r = resolveClient(req('203.0.113.7, 198.51.100.66'), CONFIG);
check('short chain is untrusted', r.trusted, false);
check('short chain names a reason', typeof r.reason, 'string');

r = resolveClient(req('203.0.113.7'), CONFIG);
check('single-entry chain untrusted', r.trusted, false);

// Padding the left to reach the expected length must not help either. The
// candidate position lands on the forged 203.0.113.7, but the hop to its right
// is not a known proxy, so trust is refused and we fall back to billing the
// right-most (infrastructure-written) entry.
r = resolveClient(req('1.1.1.1, 2.2.2.2, 203.0.113.7, 198.51.100.66'), CONFIG);
check('left padding cannot shift trust', r.trusted, false);
check('rejected candidate is not billed', r.ip, '198.51.100.66');

r = resolveClient(req(null), CONFIG);
check('missing XFF is untrusted', r.trusted, false);

r = resolveClient(req('203.0.113.7, 10.0.0.9'), OPEN);
check('unconfigured disables trust', r.trusted, false);
check('unconfigured still yields a key', r.key !== null, true);

r = resolveClient(req('203.0.113.7, 10.0.0.9'), { hops: 1, trustedProxies: [] });
check('no trusted prefixes disables trust', r.trusted, false);

// Untrusted callers must still be counted, and counted separately.
const a = resolveClient(req('198.51.100.1'), CONFIG);
const b = resolveClient(req('198.51.100.2'), CONFIG);
check('distinct untrusted callers get distinct keys', a.key !== b.key, true);

r = resolveClient(req('::ffff:203.0.113.7, 10.0.0.9'), CONFIG);
check('mapped client normalises', r.ip, '203.0.113.7');

r = resolveClient(req('203.0.113.7 ,  10.0.0.9 '), CONFIG);
check('whitespace tolerated', [r.ip, r.trusted], ['203.0.113.7', true]);

r = resolveClient(req('garbage, 10.0.0.9'), CONFIG);
check('unparseable client entry dropped from chain', r.ip, '10.0.0.9');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
