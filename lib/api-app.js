// The JSON API, as an Express app.
//
// Shared by both runtimes so the API behaves identically in each:
//   • local  — server.js mounts this alongside static files and page routes
//   • Vercel — api/index.js exports it as a serverless function
//
// Routes are declared with their full `/api/...` paths, which is what Express sees in both
// cases (Vercel preserves the original URL when it rewrites into a function).

import express from 'express';

import {
  ARENA, PACKAGES, EVENT_PACKAGES, PACKAGE_PERKS, HOUSE_RULES, WEEKLY_HOURS, SPECIAL_HOURS,
  hoursFor, priceBooking, groupNoticeOk, priceEventPackage, isoDate,
} from './arena.js';
import {
  availabilityFor, gameSheetFor, addBooking, blockSession, cancelBooking, findByCode, statsFor,
} from './demo-store.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayISO = () => isoDate(new Date());

/** Pull a validated date off a query string, defaulting to today. */
function queryDate(req) {
  const d = (req.query && req.query.date) || '';
  return DATE_RE.test(d) ? d : todayISO();
}

export function createApiApp() {
  const app = express();
  app.use(express.json());

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  // Static config the pages render from (rates, packages, rules, hours).
  app.get('/api/config', (_req, res) => {
    res.json({
      arena: ARENA,
      packages: PACKAGES,
      eventPackages: EVENT_PACKAGES,
      packagePerks: PACKAGE_PERKS,
      houseRules: HOUSE_RULES,
      weeklyHours: WEEKLY_HOURS,
      specialHours: SPECIAL_HOURS,
      today: todayISO(),
    });
  });

  // Seats left in every game session on a date. No customer data — this is public.
  app.get('/api/sessions', (req, res) => {
    const date = queryDate(req);
    res.json({ date, hours: hoursFor(date), sessions: availabilityFor(date) });
  });

  // Book a laser tag session. The server re-prices and re-checks capacity: the browser's
  // numbers are display only, and its "seats left" may be seconds out of date.
  app.post('/api/book', (req, res) => {
    const { dateISO, startMin, games, players, name, email, phone } = req.body || {};

    if (!DATE_RE.test(String(dateISO || ''))) {
      return res.status(400).json({ error: 'Pick a date for your game.' });
    }
    if (hoursFor(dateISO).closed) {
      return res.status(400).json({ error: "We're closed that day. Please pick another date." });
    }
    if (!String(name || '').trim()) {
      return res.status(400).json({ error: 'Please enter the name the booking is under.' });
    }
    if (!String(phone || '').trim()) {
      return res.status(400).json({ error: 'Please enter a phone number so we can reach you about this booking.' });
    }

    const priced = priceBooking({ players, games });
    if (!priced.ok) return res.status(400).json({ error: priced.error });

    const notice = groupNoticeOk({ dateISO, startMin, players }, new Date());
    if (!notice.ok) return res.status(400).json({ error: notice.error });

    const saved = addBooking({
      dateISO,
      startMin,
      games: priced.games,
      players: priced.players,
      name: String(name).trim(),
      email: String(email || '').trim(),
      phone: String(phone).trim(),
      kind: 'online',
      totalCents: priced.totalCents,
      group: priced.group,
    });
    if (!saved.ok) return res.status(saved.status || 400).json({ error: saved.error });

    console.log(`✅ Booking ${saved.booking.code} — ${dateISO} ${startMin}m · ${priced.players}p × ${priced.games} game(s)`);
    res.json({ booking: saved.booking, price: priced });
  });

  // Request a party room. Lands on the staff sheet as a party booking to be confirmed.
  app.post('/api/party', (req, res) => {
    const { dateISO, startMin, packageId, guests, name, phone, email } = req.body || {};

    if (!DATE_RE.test(String(dateISO || ''))) {
      return res.status(400).json({ error: 'Pick a date for the party.' });
    }
    if (hoursFor(dateISO).closed) {
      return res.status(400).json({ error: "We're closed that day. Please pick another date." });
    }
    if (!String(name || '').trim() || !String(phone || '').trim()) {
      return res.status(400).json({ error: 'We need a name and phone number to confirm your party.' });
    }

    const priced = priceEventPackage(packageId, guests);
    if (!priced.ok) return res.status(400).json({ error: priced.error });

    // Party guests play 2 games, so they occupy two consecutive sessions in the arena.
    const saved = addBooking({
      dateISO,
      startMin,
      games: 2,
      players: priced.guests,
      name: String(name).trim(),
      phone: String(phone).trim(),
      email: String(email || '').trim(),
      kind: 'party',
      packageId: priced.packageId,
      packageName: priced.name,
      totalCents: priced.totalCents,
      note: `${priced.name} · ${priced.roomMinutes} min party room`,
    });
    if (!saved.ok) return res.status(saved.status || 400).json({ error: saved.error });

    console.log(`🎉 Party ${saved.booking.code} — ${priced.name} · ${priced.guests} guests on ${dateISO}`);
    res.json({ booking: saved.booking, price: priced });
  });

  // Look up a booking by its code (the "find my booking" page).
  app.get('/api/booking/:code', (req, res) => {
    const hit = findByCode(req.params.code);
    if (!hit) {
      return res.status(404).json({ error: `We couldn't find a booking with that code. Check the code on your confirmation, or call us at ${ARENA.phone}.` });
    }
    res.json({ booking: hit });
  });

  app.post('/api/cancel', (req, res) => {
    const hit = findByCode((req.body || {}).code);
    if (!hit) return res.status(404).json({ error: "We couldn't find a booking with that code." });
    const r = cancelBooking(hit.id);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Staff
  // -------------------------------------------------------------------------
  // Demo only — there's no auth here. Real staff sign-in arrives with Supabase.

  app.get('/api/staff/sheet', (req, res) => {
    const date = queryDate(req);
    res.json({ date, hours: hoursFor(date), sessions: gameSheetFor(date), stats: statsFor(date) });
  });

  // Walk-in: someone at the front desk, paying at the counter.
  app.post('/api/staff/walkin', (req, res) => {
    const { dateISO, startMin, players, games, name } = req.body || {};
    if (!DATE_RE.test(String(dateISO || ''))) return res.status(400).json({ error: 'Pick a date.' });

    const priced = priceBooking({ players, games });
    if (!priced.ok) return res.status(400).json({ error: priced.error });

    const saved = addBooking({
      dateISO,
      startMin,
      games: priced.games,
      players: priced.players,
      name: String(name || '').trim() || 'Walk-in',
      kind: 'walkin',
      totalCents: priced.totalCents,
      group: priced.group,
      allowPast: true,      // the desk records people into the game that's running now
    });
    if (!saved.ok) return res.status(saved.status || 400).json({ error: saved.error });
    res.json({ booking: saved.booking });
  });

  // Close a game to the public (private hire, maintenance).
  app.post('/api/staff/block', (req, res) => {
    const { dateISO, startMin, note } = req.body || {};
    if (!DATE_RE.test(String(dateISO || ''))) return res.status(400).json({ error: 'Pick a date.' });
    const r = blockSession(dateISO, startMin, note);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json({ booking: r.booking });
  });

  app.post('/api/staff/cancel', (req, res) => {
    const r = cancelBooking((req.body || {}).id);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json({ ok: true });
  });

  // Any /api path that got this far doesn't exist. Answer in JSON, not HTML, so the
  // browser's `api()` helper can surface a sensible message instead of a parse error.
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));

  return app;
}
