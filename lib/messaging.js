// Automated SMS and email — Twilio for texts, SendGrid (also Twilio) for email.
//
// Every message is recorded in an outbox whether or not it was really sent. With no
// credentials configured nothing leaves the building and each message is marked "simulated",
// which means the whole notification flow can be demonstrated on a laptop with no account,
// and the Outbox on the staff page shows exactly what a customer would have received.
//
// Twilio free trial, worth knowing before you demo it:
//   • A trial account can only text numbers you've VERIFIED in the Twilio console.
//   • Trial texts arrive with "Sent from your Twilio trial account -" prepended.
// Both are Twilio's doing, not ours — see the README.

import { ARENA, fmtTime, money, sessionSpan } from './arena.js';

const MAX_OUTBOX = 200;
const outbox = [];
let nextId = 1;

let twilioClient = null;
let sendgridReady = false;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** What's wired up, and why not if not. Safe to expose — no secrets in here. */
export function messagingStatus(env = process.env) {
  const sid = (env.TWILIO_ACCOUNT_SID || '').trim();
  const token = (env.TWILIO_AUTH_TOKEN || '').trim();
  const from = (env.TWILIO_PHONE_NUMBER || '').trim();
  const sgKey = (env.SENDGRID_API_KEY || '').trim();
  const sgFrom = (env.SENDGRID_FROM_EMAIL || '').trim();

  const smsProblem =
    (!sid && !token && !from) ? null
    : !sid.startsWith('AC') ? 'TWILIO_ACCOUNT_SID should start with AC.'
    : !token ? 'TWILIO_AUTH_TOKEN is missing.'
    : !from ? 'TWILIO_PHONE_NUMBER is missing (your Twilio number, e.g. +12045550123).'
    : null;

  const emailProblem =
    (!sgKey && !sgFrom) ? null
    : !sgKey.startsWith('SG.') ? 'SENDGRID_API_KEY should start with "SG.".'
    : !sgFrom ? 'SENDGRID_FROM_EMAIL is missing — it must be a verified sender in SendGrid.'
    : null;

  return {
    sms: { enabled: !!(sid && token && from) && !smsProblem, from: from || null, problem: smsProblem },
    email: { enabled: !!(sgKey && sgFrom) && !emailProblem, from: sgFrom || null, problem: emailProblem },
  };
}

let twilioModule = null;
let sendgridModule = null;

/**
 * Load the provider SDKs on first real send, not at startup — so the app boots instantly
 * and still works if a package is missing or the machine is offline.
 * Returns the ready-to-use clients, or nulls.
 */
async function loadProviders(env = process.env) {
  const st = messagingStatus(env);

  if (st.sms.enabled && !twilioClient) {
    twilioModule ||= await import('twilio').catch(() => null);
    if (twilioModule) {
      const Twilio = twilioModule.default || twilioModule;
      twilioClient = Twilio(env.TWILIO_ACCOUNT_SID.trim(), env.TWILIO_AUTH_TOKEN.trim());
    }
  }
  if (st.email.enabled && !sendgridReady) {
    sendgridModule ||= await import('@sendgrid/mail').catch(() => null);
    if (sendgridModule) {
      (sendgridModule.default || sendgridModule).setApiKey(env.SENDGRID_API_KEY.trim());
      sendgridReady = true;
    }
  }
  return { sms: twilioClient, email: sendgridReady ? (sendgridModule.default || sendgridModule) : null };
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

function record(entry) {
  const row = { id: nextId++, at: new Date().toISOString(), ...entry };
  outbox.unshift(row);
  if (outbox.length > MAX_OUTBOX) outbox.length = MAX_OUTBOX;
  return row;
}

/** Newest first. This is what the staff Outbox renders. */
export function getOutbox(limit = 50) {
  return outbox.slice(0, Math.max(1, Math.min(MAX_OUTBOX, Number(limit) || 50)));
}

export function clearOutbox() { outbox.length = 0; }

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Digits-only sanity check. Twilio wants E.164; we prepend +1 for bare NANP numbers. */
export function toE164(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return null;
  if (raw.startsWith('+')) return '+' + raw.slice(1).replace(/\D/g, '');
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;          // Winnipeg numbers as typed
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

async function sendSms({ to, body, kind, bookingCode }) {
  const status = messagingStatus().sms;
  const e164 = toE164(to);

  if (!e164) {
    return record({ channel: 'sms', kind, bookingCode, to: to || '—', body, state: 'skipped', detail: 'No usable phone number' });
  }
  if (!status.enabled) {
    return record({ channel: 'sms', kind, bookingCode, to: e164, body, state: 'simulated', detail: status.problem || 'Twilio not configured' });
  }

  try {
    const { sms: client } = await loadProviders();
    if (!client) throw new Error('Twilio SDK unavailable');
    const msg = await client.messages.create({ from: status.from, to: e164, body });
    return record({ channel: 'sms', kind, bookingCode, to: e164, body, state: 'sent', detail: msg.sid });
  } catch (err) {
    // A trial account refusing an unverified number lands here — say so in plain words,
    // because it's the single most common surprise when demoing Twilio.
    const unverified = /unverified|not a valid phone number|21608|21211/i.test(err.message || '');
    return record({
      channel: 'sms', kind, bookingCode, to: e164, body, state: 'failed',
      detail: unverified
        ? 'Twilio trial accounts can only text verified numbers — add this one in the Twilio console.'
        : (err.message || 'Send failed'),
    });
  }
}

async function sendEmail({ to, subject, text, html, kind, bookingCode }) {
  const status = messagingStatus().email;
  const address = String(to || '').trim();

  if (!address || !address.includes('@')) {
    return record({ channel: 'email', kind, bookingCode, to: address || '—', subject, body: text, state: 'skipped', detail: 'No email address given' });
  }
  if (!status.enabled) {
    return record({ channel: 'email', kind, bookingCode, to: address, subject, body: text, state: 'simulated', detail: status.problem || 'SendGrid not configured' });
  }

  try {
    const { email: mailer } = await loadProviders();
    if (!mailer) throw new Error('SendGrid SDK unavailable');
    await mailer.send({
      to: address,
      from: { email: status.from, name: ARENA.name },
      subject, text, html,
    });
    return record({ channel: 'email', kind, bookingCode, to: address, subject, body: text, state: 'sent', detail: 'Accepted by SendGrid' });
  } catch (err) {
    const detail = err?.response?.body?.errors?.[0]?.message || err.message || 'Send failed';
    return record({ channel: 'email', kind, bookingCode, to: address, subject, body: text, state: 'failed', detail });
  }
}

// ---------------------------------------------------------------------------
// The messages themselves
// ---------------------------------------------------------------------------

const dateLabel = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

/** Plain-text SMS body for a laser tag booking. Kept short — one segment where possible. */
export function bookingSmsBody(b) {
  const span = sessionSpan(b.dateISO, b.startMin, b.games);
  const time = span.length > 1 ? `${fmtTime(span[0])}–${fmtTime(span.at(-1))}` : fmtTime(b.startMin);
  return `${ARENA.name}: you're booked! ${dateLabel(b.dateISO)} at ${time}, `
    + `${b.players} player${b.players > 1 ? 's' : ''}. Code ${b.code}. `
    + `Every player needs a waiver — sign at lasertopia.ca. Questions? ${ARENA.phone}`;
}

function bookingEmail(b) {
  const span = sessionSpan(b.dateISO, b.startMin, b.games);
  const time = span.length > 1
    ? `${fmtTime(span[0])} – ${fmtTime(span.at(-1))} (${span.length} back-to-back games)`
    : fmtTime(b.startMin);

  const text = [
    `You're booked at ${ARENA.name}!`,
    ``,
    `Booking code: ${b.code}`,
    `Date: ${dateLabel(b.dateISO)}`,
    `Game time: ${time}`,
    `Players: ${b.players}`,
    `Total paid: ${money(b.totalCents)}`,
    ``,
    `Before you arrive`,
    `• Every player needs a signed waiver. Under 18s need a parent or guardian to sign.`,
    `• Clean, closed-toe shoes only — no flip-flops, sandals or platforms.`,
    `• We're a nut-free facility, so no outside food or drink.`,
    ``,
    `${ARENA.address}`,
    `${ARENA.phone}`,
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#07070C;padding:28px;color:#fff">
      <div style="max-width:520px;margin:0 auto;background:#14141E;border:1px solid #2A2A3B;border-radius:14px;padding:28px">
        <h1 style="margin:0 0 4px;font-size:22px">You're booked!</h1>
        <p style="margin:0 0 20px;color:#B4B4C6;font-size:14px">See you at ${ARENA.name}.</p>
        <div style="background:#0C0C13;border:1px solid #2A2A3B;border-radius:10px;padding:16px;margin-bottom:18px">
          <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#7B7B92">Booking code</div>
          <div style="font-size:26px;font-weight:800;color:#29ABE2;letter-spacing:.06em">${b.code}</div>
        </div>
        <table style="width:100%;font-size:14px;border-collapse:collapse">
          <tr><td style="padding:7px 0;color:#7B7B92">Date</td><td align="right">${dateLabel(b.dateISO)}</td></tr>
          <tr><td style="padding:7px 0;color:#7B7B92">Game time</td><td align="right">${time}</td></tr>
          <tr><td style="padding:7px 0;color:#7B7B92">Players</td><td align="right">${b.players}</td></tr>
          <tr><td style="padding:7px 0;color:#7B7B92">Total</td><td align="right" style="color:#29ABE2;font-weight:700">${money(b.totalCents)}</td></tr>
        </table>
        <div style="margin-top:20px;background:rgba(249,161,27,.1);border:1px solid rgba(249,161,27,.38);border-radius:10px;padding:14px;font-size:13.5px;color:#f4cd91">
          <b>Before you arrive:</b> every player needs a signed waiver, and under-18s need a
          parent or legal guardian to sign. Clean closed-toe shoes only. We're a nut-free
          facility, so please no outside food or drink.
        </div>
        <p style="margin:20px 0 0;font-size:12.5px;color:#7B7B92">
          ${ARENA.address}<br>${ARENA.phone}
        </p>
      </div>
    </div>`;

  return { subject: `You're booked at ${ARENA.name} — ${b.code}`, text, html };
}

/** Fire the confirmation SMS + email for a laser tag booking. Never throws. */
export async function sendBookingConfirmation(b) {
  const email = bookingEmail(b);
  const [sms, mail] = await Promise.all([
    sendSms({ to: b.phone, body: bookingSmsBody(b), kind: 'booking-confirmation', bookingCode: b.code }),
    sendEmail({ to: b.email, ...email, kind: 'booking-confirmation', bookingCode: b.code }),
  ]);
  return { sms, email: mail };
}

/** Confirmation for a party request — different wording: it's pencilled in, not paid. */
export async function sendPartyConfirmation(b) {
  const when = `${dateLabel(b.dateISO)} · ${fmtTime(b.slotStart)}–${fmtTime(b.slotEnd)}`;
  const body = `${ARENA.name}: your ${b.packageName || 'party'} is pencilled in for ${when} `
    + `(${b.players} guests). Code ${b.code}. We'll call to confirm and take your deposit. ${ARENA.phone}`;

  const text = [
    `Your party request is in!`, ``,
    `Package: ${b.packageName || 'Party'}`,
    `Code: ${b.code}`,
    `When: ${when}`,
    `Guests: ${b.players}`,
    b.age ? `Birthday age: ${b.age}` : '',
    `Estimated total: ${money(b.totalCents)}`, ``,
    `The front desk will call to confirm the details and take your deposit.`,
    `Every player needs a signed waiver before they play.`, ``,
    `${ARENA.address}`, `${ARENA.phone}`,
  ].filter(Boolean).join('\n');

  const [sms, mail] = await Promise.all([
    sendSms({ to: b.phone, body, kind: 'party-request', bookingCode: b.code }),
    sendEmail({
      to: b.email, subject: `${ARENA.name} — your party request (${b.code})`, text,
      html: `<div style="font-family:system-ui,sans-serif;padding:24px;background:#07070C;color:#fff">
               <div style="max-width:520px;margin:0 auto;background:#14141E;border:1px solid #2A2A3B;border-radius:14px;padding:26px">
                 <h1 style="font-size:21px;margin:0 0 12px">Your party request is in</h1>
                 <pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;color:#B4B4C6;margin:0">${text}</pre>
               </div></div>`,
      kind: 'party-request', bookingCode: b.code,
    }),
  ]);
  return { sms, email: mail };
}

/** Day-before nudge. Short on purpose — reminders that ramble get ignored. */
export function reminderSmsBody(b) {
  const span = sessionSpan(b.dateISO, b.startMin, b.games);
  const time = span.length ? fmtTime(span[0]) : fmtTime(b.startMin);
  return `${ARENA.name} reminder: your game is tomorrow at ${time} `
    + `(${b.players} player${b.players > 1 ? 's' : ''}, code ${b.code}). `
    + `Waivers required — sign online to skip the desk. Closed-toe shoes only!`;
}

export async function sendReminder(b) {
  const body = reminderSmsBody(b);
  const [sms, mail] = await Promise.all([
    sendSms({ to: b.phone, body, kind: 'reminder', bookingCode: b.code }),
    sendEmail({
      to: b.email, subject: `Your ${ARENA.name} game is tomorrow`, text: body,
      html: `<div style="font-family:system-ui,sans-serif;padding:24px;background:#07070C;color:#fff">
               <div style="max-width:520px;margin:0 auto;background:#14141E;border:1px solid #2A2A3B;border-radius:14px;padding:26px">
                 <h1 style="font-size:20px;margin:0 0 10px">See you tomorrow!</h1>
                 <p style="color:#B4B4C6;font-size:14px;line-height:1.6;margin:0">${body}</p>
               </div></div>`,
      kind: 'reminder', bookingCode: b.code,
    }),
  ]);
  return { sms, email: mail };
}
