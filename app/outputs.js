'use strict';
// ============================================================
// outputs.js, the takeaway mechanism, built once.
// Take a Claude Design template (card.html / profile.html / email.html), inject
// this guest's archetype + sentence + their REAL focus-line path, then render:
//   • card    → print-ready 4×6 PDF (CSS @page) + auto-print to the printer
//   • profile → 1080×1080 PNG (leads with the archetype, no scores)
//   • email   → Postmark send, annotated line rasterized to PNG (cid attach)
// Every guest-facing string is routed through the honesty layer.
// ============================================================
const fs = require('fs');
const path = require('path');
// Electron is optional: the web deployment has no renderer, so the card PDF /
// profile PNG / email-line image are honestly SKIPPED there (each render path
// already fails soft into its own try/catch), the email itself still sends.
let BrowserWindow = null;
try { BrowserWindow = require('electron').BrowserWindow || null; } catch (e) { BrowserWindow = null; }
const config = require('./config');
const { honest } = require('./honesty');
const { makeEmailProvider, DevFileProvider } = require('./email/provider');

const OUT_DIR = path.join(config.dataDir, 'outputs');
const base = () => `http://127.0.0.1:${config.net.LAN_PORT}`;
const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const stripQuotes = (s) => String(s || '').replace(/^[“"]|[”"]$/g, '');

// matched soft close (Document.pdf Beat 4), mirrors the iPad Close doors
const DOORS = {
  investor: { cta: 'See where this goes',
    next: 'Today was one room and one reading. The roadmap is the same signal, every workday, for years, with your focus learning its own shape over time.' },
  customer: { cta: 'Join the beta',
    next: 'Today was a glimpse. The earbud is the version that follows you out, learning how you settle, your rhythm, and the moment your focus starts to break.' },
  creator: { cta: 'Get your Focus Profile',
    next: 'Your archetype is yours to keep. Take the profile, post it if you like, and wear the version that tracks this across every session.' },
};
const HERO_CAPTION = 'Here is how your focus moved during one reading today, measured against your own session, start to finish. No absolute scores. Just your own shape.';

// ---- build the template data (all copy through honesty) ----
function buildData(reveal, answers, dateStr) {
  const reads = (reveal && reveal.reads) || [];
  const arch = (reveal && reveal.archetype) || { label: 'deep', name: 'Deep Diver' };
  const door = DOORS[(answers && answers.closeDoor)] || DOORS.investor;
  const region = reveal && reveal.region ? reveal.region : 'your reading';
  const r = (i, fallback) => (reads[i] ? (reads[i].ledger ? reads[i].ledger.did : reads[i].sentence) : fallback);
  // Phase 2A.2 correction 1: a staff/demonstration override marks the session invalid
  // for EEG interpretation, the takeaway must not present any EEG-derived claim and
  // must not read as "measured". "Signal ran light" would be a false claim about the
  // signal (a demo can have a fine signal, just overridden), so it gets its own copy.
  const demo = !!(reveal && reveal.dataQualityStatus === 'invalid-for-eeg-interpretation');
  if (demo) {
    return {
      arch: arch.label, name: arch.name, date: dateStr,
      samples: [], troughT: null,
      caption: [
        'This was a demonstration session.',
        'No brain-signal reading was recorded or claimed.',
        'Nothing here is measured or estimated.',
      ].map((line, i) => honest(line, `card.cap${i + 1}`)),
      desc: honest('A demonstration session, no EEG reading was claimed.', 'profile.desc'),
      heroCaption: honest('A demonstration walk-through. No focus signal was measured.', 'email.caption'),
      read_1: honest('This session ran in demonstration mode.', 'email.read1'),
      read_2: honest('No brain-signal reading was recorded.', 'email.read2'),
      read_3: honest('No notification response was measured.', 'email.read3'),
      read_3_said: honest('', 'email.read3said'),
      read_4: honest('Nothing here is measured or estimated.', 'email.read4'),
      next_step: honest(door.next, 'email.next'),
      cta_label: honest(door.cta, 'email.cta') + ' →',
      cta_url: process.env.FOCUSROOM_CTA_URL || 'https://wear.zone/roadmap',
    };
  }

  // The card quotes the SAME measured figures the wall showed. It used to carry
  // only mood words ("a slow burn, then long steady stretches"), so a guest
  // comparing their card to the reveal found two descriptions of one session
  // with no number in common. When a figure is missing (a session too short to
  // measure), the qualitative line is still the honest fallback.
  const st = (reveal && reveal.stats) || null;
  const secWord = (s) => (s < 60 ? `${s} sec` : (s % 60 ? `${Math.floor(s / 60)} min ${s % 60} sec` : `${Math.floor(s / 60)} min`));
  const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const caption = st
    ? [
      `Settled in ${secWord(st.settleSec)}.`,
      // Phase 2A safety patch: the exact interruption cost (recovery seconds) is
      // SUPPRESSED (unvalidated timing + smoothed recovery). Associative wording
      // only. interruptSec is null when the notification never fired.
      st.interruptSec != null ? 'One notification arrived while you read.'
        : 'You finished before the notification was due.',
      // On a very short session both clocks can round to the same value, a
      // "0:15 to 0:15" run is the exact nonsense claim reads.js guards its own
      // wall copy against, so the card falls back the same way.
      st.strongToSec > st.strongFromSec
        ? `Strongest run: ${clock(st.strongFromSec)} to ${clock(st.strongToSec)}.`
        : `Strongest moment: around ${clock(st.strongFromSec)}.`,
    ]
    : reveal && reveal.lost
      ? [
        'The signal ran light this session.',
        'So the room kept your read brief and honest.',
        'Nothing here is estimated.',
      ]
      : [
        `${cap(reads[0] ? reads[0].v : 'a calm settle')}, then ${reads[1] ? reads[1].v : 'even focus'}.`,
        `The interruption: ${reads[2] ? reads[2].v : 'a small, honest dip'}.`,
        `Strongest run came in ${region}.`,
      ];

  const data = {
    arch: arch.label,
    name: arch.name,
    date: dateStr,
    samples: (reveal && reveal.samplesForReveal) || [],
    // null (no orange marker on the card/profile/email line) when the
    // notification never fired, interruptT is null exactly then.
    troughT: reveal && reveal.interruptT != null && reads[2] ? reads[2].anchorT : null,
    // card: 3 short lines
    caption: caption.map((line, i) => honest(line, `card.cap${i + 1}`)),
    // profile: one descriptive line, no scores
    desc: honest(reveal && reveal.lost
      ? 'A light-signal session, read honestly and never estimated.'
      : `${cap(reads[0] ? reads[0].v : 'a calm settle')}, then ${reads[1] ? reads[1].v : 'even focus'}.`, 'profile.desc'),
    // email: the four reads, plain language
    heroCaption: honest(HERO_CAPTION, 'email.caption'),
    read_1: honest(reads[0] ? reads[0].sentence : 'Your read started cleanly and held.', 'email.read1'),
    read_2: honest(r(1, 'Your focus ran steady through the clean stretch.'), 'email.read2'),
    read_3: honest(r(2, 'One interruption hit, and your line responded.'), 'email.read3'),
    read_3_said: honest(reads[2] && reads[2].ledger ? `You’d told us ${stripQuotes(reads[2].ledger.said)}` : '', 'email.read3said'),
    read_4: honest(r(3, 'This stretch ran highest, relative to the rest of your reading.'), 'email.read4'),
    next_step: honest(door.next, 'email.next'),
    cta_label: honest(door.cta, 'email.cta') + ' →',
    cta_url: process.env.FOCUSROOM_CTA_URL || 'https://wear.zone/roadmap',
  };
  return data;
}

// ---- offscreen render helper ----
// Small payloads ride the legacy ?d= querystring (back-compat, also the only
// path for pages without window.__setData). Anything bigger is injected after
// load via window.__setData(...): a long session's sample array used to push
// the ?d= URL past Node's 16KB header cap, silently killing card, profile and
// email line on sessions over ~5 minutes.
const MAX_D_QUERY = 12000; // encoded querystring chars, well under the 16KB header cap

async function withPage(urlPath, data, size, fn) {
  if (!BrowserWindow) throw new Error('no renderer on this host (web mode), visual output skipped');
  const win = new BrowserWindow({
    width: size.width, height: size.height, show: false,
    frame: false, useContentSize: true, // exact content size for capturePage
    webPreferences: { offscreen: false, backgroundThrottling: false, deviceScaleFactor: 1 },
  });
  try {
    let url = `${base()}/${urlPath}`;
    let inject = null;
    if (data) {
      const enc = encodeURIComponent(b64(data));
      if (enc.length <= MAX_D_QUERY) url += `?d=${enc}`;
      else { url += '?wait=1'; inject = JSON.stringify(data); }
    }
    await win.loadURL(url);
    if (inject) {
      const ok = await win.webContents.executeJavaScript(
        `typeof window.__setData === 'function' ? (window.__setData(${inject}), true) : false`);
      if (ok !== true) throw new Error(`${urlPath} does not expose window.__setData (payload too large for ?d=)`);
    }
    // Wait until the page signals it finished rendering (data-rendered), capped.
    // If it never does, THROW rather than capture: a page that hasn't rendered
    // the guest's data would otherwise be printed/emailed as a blank or (worse)
    // a synthetic sheet. Better a loud failure the operator sees than a
    // fabricated takeaway the guest carries home.
    const deadline = Date.now() + 4000;
    let rendered = false;
    /* eslint-disable no-await-in-loop */
    while (Date.now() < deadline) {
      const done = await win.webContents.executeJavaScript("document.body && document.body.getAttribute('data-rendered')").catch(() => null);
      if (done === '1') { rendered = true; break; }
      const err = await win.webContents.executeJavaScript("document.body && document.body.getAttribute('data-render-error')").catch(() => null);
      if (err) throw new Error(`${urlPath} failed to render the session payload: ${err}`);
      await new Promise((r) => setTimeout(r, 80));
    }
    if (!rendered) throw new Error(`${urlPath} never finished rendering, refusing to output an unrendered page`);
    return await fn(win);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function ensureOutDir() { fs.mkdirSync(OUT_DIR, { recursive: true }); }

// ---- card: 4×6 print-ready PDF + auto-print ----
async function renderCard(data) {
  ensureOutDir();
  const stamp = Date.now();
  const pdfPath = path.join(OUT_DIR, `card-${stamp}.pdf`);
  let printed = false;
  await withPage('card.html', data, { width: 460, height: 720 }, async (win) => {
    const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(pdfPath, pdf);
    // Physical printing is OPT-IN. The 4×6 PDF is always saved (above); we only
    // send it to a printer when the operator explicitly sets FOCUSROOM_PRINT=1.
    // So dev runs and any machine without a deliberately set-up printer never print.
    if (process.env.FOCUSROOM_PRINT !== '1') return;
    // auto-print to the connected printer (silent, no dialog). 4×6 page size in
    // microns. Raced against a timeout so a misbehaving printer never hangs the
    // rest of the outputs.
    try {
      await Promise.race([
        new Promise((resolve) => {
          win.webContents.print(
            { silent: true, printBackground: true, pageSize: { width: 101600, height: 152400 }, margins: { marginType: 'none' } },
            (ok, reason) => { printed = !!ok; if (!ok) console.log(`[outputs] card print skipped: ${reason}`); resolve(); });
        }),
        new Promise((resolve) => setTimeout(() => { console.log('[outputs] card print timed out'); resolve(); }, 6000)),
      ]);
    } catch (e) { console.log(`[outputs] card print error: ${e.message}`); }
  });
  return { pdfPath, printed };
}

// ---- profile: 1080×1080 PNG ----
async function renderProfile(data) {
  ensureOutDir();
  const pngPath = path.join(OUT_DIR, `profile-${Date.now()}.png`);
  await withPage('profile.html', data, { width: 1120, height: 900 }, async (win) => {
    // Rasterize the SVG to an exact 1080×1080 canvas in-page, independent of the
    // physical screen size (capturePage is constrained by the display). An SVG
    // drawn through <img> cannot load external webfonts, so the brand faces are
    // fetched same-origin, base64-inlined as @font-face rules INSIDE the SVG
    // before serializing, the raster carries the real type.
    const res = await win.webContents.executeJavaScript(`(() => new Promise((resolve) => {
      var FONTS = [
        // optional: true faces may be absent (the licensed PP Neue Montreal
        // ships separately), they embed automatically once the owner drops
        // the files into assets/fonts/files/, and are skipped until then
        // instead of failing the whole raster.
        { face: 'font-family:"PP Neue Montreal";font-style:normal;font-weight:400;', url: 'assets/fonts/files/PPNeueMontreal-Regular.woff2', fmt: 'woff2', optional: true },
        { face: 'font-family:"PP Neue Montreal";font-style:normal;font-weight:500;', url: 'assets/fonts/files/PPNeueMontreal-Medium.woff2', fmt: 'woff2', optional: true },
        { face: 'font-family:"Space Grotesk";font-style:normal;font-weight:300 700;', url: 'assets/fonts/files/SpaceGrotesk.woff2', fmt: 'woff2-variations' },
        { face: 'font-family:"Inter";font-style:normal;font-weight:300 700;', url: 'assets/fonts/files/Inter-roman.var.woff2', fmt: 'woff2-variations' },
        { face: 'font-family:"IBM Plex Mono";font-style:normal;font-weight:400;', url: 'assets/fonts/files/IBMPlexMono-Regular.woff2', fmt: 'woff2' },
      ];
      function b64buf(buf) {
        var u = new Uint8Array(buf), s = '';
        for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
        return btoa(s);
      }
      Promise.all(FONTS.map(function (f) {
        return fetch(f.url).then(function (r) {
          if (!r.ok) throw new Error('font ' + f.url + ' HTTP ' + r.status);
          return r.arrayBuffer();
        }).then(function (buf) {
          return '@font-face{' + f.face + 'src:url(data:font/woff2;base64,' + b64buf(buf) + ') format("' + f.fmt + '");}';
        }).catch(function (e) {
          if (f.optional) return '';       // licensed face not present yet
          throw e;                          // a bundled face missing is a real error
        });
      })).then(function (faces) {
        faces = faces.filter(Boolean);
        var svg = document.getElementById('profile').cloneNode(true);
        svg.setAttribute('width', '1080'); svg.setAttribute('height', '1080');
        var style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
        style.textContent = faces.join('');
        svg.insertBefore(style, svg.firstChild);
        var xml = new XMLSerializer().serializeToString(svg);
        var src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
        var img = new Image();
        img.onload = function () {
          var c = document.createElement('canvas'); c.width = 1080; c.height = 1080;
          var ctx = c.getContext('2d'); ctx.fillStyle = '#0C0B0A'; ctx.fillRect(0, 0, 1080, 1080);
          ctx.drawImage(img, 0, 0, 1080, 1080);
          resolve({ ok: true, png: c.toDataURL('image/png') });
        };
        img.onerror = function () { resolve({ ok: false, error: 'svg raster image failed to load' }); };
        img.src = src;
      }).catch(function (e) { resolve({ ok: false, error: String((e && e.message) || e) }); });
    }))()`);
    // no capturePage fallback: it grabbed the whole wrong-size window. Fail
    // loudly instead, so the diagnostic shows the real cause.
    if (!res || res.ok !== true || !res.png) {
      throw new Error(`profile raster failed: ${(res && res.error) || 'no image data'}`);
    }
    fs.writeFileSync(pngPath, Buffer.from(res.png.split(',')[1], 'base64'));
  });
  return { pngPath };
}

// ---- email line → PNG (base64) for the cid attachment ----
// email-line.html (assets/render) reads only the ?d= querystring, so its
// samples are thinned + rounded first: the page resamples the line at 180
// points anyway, and the compact payload keeps the URL far below the header cap.
function thinSamples(samples, max) {
  const src = samples || [];
  max = max || 240;
  const step = Math.max(1, Math.ceil(src.length / max));
  const pt = (p) => ({ t: +Number(p.t).toFixed(3), v: +Number(p.v).toFixed(4) });
  const out = [];
  for (let i = 0; i < src.length; i += step) out.push(pt(src[i]));
  if (src.length && (src.length - 1) % step !== 0) out.push(pt(src[src.length - 1]));
  return out;
}

async function renderEmailLinePng(data) {
  return withPage('assets/render/email-line.html', { samples: thinSamples(data.samples), troughT: data.troughT },
    { width: 1072, height: 400 }, async (win) => {
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1072, height: 400 });
      return img.toPNG().toString('base64');
    });
}

// ---- email compose + send ----
function composeEmail(templateHtml, data, withLine = true) {
  // no renderer (web mode) → no cid attachment → no broken-image icon either
  const lineImg = withLine
    ? '<img src="cid:focusline" width="536" alt="Your focus line" style="display:block;width:100%;max-width:536px;height:auto;border:0;"/>'
    : '';
  const slots = {
    archetype: data.name, date: data.date, caption: data.heroCaption,
    focus_line_svg: lineImg,
    read_1: data.read_1, read_2: data.read_2, read_3: data.read_3,
    read_3_said: data.read_3_said, read_4: data.read_4,
    next_step: data.next_step, cta_label: data.cta_label, cta_url: data.cta_url,
  };
  return templateHtml.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in slots ? String(slots[k]) : ''));
}

async function sendEmail(data, toEmail, provider) {
  const templateHtml = fs.readFileSync(path.join(config.webRoot, 'email.html'), 'utf8');
  // the line image is a garnish, not the meal: with no renderer on this host
  // (web mode) the report still sends, just without the picture
  let linePng = null;
  try { linePng = await renderEmailLinePng(data); }
  catch (e) { console.log(`[outputs] email line image skipped: ${e.message}`); }
  const html = composeEmail(templateHtml, data, !!linePng);
  if (!provider) provider = makeEmailProvider({ outDir: OUT_DIR });
  // The Zone wordmark rides along as an inline (cid) attachment. Gmail and Outlook
  // both strip data: URIs on images, and the room is offline first with no CDN to
  // link to, which leaves cid as the only reliable way to show a logo in an inbox.
  const attachments = [];
  if (linePng) attachments.push({ name: 'focus-line.png', content: linePng, contentType: 'image/png', cid: 'focusline' });
  try {
    const logoPath = path.join(config.webRoot, 'assets', 'brand', 'zone-logo-white@2x.png');
    attachments.push({
      name: 'zone.png', content: fs.readFileSync(logoPath).toString('base64'),
      contentType: 'image/png', cid: 'zonelogo',
    });
  } catch (e) {
    console.log(`[outputs] logo skipped: ${e.message}`);
  }
  const result = await provider.send({
    to: toEmail,
    subject: `Your Focus Room read · ${data.name}`,
    htmlBody: html,
    attachments,
  });
  return result;
}

// ---- the two entry points the orchestrator calls ----
// "the moment results are processed", card auto-prints + profile renders.
// buildData runs INSIDE each output's try/catch: one bad string (an honesty
// throw in dev) can no longer abort card + profile + email together.
async function processResults(reveal, answers) {
  const out = { cardPrinted: false, profileReady: false };
  try {
    const data = buildData(reveal, answers, dateStr());
    out.data = data;
    const c = await renderCard(data); out.cardPdf = c.pdfPath; out.cardPrinted = c.printed;
  } catch (e) { console.log(`[outputs] card failed: ${e.message}`); }
  try {
    const data = buildData(reveal, answers, dateStr());
    if (!out.data) out.data = data;
    const p = await renderProfile(data); out.profilePng = p.pngPath; out.profileReady = true;
  } catch (e) { console.log(`[outputs] profile failed: ${e.message}`); }
  return out;
}

// anchored: a clearly invalid address never reaches the provider
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function sendReport(reveal, answers, toEmail) {
  const to = String(toEmail == null ? '' : toEmail).trim();
  const data = buildData(reveal, answers, dateStr());
  if (!EMAIL_RE.test(to)) {
    // skip the send with a logged reason, but still write the dev-file
    // artifact so the rendered report stays recoverable.
    console.error(`[outputs] email send skipped: invalid address ${JSON.stringify(to)}, report saved to disk instead`);
    const saved = await sendEmail(data, to, new DevFileProvider(OUT_DIR));
    return { ...saved, ok: false, skipped: 'invalid-address' };
  }
  return sendEmail(data, to);
}

function dateStr() {
  // American format MM/DD/YYYY (month first), on the card's top-right
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
}

module.exports = { buildData, renderCard, renderProfile, sendEmail, sendReport, processResults, composeEmail };
