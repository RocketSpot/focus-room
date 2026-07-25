'use strict';
// ============================================================
// email/provider.js — pluggable email send (Document.pdf / master prompt:
// "Put the provider behind a small interface so it can be swapped, and read the
// API key from an environment variable or local config, never hard-coded").
//   • PostmarkProvider — real send (POSTMARK_API_KEY from env/config).
//   • DevFileProvider  — no key → writes the rendered email + attachment to disk
//                        and logs, so the flow is testable without a key.
// ============================================================
const fs = require('fs');
const path = require('path');

const FROM = process.env.FOCUSROOM_EMAIL_FROM || 'The Focus Room <room@wear.zone>';
const SEND_TIMEOUT_MS = 10000; // a hung Postmark call may never block the room

// EmailProvider interface: async send({ to, subject, htmlBody, attachments }) -> { ok, id }
class PostmarkProvider {
  constructor(token, outDir) { this.token = token; this.outDir = outDir; this.name = 'postmark'; }
  async send({ to, subject, htmlBody, attachments }) {
    const payload = {
      From: FROM,
      To: to,
      Subject: subject,
      HtmlBody: htmlBody,
      MessageStream: 'outbound',
      Attachments: (attachments || []).map((a) => ({
        Name: a.name, Content: a.content, ContentType: a.contentType, ContentID: a.cid,
      })),
    };
    // Persist BEFORE the attempt: if the send fails (or the box dies mid-send)
    // the guest's report survives as pending-email-<ts>.json — recoverable and
    // visible. Deleted only on a confirmed success.
    let pendingPath = null;
    if (this.outDir) {
      try {
        fs.mkdirSync(this.outDir, { recursive: true });
        pendingPath = path.join(this.outDir, `pending-email-${Date.now()}.json`);
        fs.writeFileSync(pendingPath, JSON.stringify(payload), 'utf8');
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[email] could not persist pending payload: ${e.message}`);
        pendingPath = null;
      }
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
    let res;
    let data = {};
    try {
      res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': this.token,
        },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
      try { data = await res.json(); } catch (_) {}
    } catch (e) {
      const why = e.name === 'AbortError' ? `timed out after ${SEND_TIMEOUT_MS}ms` : e.message;
      throw new Error(`postmark send failed (${why})${pendingPath ? ` — payload kept at ${pendingPath}` : ''}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || (data.ErrorCode && data.ErrorCode !== 0)) {
      throw new Error(`postmark error ${data.ErrorCode ?? res.status}: ${data.Message || res.statusText}${pendingPath ? ` — payload kept at ${pendingPath}` : ''}`);
    }
    if (pendingPath) { try { fs.unlinkSync(pendingPath); } catch (_) {} } // confirmed sent
    return { ok: true, id: data.MessageID, provider: 'postmark' };
  }
}

class DevFileProvider {
  constructor(outDir) { this.outDir = outDir; this.name = 'dev-file'; }
  async send({ to, subject, htmlBody, attachments }) {
    fs.mkdirSync(this.outDir, { recursive: true });
    const stamp = String(Date.now());
    const htmlPath = path.join(this.outDir, `email-${stamp}.html`);
    fs.writeFileSync(htmlPath, htmlBody, 'utf8');
    for (const a of attachments || []) {
      if (a.content) fs.writeFileSync(path.join(this.outDir, `email-${stamp}-${a.name}`), Buffer.from(a.content, 'base64'));
    }
    // eslint-disable-next-line no-console
    console.log(`[email:dev] (no POSTMARK_API_KEY) → "${subject}" to ${to} saved: ${htmlPath}`);
    return { ok: true, id: `dev-${stamp}`, provider: 'dev-file', path: htmlPath, dev: true };
  }
}

function makeEmailProvider({ outDir } = {}) {
  const dir = outDir || path.join(process.cwd(), 'data', 'outputs');
  const token = process.env.POSTMARK_API_KEY || process.env.POSTMARK_SERVER_TOKEN;
  if (token) return new PostmarkProvider(token, dir);
  return new DevFileProvider(dir);
}

module.exports = { PostmarkProvider, DevFileProvider, makeEmailProvider, FROM };
