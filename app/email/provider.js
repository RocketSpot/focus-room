'use strict';
// ============================================================
// email/provider.js, pluggable email send (Document.pdf / master prompt:
// "Put the provider behind a small interface so it can be swapped, and read the
// API key from an environment variable or local config, never hard-coded").
//   • PostmarkProvider, real send (POSTMARK_API_KEY from env/config).
//   • DevFileProvider , no key → writes the rendered email + attachment to disk
//                        and logs, so the flow is testable without a key.
// ============================================================
const fs = require('fs');
const path = require('path');

const FROM = process.env.FOCUSROOM_EMAIL_FROM || 'The Focus Room <room@wear.zone>';
const SEND_TIMEOUT_MS = 10000; // a hung Postmark call may never block the room

// An operator can only act on a failure they can NAME. A bare "postmark error
// 400" sent the owner hunting through code; the four causes below are the ones
// that actually stop a room from mailing a guest, and each has a different fix.
// Nothing here ever quotes the token: the message goes to the diagnostic trail
// on disk and to the ops console, and a secret must not travel with it.
function diagnose(status, data) {
  const code = data && data.ErrorCode;
  if (status === 401 || code === 10) {
    return 'the Postmark server token was rejected. Rotate it in the Postmark dashboard and put the new one in .env as POSTMARK_API_KEY, then restart the room.';
  }
  if (code === 400 || code === 401) {
    return `the From address (${FROM}) is not a confirmed Postmark Sender Signature. Confirm that exact address, or verify the whole domain, then set FOCUSROOM_EMAIL_FROM to a verified sender.`;
  }
  if (code === 405 || code === 412) {
    return 'the Postmark account is not approved to send to arbitrary addresses yet. Request account approval in the Postmark dashboard.';
  }
  if (code === 406) {
    return 'Postmark has this guest address marked inactive (a previous hard bounce or spam complaint). Reactivate it in Postmark Suppressions, or resend by hand.';
  }
  return 'Postmark refused the send. Check the Activity tab in the Postmark dashboard for this attempt.';
}

// EmailProvider interface:
//   async send({ to, subject, htmlBody, attachments })
//     -> { ok, composed, sent, accepted, delivered, status, id }
//
// `sent` means the provider accepted the message for delivery. Postmark's Send
// API does not prove inbox delivery, so `delivered` remains null until/unless a
// delivery webhook is added. A dev-file write is `composed:true, sent:false`.
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
    // the guest's report survives as pending-email-<ts>.json, recoverable and
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
      // Do not reflect arbitrary transport text into the operator feed. Some
      // HTTP clients include request headers in debug errors; the server token
      // must never appear in a log, session record, or browser console.
      const summary = e.name === 'AbortError'
        ? `Postmark did not answer within ${SEND_TIMEOUT_MS}ms`
        : 'Postmark could not be reached';
      throw Object.assign(new Error(summary), {
        provider: 'postmark',
        pendingPath,
        status: 'provider-failed',
        composed: !!pendingPath,
        diagnosis: 'the room could not reach api.postmarkapp.com. Check that the room machine is on a network with outbound internet.',
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || (data.ErrorCode && data.ErrorCode !== 0)) {
      const providerCode = data.ErrorCode ?? null;
      throw Object.assign(
        // Postmark's Message is deliberately not copied: an upstream service
        // can echo addresses or configuration details. The stable code/status
        // plus the actionable diagnosis are all an operator needs.
        new Error(`Postmark rejected the report (code ${providerCode ?? 'unknown'}, HTTP ${res.status})`),
        { provider: 'postmark', pendingPath, postmarkCode: providerCode, httpStatus: res.status,
          status: 'provider-failed', composed: !!pendingPath, diagnosis: diagnose(res.status, data) },
      );
    }
    if (pendingPath) { try { fs.unlinkSync(pendingPath); } catch (_) {} } // confirmed sent
    return {
      ok: true,
      composed: true,
      sent: true,
      accepted: true,
      delivered: null,
      status: 'provider-accepted',
      id: data.MessageID,
      provider: 'postmark',
    };
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
    // ok means "the report was produced", NOT "the guest has it". These used to be
    // the same flag, so a room running with no token reported emailSent:true up the
    // stack and the close screen told the guest their report was in their inbox
    // while it sat in data/outputs. sent is the only flag any surface may promise on.
    return {
      ok: true,
      composed: true,
      sent: false,
      accepted: false,
      delivered: false,
      status: 'saved-locally',
      id: `dev-${stamp}`,
      provider: 'dev-file',
      path: htmlPath,
      dev: true,
    };
  }
}

function makeEmailProvider({ outDir } = {}) {
  const dir = outDir || path.join(process.cwd(), 'data', 'outputs');
  const token = process.env.POSTMARK_API_KEY || process.env.POSTMARK_SERVER_TOKEN;
  if (token) return new PostmarkProvider(token, dir);
  return new DevFileProvider(dir);
}

module.exports = { PostmarkProvider, DevFileProvider, makeEmailProvider, FROM };
