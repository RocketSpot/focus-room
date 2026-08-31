'use strict';
// ============================================================
// Report delivery regression tests. Plain node, no network/email:
//   node tests/report-delivery.test.js
//
// Proves provider acceptance != local composition, generated artifacts ride
// the report, invalid sessions cannot emit synthetic takeaway graphics, late
// results update the session they belong to, and ops diagnostics expose an
// actionable failure without credentials/full recipient addresses.
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { PostmarkProvider, DevFileProvider } = require(path.join(ROOT, 'app', 'email', 'provider.js'));
const outputs = require(path.join(ROOT, 'app', 'outputs.js'));
const { Orchestrator } = require(path.join(ROOT, 'app', 'orchestrator.js'));
const { maskedRecipient, reportFailureForOps } = require(path.join(ROOT, 'app', 'room-core.js'));

let failures = 0;
function check(name, fn) {
  try {
    const value = fn();
    if (value && typeof value.then === 'function') {
      return value.then(() => console.log(`  ok   ${name}`)).catch((e) => {
        failures++; console.error(` FAIL  ${name} — ${e.stack || e.message}`);
      });
    }
    console.log(`  ok   ${name}`);
    return Promise.resolve();
  } catch (e) {
    failures++; console.error(` FAIL  ${name} — ${e.stack || e.message}`);
    return Promise.resolve();
  }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'focus-room-report-'));

function fakeData(measured = true) {
  return {
    measured,
    arch: measured ? 'steady' : 'deep',
    name: measured ? 'Steady Burner' : 'Not measured this session',
    date: '08/31/2026',
    samples: measured ? Array.from({ length: 10 }, (_, i) => ({ t: i, v: i / 10 })) : [],
    troughT: null,
    heroCaption: measured ? 'One measured reading.' : 'Nothing was estimated.',
    read_1: 'Read one.', read_2: 'Read two.', read_3: 'Read three.', read_3_said: '', read_4: 'Read four.',
    next_step: 'Next.', cta_label: 'Continue →', cta_url: 'https://example.invalid',
  };
}

function makeClosingOrchestrator(id, email) {
  const records = [];
  const events = [];
  const o = new Orchestrator({
    supervisor: { send: () => true },
    server: { broadcast: () => {}, hasRole: () => true },
    log: () => {},
  });
  o.on('session-record', (rec) => records.push(JSON.parse(JSON.stringify(rec))));
  o.on('event', (ev) => events.push(JSON.parse(JSON.stringify(ev))));
  o.sessionId = id;
  o.sessionStartedAt = 1000;
  o.beat = 'close';
  o.answers = {
    intake: {}, onMind: '', reading: { id: 'piece' }, archetype: 'steady',
    archetypeName: 'Steady Burner', email,
  };
  o.reveal = {
    archetype: { label: 'steady', name: 'Steady Burner', measured: true },
    reads: [], stats: {}, samplesForReveal: Array.from({ length: 8 }, (_, i) => ({ t: i, v: i / 8 })),
    eegDerivedClaimsAllowed: true,
  };
  o.streamLog = { frames: [], bands: [], metrics: [] };
  o.onClientMessage({ type: 'guest/event', kind: 'close_choice', payload: { door: 'customer' }, t: 2000 }, 'ipad');
  return { o, records, events };
}

(async () => {
  console.log('\n-- provider outcome contract (fetch is stubbed) --');
  await check('Postmark acceptance is sent/accepted but not delivery-confirmed', async () => {
    const dir = tmp();
    const token = '11111111-2222-3333-4444-555555555555';
    const originalFetch = global.fetch;
    let request = null;
    global.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ErrorCode: 0, MessageID: 'pm-accepted-1' }) };
    };
    try {
      const r = await new PostmarkProvider(token, dir).send({
        to: 'guest@example.com', subject: 'Report', htmlBody: '<p>report</p>', attachments: [],
      });
      assert.equal(r.status, 'provider-accepted');
      assert.equal(r.sent, true);
      assert.equal(r.accepted, true);
      assert.equal(r.delivered, null);
      assert.equal(request.url, 'https://api.postmarkapp.com/email');
      assert.equal(request.options.headers['X-Postmark-Server-Token'], token);
      assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('pending-email-')).length, 0,
        'accepted payload should be removed');
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('Postmark rejection preserves recovery payload and never echoes the token/upstream body', async () => {
    const dir = tmp();
    const token = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: false, status: 401, statusText: 'Unauthorized',
      json: async () => ({ ErrorCode: 10, Message: `bad secret ${token}` }),
    });
    try {
      let error = null;
      try {
        await new PostmarkProvider(token, dir).send({
          to: 'guest@example.com', subject: 'Report', htmlBody: '<p>report</p>', attachments: [],
        });
      } catch (e) { error = e; }
      assert(error, 'expected rejection');
      assert.equal(error.status, 'provider-failed');
      assert(error.pendingPath && fs.existsSync(error.pendingPath), 'pending report must survive');
      assert(!`${error.message} ${error.diagnosis}`.includes(token), 'credential leaked through error');
      assert(!fs.readFileSync(error.pendingPath, 'utf8').includes(token), 'credential leaked into pending payload');
      assert(/token was rejected/i.test(error.diagnosis), error.diagnosis);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('dev-file is composed locally but explicitly unsent', async () => {
    const dir = tmp();
    try {
      const r = await new DevFileProvider(dir).send({
        to: 'guest@example.com', subject: 'Report', htmlBody: '<p>report</p>',
        attachments: [{ name: 'sample.txt', content: Buffer.from('x').toString('base64'), contentType: 'text/plain' }],
      });
      assert.equal(r.status, 'saved-locally');
      assert.equal(r.composed, true);
      assert.equal(r.sent, false);
      assert.equal(r.accepted, false);
      assert(fs.existsSync(r.path));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  console.log('\n-- report content/artifacts --');
  await check('the generated card PDF and profile PNG are attached to the same report', async () => {
    const dir = tmp();
    const cardPdf = path.join(dir, 'card.pdf');
    const profilePng = path.join(dir, 'profile.png');
    fs.writeFileSync(cardPdf, Buffer.from('%PDF test'));
    fs.writeFileSync(profilePng, Buffer.from('PNG test'));
    let envelope = null;
    const provider = { send: async (msg) => {
      envelope = msg;
      return { ok: true, composed: true, sent: true, accepted: true, delivered: null,
        status: 'provider-accepted', provider: 'fake', id: 'fake-1' };
    } };
    try {
      const r = await outputs.sendEmail(fakeData(true), 'guest@example.com', provider, {
        renderLine: false, artifacts: { cardPdf, profilePng },
      });
      const names = envelope.attachments.map((a) => a.name);
      assert(names.includes('focus-room-card.pdf'), names.join(','));
      assert(names.includes('focus-profile.png'), names.join(','));
      assert(r.attachmentNames.includes('focus-room-card.pdf'));
      assert(r.attachmentNames.includes('focus-profile.png'));
      const missing = outputs.collectReportAttachments({
        cardPdf: null, cardPdfExpected: true,
        profilePng: null, profilePngExpected: false,
      });
      assert.deepEqual(missing.warnings, ['focus-room-card.pdf unavailable']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await check('not-measured output is text-only and never renders synthetic/clipped card/profile assets', async () => {
    const reveal = {
      lost: true, eegDerivedClaimsAllowed: false, dataQualityStatus: 'insufficient-usable-data',
      archetype: { label: 'deep', name: 'Not measured this session', measured: false },
      reads: [], samplesForReveal: [], interruptT: null,
    };
    const data = outputs.buildData(reveal, { closeDoor: 'customer' }, '08/31/2026');
    assert.equal(data.measured, false);
    assert.equal(data.name, 'Not measured this session');
    assert.deepEqual(data.samples, []);
    assert.equal(data.troughT, null);
    assert(/did not record enough usable signal/i.test(data.heroCaption), data.heroCaption);
    const out = await outputs.processResults(reveal, { closeDoor: 'customer' });
    assert.equal(out.cardSkipped, 'not-measured');
    assert.equal(out.profileSkipped, 'not-measured');
    assert.equal(out.cardPdf, undefined);
    assert.equal(out.profilePng, undefined);
  });

  console.log('\n-- session association and operator visibility --');
  await check('a late accepted result updates guest A after reset/new guest B, never guest B', async () => {
    const { o, records } = makeClosingOrchestrator('session-A', 'alice@example.com');
    assert.equal(o.beat, 'idle', 'close should reset room before provider returns');
    o.sessionId = 'session-B';
    o.sessionStartedAt = 3000;
    o.beat = 'reading';
    o.answers.email = 'bob@example.com';
    const ok = o.noteReportDelivery({
      ok: true, composed: true, sent: true, accepted: true, delivered: null,
      status: 'provider-accepted', provider: 'postmark', id: 'pm-A',
      attachmentNames: ['focus-room-card.pdf', 'focus-profile.png'],
    }, 'session-A');
    assert.equal(ok, true);
    const saved = records[records.length - 1];
    assert.equal(saved.id, 'session-A');
    assert.equal(saved.reportDelivery.to, 'alice@example.com');
    assert.equal(saved.reportDelivery.status, 'provider-accepted');
    assert.equal(saved.reportDelivery.delivered, null);
    assert.equal(saved.events[saved.events.length - 1].kind, 'report_provider_accepted');
    assert.equal(o.sessionId, 'session-B');
    assert.equal(o.answers.email, 'bob@example.com');
    assert.equal(o.reportDelivery, null);
  });

  await check('a late local-only result is persisted distinctly as unsent', async () => {
    const { o, records } = makeClosingOrchestrator('session-local', 'local@example.com');
    o.sessionId = 'next-session';
    o.answers.email = 'next@example.com';
    assert.equal(o.noteReportDelivery({
      ok: true, composed: true, sent: false, accepted: false, delivered: false,
      status: 'saved-locally', provider: 'dev-file', path: '/safe/report.html',
    }, 'session-local'), true);
    const saved = records[records.length - 1];
    assert.equal(saved.id, 'session-local');
    assert.equal(saved.reportDelivery.status, 'saved-locally');
    assert.equal(saved.reportDelivery.composed, true);
    assert.equal(saved.reportDelivery.sent, false);
    assert.equal(saved.events[saved.events.length - 1].kind, 'report_saved_locally');
    assert.equal(o.answers.email, 'next@example.com');
  });

  await check('ops failure is actionable, recipient-masked, and credential-redacted', async () => {
    const secret = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const d = reportFailureForOps({
      status: 'provider-failed', provider: 'postmark',
      error: `POSTMARK_API_KEY=${secret}`,
      diagnosis: `rotate ${secret}`,
      pendingPath: '/safe/pending-email.json', postmarkCode: 10, httpStatus: 401,
    }, 'alice@example.com', 'session-A');
    assert.equal(d.severity, 'error');
    assert.equal(d.actionRequired, true);
    assert.equal(d.recipient, 'a***@example.com');
    assert.equal(maskedRecipient('x@example.com'), 'x@example.com');
    assert(!JSON.stringify(d).includes(secret), JSON.stringify(d));
    assert.equal(d.recoverAt, '/safe/pending-email.json');
  });

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
