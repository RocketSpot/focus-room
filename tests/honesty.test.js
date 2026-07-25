'use strict';
// ============================================================
// tests/honesty.test.js — the honesty layer, empirically.
// Plain node, no framework:  node tests/honesty.test.js
// Exits non-zero on any failure.
//
// Covers the six empirical audit cases (three violations that used to slip
// through, three honest strings the old rules wrongly mangled), the standing
// disclaimers, a dozen realistic guest-copy strings from reads.js, and the
// strict/redact behavior of honest(). Also proves the module loads in plain
// node (the config require inside honesty.js is guarded).
// ============================================================
const path = require('path');
const { honest, vet, vetDeep, isClean, redact } = require(path.join(__dirname, '..', 'app', 'honesty.js'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.error(` FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function mustPass(s) {
  const v = vet(s);
  check(`passes: ${JSON.stringify(s)}`, v.length === 0, v.map((x) => `${x.rule}:"${x.match}"`).join(', '));
}
function mustCatch(s, why) {
  const v = vet(s);
  check(`catches [${why}]: ${JSON.stringify(s)}`, v.length > 0);
  if (v.length > 0) {
    const r = redact(s);
    check(`  …and redaction is clean: ${JSON.stringify(r)}`, isClean(r));
  }
}

// ---- the six empirical audit cases -----------------------------------------
console.log('\n-- empirical audit cases (previously wrong) --');
// used to PASS the rules — must now be caught
mustCatch('You scored 96 percent.', 'spelled-out percent');
mustCatch('You rated seven out of ten for focus.', 'spelled-out X out of Y');
mustCatch('It felt like you never dropped. But the measured signal shows a clear dip.', 'felt-vs-measured across two sentences');
// used to be wrongly MANGLED — must now pass untouched
mustPass('This isn’t a diagnosis — it’s one reading of your own session.');
mustPass('We don’t diagnose anything in this room.');
mustPass('It is not presented as a clinical score — only as your own shape today.');

// ---- the standing disclaimers must keep passing -----------------------------
console.log('\n-- honest disclaimers --');
mustPass('not a clinical score');
mustPass('This read is relative to your own session today — not a clinical score. Reply to this note if you’d like to come back.');
mustPass('No diagnosis, no disorder talk — one honest reading.');
mustPass('without any clinical claim');
mustPass('Never a clinical claim, never a percentage — your session, relative to itself.');

// ---- a dozen realistic guest-copy strings from reads.js ---------------------
console.log('\n-- realistic guest copy (reads.js) --');
[
  'You settled in at an even pace — no sharp switch-on, no long warm-up.',
  'You dropped into focus fast, almost from a cold start.',
  'You came in cold and climbed in slowly — a deliberate settle, not a fast switch-on.',
  'Once in, your focus ran remarkably even — steady, level focus is itself a finding, not a flat result.',
  'Once in, your focus moved in clear waves across your reading.',
  'This is the headline. One interruption hit while you were deep, and your line responded.',
  'This stretch ran highest, relative to the rest of your reading.',
  'Your focus barely moved — a small, honest dip you recovered from quickly.',
  'Your focus dropped sharply and took a real stretch to climb back.',
  'It actually ran highest in the middle — your best run today.',
  'You guessed the opening; it actually peaked in the middle.',
  'The signal was light around the interruption, so we keep this one honest and brief.',
].forEach(mustPass);

// composed card/profile/email copy from outputs.js stays clean too
console.log('\n-- composed output copy --');
mustPass('Here is how your focus moved during one reading today — measured against your own session, start to finish. No absolute scores. Just your own shape.');
mustPass('The interruption — sharp drop · long climb back.');
mustPass('You’d told us “A blip — I barely notice”');
mustPass('Today was one room and one reading. The roadmap is the same signal, every workday, for years — your focus learning its own shape over time.');

// ---- the original violation set must still be caught ------------------------
console.log('\n-- standing violations --');
mustCatch('Your focus score was 96% today.', 'digit percentage / numeric score');
// a % OF A RELATIVE FRAME is the honest expression the doc demands — the wall
// states these, so the card/email may quote the same sentences
mustPass('You were at your steady level 5 sec in, which is the first 5% of your reading.');
mustPass('It sat inside its steady band 53% of the time.');
mustPass('Right here your theta rhythm rose 25% above its session level.');
mustPass('Your strongest 10 sec sat 32% of your own range above your session average.');
mustCatch('Your engagement reached 87%.', 'naked percentage, no relative frame');
mustCatch('ninety-six per cent focus', 'spelled number + per cent');
mustCatch('You hit 7/10 on focus.', 'fraction score');
mustCatch('You held focus for 312 seconds.', 'to-the-second timing');
mustCatch('You recovered in 4.5 mins.', 'to-the-decimal timing');
// the room's honest grain is FIVE seconds (reads.js round5): the wall states
// those figures, so the card may quote the same ones — precision beyond the
// grain is still a violation
mustPass('Settled in 5 sec.');
mustPass('The notification cost 1 min 40 sec.');
mustCatch('You settled in 12.3 sec.', 'decimal seconds');
mustCatch('You settled in 47 sec.', 'off the 5-second grain');
mustCatch('Recovery took 230 ms.', 'millisecond theatre');
mustCatch('You felt focused, but your brain says otherwise.', 'felt-vs-measured, one sentence');
mustCatch('Your brain says you lost focus.', 'your-brain-says');
mustCatch('Signs of ADHD showed in your reading.', 'clinical framing');
mustCatch('a clinically significant dip', 'clinical framing');

// ---- honest(): strict throws, non-strict redacts ----------------------------
console.log('\n-- honest() behavior --');
let threw = false;
try { honest('You scored 96 percent.', 'test.strict', true); } catch (e) { threw = true; }
check('strict honest() throws on a violation', threw);

const red = honest('You scored 96 percent.', 'test.redact', false);
check('non-strict honest() redacts the violation', isClean(red) && red.indexOf('96') === -1 && red.indexOf('percent') === -1, JSON.stringify(red));

const cleanIn = 'Your read started cleanly and held.';
check('honest() passes clean copy through unchanged', honest(cleanIn, 'test.clean', true) === cleanIn);
check('honest() tolerates null', honest(null, 'test.null', true) === null);

const deep = vetDeep({ a: ['clean copy', 'You scored 96 percent.'], b: { c: 'not a clinical score' } });
check('vetDeep finds the one nested violation', deep.length === 1 && deep[0].path === 'a[1]', JSON.stringify(deep));

// ---- summary -----------------------------------------------------------------
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
