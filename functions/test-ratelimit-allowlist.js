// Integration tests against the Firestore emulator.
//   firebase emulators:start --only functions,firestore --project demo-test
//   node test-ratelimit-allowlist.js
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-test';

const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'demo-test' });
const db = admin.firestore();

const { consume, bucketKey, resetCacheForTesting } = require('./lib/utils/rateLimit');
const { checkApiAccess, findEntry, resetCacheForTesting: resetAllowlist } = require('./lib/utils/allowlist');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`); }
}

async function clear(collection) {
  const snap = await db.collection(collection).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function testRateLimit() {
  console.log('\nRate limiting');
  await clear('rate_limits');
  resetCacheForTesting();

  const key = bucketKey('v4:test-limit-a');
  const limit = 5;
  const results = [];
  for (let i = 0; i < 7; i++) {
    results.push(await consume(db, key, limit));
  }

  check('first request allowed', results[0].allowed, true);
  check('remaining counts down', results[0].remaining, 4);
  check('request at the limit still allowed', results[4].allowed, true);
  check('remaining hits zero at limit', results[4].remaining, 0);
  check('request past the limit denied', results[5].allowed, false);
  check('stays denied', results[6].allowed, false);
  check('denied reports retryAfter', results[5].retryAfter > 0, true);
  check('limit echoed', results[5].limit, 5);

  // A separate caller must have its own budget.
  const other = await consume(db, bucketKey('v4:test-limit-b'), limit);
  check('separate key has a fresh budget', [other.allowed, other.remaining], [true, 4]);

  // The persisted total should reflect what was counted, not what was allowed.
  resetCacheForTesting();
  const fresh = await consume(db, key, limit);
  check('count survives an instance restart', fresh.allowed, false);
}

async function testAllowlist() {
  console.log('\nAllowlist: API gate');
  await clear('ip_whitelist');
  resetAllowlist();

  // No entries at all: the gate is open, as it always was.
  check('empty allowlist leaves API open', await checkApiAccess(db, '198.51.100.1'), { configured: false, allowed: true });

  // Generation-only entry. This is the regression that matters: adding a quota
  // entry must not switch the API gate on and lock out every existing caller.
  await db.collection('ip_whitelist').add({
    ip: '203.0.113.0/24', description: 'server range', allowApi: false, generateLimit: 50000,
  });
  resetAllowlist();
  check('generation-only entry leaves API open', await checkApiAccess(db, '198.51.100.1'), { configured: false, allowed: true });

  // Now add a real API entry; the gate closes for everyone else.
  await db.collection('ip_whitelist').add({
    ip: '198.51.100.0/24', description: 'office', allowApi: true,
  });
  resetAllowlist();
  check('API entry closes the gate', await checkApiAccess(db, '10.1.2.3'), { configured: true, allowed: false });
  check('in-range address allowed', await checkApiAccess(db, '198.51.100.77'), { configured: true, allowed: true });
  check('generation range does not grant API', await checkApiAccess(db, '203.0.113.9'), { configured: true, allowed: false });

  // Legacy documents predate allowApi and were all created to grant API access.
  await clear('ip_whitelist');
  resetAllowlist();
  await db.collection('ip_whitelist').add({ ip: '192.0.2.5', description: 'legacy row' });
  resetAllowlist();
  check('legacy entry still grants API', await checkApiAccess(db, '192.0.2.5'), { configured: true, allowed: true });
  check('legacy entry still blocks others', await checkApiAccess(db, '192.0.2.6'), { configured: true, allowed: false });

  console.log('\nAllowlist: generation tiers');
  await clear('ip_whitelist');
  resetAllowlist();
  await db.collection('ip_whitelist').add({ ip: '203.0.113.0/24', allowApi: false, generateLimit: 20000 });
  await db.collection('ip_whitelist').add({ ip: '203.0.113.7', allowApi: false, generateLimit: 50000 });
  resetAllowlist();

  const broad = await findEntry(db, '203.0.113.20');
  check('range entry matched', broad && broad.generateLimit, 20000);
  const specific = await findEntry(db, '203.0.113.7');
  check('most specific prefix wins', specific && specific.generateLimit, 50000);
  check('outside range has no entry', await findEntry(db, '198.51.100.1'), null);

  // A malformed row must not take the rest of the allowlist down with it.
  await db.collection('ip_whitelist').add({ ip: 'not-an-ip', allowApi: false, generateLimit: 9999 });
  resetAllowlist();
  const stillWorks = await findEntry(db, '203.0.113.7');
  check('malformed row is skipped, others still match', stillWorks && stillWorks.generateLimit, 50000);
}

(async () => {
  try {
    await testRateLimit();
    await testAllowlist();
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (error) {
    console.error('Test run failed:', error);
    process.exit(1);
  }
})();
