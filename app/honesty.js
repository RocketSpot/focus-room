'use strict';
// ============================================================
// honesty.js — the honesty copy layer (Document.pdf "What We Claim, What We
// Don't"). EVERY guest-facing string/number is routed through here. It makes it
// structurally impossible to emit:
//   1. an absolute or clinical score
//   2. a percentage presented as a focus score (digits or spelled out)
//   3. a to-the-second (or to-the-decimal) timing figure
//   4. a "you felt X but your brain says Y" comparison — even split across
//      two adjacent sentences
// All copy is relative ("in your session today"), directional, and about the
// guest's own session. If a value can't be expressed relatively, it is omitted.
//
// In dev/tests (not packaged) the layer THROWS on a violation (catch
// regressions loudly). In a packaged build it logs loudly and redacts/omits —
// a violation can never reach a guest, and can never kill an output.
// ============================================================

// spelled-out numbers ("seven", "ninety-six", "one hundred") for score phrasings
const NUMW = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)';
const NUM = `(?:\\d+(?:\\.\\d+)?|${NUMW}(?:[-\\s]${NUMW})*)`;
// negations that turn clinical wording into an honest DISCLAIMER ("not a
// clinical score", "this isn't a diagnosis", "we don't diagnose") — the plain
// n't token can never match inside a contraction, so the contractions are
// spelled out (straight + curly apostrophe), and the gap allows wording like
// "not presented as a clinical score".
const NEG = "(?:not|no|never|without|nothing|non|isn't|isn’t|aren't|aren’t|wasn't|wasn’t|weren't|weren’t|don't|don’t|doesn't|doesn’t|didn't|didn’t|won't|won’t|can't|can’t|cannot|couldn't|couldn’t|wouldn't|wouldn’t)";

const RULES = [
  // a percentage as a SCORE — digits ("96%") or spelled out ("96 percent",
  // "ninety-six per cent"). The reveal's own figures are percentages OF A
  // RELATIVE FRAME — "the first 5% of your reading", "53% of the time",
  // "rose 25% above its session level", "32% of your own range" — which is
  // exactly the relative expression the doc demands, and the wall already
  // states them. A % is allowed ONLY when its relative frame follows
  // immediately; a naked "96%" stays a violation.
  { name: 'percentage-score',
    re: new RegExp(`\\b\\d{1,3}(?:\\.\\d+)?\\s?%|\\b${NUM}\\s+(?:percent|per\\s?cent|percentage\\s+points?)\\b`, 'gi'),
    allow: (m) => {
      const tail = m.input.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase();
      return /^\s*(?:of (?:your|the time|its own|their own)|above|below|against)\b/.test(tail);
    } },
  // "7/10" and "X out of Y" score phrasings, digits or spelled out
  { name: 'fraction-score', re: new RegExp(`\\b\\d+(?:\\.\\d+)?\\s?\\/\\s?(?:10|100)\\b|\\b${NUM}\\s+out\\s+of\\s+(?:a\\s+)?${NUM}\\b`, 'gi') },
  { name: 'numeric-score', re: /\b(?:score|rating|points?|percentile|index)\b[^.]{0,16}?\d|\b\d+(?:\.\d+)?\s*(?:points?|percentile|\/\s?5)\b/gi },
  // a STOPWATCH-precision time figure. The room's honest measurement grain is
  // five seconds (reads.js round5 — "the room measures, it doesn't stopwatch"),
  // and the wall states those figures, so the card may quote the SAME ones
  // ("Settled in 5 sec."). What stays banned is precision the smoothed signal
  // can't carry: decimals, milliseconds, and second counts off the 5s grain
  // ("312 seconds", "12.3 sec", "230 ms").
  { name: 'to-the-second',
    re: /\b(\d+(?:\.\d+)?)\s?(seconds?|secs?|minutes?|mins?|milliseconds?|ms|s)\b/gi,
    allow: (m) => {
      const v = parseFloat(m[1]); const u = m[2].toLowerCase();
      if (u === 'ms' || u.startsWith('milli')) return false;  // stopwatch theatre, always
      if (u.startsWith('min')) return Number.isInteger(v);    // "3 min" fine, "4.5 mins" not
      return Number.isInteger(v) && v % 5 === 0;              // 5s grain: "5 sec", "40 sec"
    } },
  // felt-vs-measured / perceived-vs-actual — in one sentence, or split across
  // two adjacent sentences ("It felt like X. But the measured signal…")
  { name: 'felt-vs-measured', re: /\bfelt\b[^.]{0,48}\b(?:but|while|yet|however|though)\b[^.]{0,48}\b(?:brain|measured|signal|actually|reality|data)\b|\b(?:perceived|felt)\b[^.]{0,24}\b(?:vs\.?|versus)\b[^.]{0,24}\b(?:measured|actual|real|brain)\b|\byour\s+brain\s+(?:says|said|tells|knows|thinks)\b|\bfelt\b[^.!?]{0,80}[.!?]['”")\]]?\s+[^.!?]{0,24}?\b(?:but|yet|however|though|actually|in\s+(?:fact|reality|truth)|meanwhile)\b[^.!?]{0,80}?\b(?:brain|measured|signal|actually|reality|data)\b/gi },
  // clinical / diagnostic framing — but NOT honest disclaimers ("not a clinical
  // score", "this isn't a diagnosis", "we don't diagnose"), which are exactly
  // what the doc wants us to say.
  { name: 'clinical', re: new RegExp(`(?<!\\b${NEG}\\b[^.]{0,24})\\b(?:diagnos\\w*|clinical(?:ly)?|disorder|deficit|abnormal|patholog\\w*|ADHD|neurological\\s+condition)\\b`, 'gi') },
];

function vet(text) {
  if (text == null) return [];
  const s = String(text);
  const out = [];
  for (const r of RULES) {
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(s)) !== null) {
      if (!(r.allow && r.allow(m))) out.push({ rule: r.name, match: m[0].trim() });
      if (m.index === r.re.lastIndex) r.re.lastIndex++; // avoid zero-width loop
    }
  }
  return out;
}

function isClean(text) { return vet(text).length === 0; }

function redact(text) {
  let s = String(text == null ? '' : text);
  for (const r of RULES) s = s.replace(r.re, '');
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
}

// Route a guest-facing string through the layer.
//  - strict (dev/tests): throws on any violation.
//  - non-strict (packaged): logs LOUDLY + returns the redacted text (the
//    offending bit is omitted) — a violation never reaches a guest and never
//    kills an output.
function honest(text, label = 'copy', strict = defaultStrict()) {
  const v = vet(text);
  if (v.length === 0) return text == null ? text : String(text);
  const detail = v.map((x) => `${x.rule}:"${x.match}"`).join(', ');
  if (strict) {
    throw new Error(`honesty violation in ${label}: ${detail}`);
  }
  // packaged: never show the violation
  // eslint-disable-next-line no-console
  console.error(`[honesty] VIOLATION REDACTED in ${label}: ${detail}`);
  return redact(text);
}

// Vet a whole object's string fields recursively; returns all violations.
function vetDeep(obj, path = '') {
  let out = [];
  if (typeof obj === 'string') out = out.concat(vet(obj).map((x) => ({ ...x, path })));
  else if (Array.isArray(obj)) obj.forEach((v, i) => { out = out.concat(vetDeep(v, `${path}[${i}]`)); });
  else if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) out = out.concat(vetDeep(obj[k], path ? `${path}.${k}` : k));
  return out;
}

// NODE_ENV is never set in the packaged app, so strictness derives from
// Electron packaging via config. The require is guarded so this module still
// loads in plain node (tests), where config's require('electron') would fail.
let packaged = false;
try { packaged = !!require('./config').isPackaged; } catch (_) { packaged = false; }

function defaultStrict() {
  return !packaged || process.env.FOCUSROOM_DEV === '1';
}

module.exports = { honest, vet, vetDeep, isClean, redact, RULES };
