// Test harness for X/Twitter link detection.
//
// This imports the REAL extractUsernameFromXLink / isXLink implementations
// from lib/, which are the exact same modules the bot files require at
// runtime (alpha/alpha.js, elite/alpha.js, xlike/xlike.js -> xlink-basic.js;
// xtracking.js -> xlink-standard.js; xtracking/xtracking.js -> xlink-advanced.js).
//
// There are three separate implementations because the bots have diverged
// over time - this harness runs every case against all three and reports
// where they disagree, so a difference is a signal to check, not something
// this file papers over.
//
// Run: node scripts/test_link_detection.js

const path = require('path');
const basic = require(path.join('..', 'lib', 'xlink-basic.js'));
const standard = require(path.join('..', 'lib', 'xlink-standard.js'));
const advanced = require(path.join('..', 'lib', 'xlink-advanced.js'));

const IMPLS = [
  { name: 'basic    (alpha/elite/xlike)', key: 'basic', mod: basic },
  { name: 'standard (xtracking.js)', key: 'standard', mod: standard },
  { name: 'advanced (xtracking/xtracking.js)', key: 'advanced', mod: advanced },
];

// Deterministic cases only: no /status/<id> shortlinks here, since those
// require live network calls to Twitter's oEmbed/syndication endpoints and
// are not reproducible in an isolated test run. Each expected value is
// per-implementation because the three deliberately (or not) behave
// differently - see KNOWN DIVERGENCES in the printed output below.
const cases = [
  {
    input: 'https://x.com/username',
    isXLink: { basic: true, standard: true, advanced: true },
    // standard returns null even for a plain profile link with no /status/
    // in it - see KNOWN DIVERGENCES #3.
    extract: { basic: 'username', standard: null, advanced: 'username' },
  },
  {
    input: 'http://x.com/username',
    isXLink: { basic: true, standard: true, advanced: true },
    extract: { basic: 'username', standard: null, advanced: 'username' },
  },
  {
    input: 'https://www.x.com/username',
    isXLink: { basic: true, standard: true, advanced: true },
    extract: { basic: 'username', standard: null, advanced: 'username' },
  },
  {
    input: 'https://twitter.com/username',
    isXLink: { basic: true, standard: true, advanced: true },
    extract: { basic: 'username', standard: null, advanced: 'username' },
  },
  {
    input: 'x.com/username', // no protocol
    isXLink: { basic: false, standard: false, advanced: false },
    // NOTE: advanced still returns a value despite isXLink saying "not a
    // link" - see KNOWN DIVERGENCES #1. standard is null here regardless,
    // per #3.
    extract: { basic: null, standard: null, advanced: 'username' },
  },
  {
    input: 'https://x.com/username?param=value',
    isXLink: { basic: true, standard: true, advanced: true },
    // BUG: basic does not strip query strings from the captured username.
    // standard requires a /status/<id> to return anything (see below), so
    // a bare profile link + query string still returns null for it.
    extract: { basic: 'username?param=value', standard: null, advanced: 'username' },
  },
  {
    input: 'x.com/username/subpath',
    isXLink: { basic: false, standard: false, advanced: false },
    extract: { basic: null, standard: null, advanced: 'username' },
  },
  {
    input: 'not a link x.com/',
    isXLink: { basic: false, standard: false, advanced: false },
    extract: { basic: null, standard: null, advanced: null },
  },
  {
    input: 'some random text with https://x.com/username somewhere',
    isXLink: { basic: true, standard: true, advanced: true },
    // BUG: basic's capture group doesn't stop at whitespace and the result
    // is never re-validated, so surrounding text gets swept into the
    // "username". advanced hits the same greedy capture but DOES validate
    // afterward (rejects anything that isn't ^[a-z0-9_]{1,25}$), so it
    // correctly discards the bad match and returns null instead of garbage.
    extract: { basic: 'username somewhere', standard: null, advanced: null },
  },
  {
    input: '',
    isXLink: { basic: false, standard: false, advanced: false },
    extract: { basic: null, standard: null, advanced: null },
  },
  {
    input: null,
    isXLink: { basic: false, standard: false, advanced: false },
    extract: { basic: null, standard: null, advanced: null },
  },
];

async function run() {
  let pass = 0;
  let fail = 0;

  for (const c of cases) {
    console.log(`\nInput: ${JSON.stringify(c.input)}`);
    for (const { name, key, mod } of IMPLS) {
      const gotIsX = mod.isXLink(c.input);
      const gotExtract = await mod.extractUsernameFromXLink(c.input);
      const wantIsX = c.isXLink[key];
      const wantExtract = c.extract[key];

      const isXOk = gotIsX === wantIsX;
      const extractOk = gotExtract === wantExtract;
      if (isXOk && extractOk) pass++; else fail++;

      const status = (isXOk && extractOk) ? 'PASS' : 'FAIL';
      console.log(
        `  [${status}] ${name.padEnd(34)} isXLink=${String(gotIsX).padEnd(5)} ` +
        `extract=${JSON.stringify(gotExtract)}` +
        (extractOk && isXOk ? '' : `  (expected isXLink=${wantIsX}, extract=${JSON.stringify(wantExtract)})`)
      );
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${pass} passed, ${fail} failed (deterministic, non-network cases only)`);
  console.log('='.repeat(60));

  console.log(`
KNOWN DIVERGENCES between the three real implementations
(none of this is "fixed" here - it's what's actually shipped):

1. Bare URLs without a protocol (e.g. "x.com/username"):
   - basic (alpha/elite/xlike) and standard (xtracking.js): extract
     returns null.
   - advanced (xtracking/xtracking.js): extract still returns
     "username" even though isXLink says it's NOT a link (isXLink is
     shared/identical across all three and requires http(s)://). Code
     paths that gate on isXLink() before calling
     extractUsernameFromXLink() won't hit this; anything that calls
     extractUsernameFromXLink() directly on unvalidated text can.

2. Query strings / fragments (e.g. "?param=value"):
   - basic does NOT strip them - "https://x.com/username?param=value"
     extracts as the literal string "username?param=value", not
     "username". This is a real bug: any exact-match comparison against
     a clean username (mutes, bans, dedupe checks) will silently fail
     to match a link that has tracking/query parameters on it.
   - standard/advanced correctly stop at "?" and "#".

3. Extra surrounding text is swept into the username by basic:
   - "some random text with https://x.com/username somewhere" extracts
     as "username somewhere" under basic - the capture group doesn't
     stop at whitespace, and the result is never re-validated.
   - advanced hits the same greedy capture internally but DOES validate
     the result afterward against ^[a-z0-9_]{1,25}$ and rejects it,
     correctly falling through to null instead of returning garbage.
   - standard returns null here too, but only because it requires a
     /status/<id> for anything to work at all (see #4).

4. Plain profile links in xtracking.js (root file) specifically:
   - standard's extractUsernameFromXLink ONLY resolves usernames from
     tweet/status URLs (it looks for /status/<id> and returns null
     immediately if there isn't one - see lib/xlink-standard.js).
   - The project README documents the expected submission format as a
     plain profile link: "https://x.com/username" (no /status/).
   - Net effect: xtracking.js cannot extract a username from a link in
     the documented format at all. Only xtracking/xtracking.js
     (advanced) and alpha/elite/xlike (basic) handle plain profile
     links.

Network-dependent paths (oEmbed / syndication / HTML scraping fallback
for shortened "/i/status/<id>" links) are intentionally not covered
here - they require live calls to Twitter's endpoints and can't be
asserted in an isolated test run.
`);

  process.exitCode = fail > 0 ? 1 : 0;
}

run();
