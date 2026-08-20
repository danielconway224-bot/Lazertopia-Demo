// The JSON API, as an Express app.
//
// Shared by both runtimes so the API behaves identically in each:
//   • local  — server.js mounts this alongside static files and page routes
//   • Vercel — api/index.js exports it as a serverless function
//
// Routes are declared with their full `/api/...` paths, which is what Express sees in both
// cases (Vercel preserves the original URL when it rewrites into a function).

import express from 'express';

import { stripeStatus, getStripe } from './payments.js';
import {
  messagingStatus, getOutbox, sendBookingConfirmation, sendPartyConfirmation, sendReminder,
} from './messaging.js';

import {
  ARENA, PACKAGES, EVENT_PACKAGES, PACKAGE_PERKS, PACKAGE_BASE_GUESTS, HOUSE_RULES,
  WEEKLY_HOURS, SPECIAL_HOURS, PARTY_ROOM_SLOTS, ADD_ONS,
  EXTRA_PIZZAS, PIZZA_TOPPINGS, WINGS, WING_SAUCES, PIZZA_TIERS, FOOD_PRICES_INCLUDE_TAX,
  hoursFor, priceBooking, groupNoticeOk, priceEventPackage, isoDate, validAge, parseISO, fmtTime,
  arenaToday, heldGamesFor, isBookableOnline, pizzasFor, splitsForLaserTag,
} from './arena.js';
import {
  availabilityFor, gameSheetFor, addBooking, blockSession, cancelBooking, findByCode, statsFor,
  partySlotsFor, addParty, releaseHeldGame, holdGame, analyticsFor, findByCheckoutSession,
  bookingsFor, storeStatus,
  listBookings, listCustomers, listNotes, addNote, setNoteDone, deleteNote, listParties,
  slotsFor, saveSlots, resetSlots, reportsFor,
} from './store.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Winnipeg's today, not the server's — Vercel runs in UTC.
const todayISO = () => arenaToday();

/** Pull a validated date off a query string, defaulting to today. */
function queryDate(req) {
  const d = (req.query && req.query.date) || '';
  return DATE_RE.test(d) ? d : todayISO();
}

/**
 * Where Stripe should send the customer back to.
 *
 * Built from the request's own host, never from a client-supplied value — a caller who could
 * choose the return URL could send a paying customer anywhere. The browser's `origin` is only
 * accepted when it matches the host we're already serving.
 */
export function safeOrigin(claimed, req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const own = `${proto}://${host}`;
  try {
    if (claimed && new URL(String(claimed)).host === host) return String(claimed).replace(/\/$/, '');
  } catch (_) { /* unparseable — fall through to our own */ }
  return own;
}

/** 'YYYY-MM-DD' -> 'Friday, Aug 14', for the Stripe line-item description. */
function longDateLabel(dateISO) {
  const d = parseISO(dateISO);
  return d ? d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) : dateISO;
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
      packageBaseGuests: PACKAGE_BASE_GUESTS,
      addOns: ADD_ONS,
      extraPizzas: EXTRA_PIZZAS,
      pizzaToppings: PIZZA_TOPPINGS,
      pizzaTiers: PIZZA_TIERS,
      wings: WINGS,
      wingSauces: WING_SAUCES,
      foodPricesIncludeTax: FOOD_PRICES_INCLUDE_TAX,
      houseRules: HOUSE_RULES,
      weeklyHours: WEEKLY_HOURS,
      specialHours: SPECIAL_HOURS,
      partyRoomSlots: PARTY_ROOM_SLOTS,
      today: todayISO(),
      // The publishable key is designed to be public — it can only create payments, never
      // read or refund. The secret key never leaves the server.
      stripeEnabled: stripeStatus().enabled,
      stripePublishableKey: stripeStatus().publishableKey,
      messaging: messagingStatus(),
      store: storeStatus(),
    });
  });

  /**
   * Start a hosted Stripe Checkout session and hand back the URL to send the customer to.
   *
   * The amount is built here from the players/games the customer picked — the browser never
   * sends a price. The whole booking rides along in the session's metadata, so when Stripe
   * sends the customer back we can rebuild the booking from Stripe's copy of it rather than
   * trusting whatever the returning page claims.
   */
  app.post('/api/checkout-session', async (req, res) => {
    if (!stripeStatus().enabled) {
      return res.status(503).json({ error: 'Card payments are not configured on this server.' });
    }
    const { dateISO, startMin, games, players, name, email, phone, origin } = req.body || {};

    if (!DATE_RE.test(String(dateISO || ''))) return res.status(400).json({ error: 'Pick a date for your game.' });
    if (hoursFor(dateISO).closed) return res.status(400).json({ error: "We're closed that day. Please pick another date." });
    if (!String(name || '').trim()) return res.status(400).json({ error: 'Please enter the name the booking is under.' });
    if (!String(phone || '').trim()) return res.status(400).json({ error: 'Please enter a phone number so we can reach you about this booking.' });

    const priced = priceBooking({ players, games });
    if (!priced.ok) return res.status(400).json({ error: priced.error });

    const notice = groupNoticeOk({ dateISO, startMin, players }, new Date());
    if (!notice.ok) return res.status(400).json({ error: notice.error });

    // Don't send anyone to a payment page for a game they can't have.
    if (!isBookableOnline(dateISO, startMin)) {
      return res.status(400).json({
        error: `Online booking closes ${ARENA.onlineCutoffMin} minutes before a game starts, so we can keep seats for walk-ins. Please pick a later game time, or call us at ${ARENA.phone}.`,
      });
    }
    const seat = (await availabilityFor(dateISO)).find((s) => s.startMin === Number(startMin));
    if (!seat || seat.held || seat.blocked || seat.seatsLeft < priced.players) {
      return res.status(409).json({ error: 'That game just filled up. Please pick another time.' });
    }

    // Only same-origin return URLs — an attacker-supplied origin would otherwise bounce
    // paying customers to a site of their choosing.
    const base = safeOrigin(origin, req);

    try {
      const session = await getStripe().checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          quantity: priced.players,
          price_data: {
            currency: 'cad',
            unit_amount: priced.perPersonCents,
            product_data: {
              name: `Laser tag — ${priced.games} game${priced.games > 1 ? 's' : ''} per player`,
              description: `${longDateLabel(dateISO)} at ${fmtTime(Number(startMin))} · ${ARENA.name}`,
            },
          },
        }],
        customer_email: String(email || '').trim() || undefined,
        success_url: `${base}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/?checkout=cancelled`,
        metadata: {
          dateISO,
          startMin: String(startMin),
          games: String(priced.games),
          players: String(priced.players),
          name: String(name).trim().slice(0, 200),
          phone: String(phone).trim().slice(0, 60),
          email: String(email || '').trim().slice(0, 200),
        },
      });
      res.json({ url: session.url });
    } catch (err) {
      console.error('checkout-session:', err.message);
      res.status(502).json({ error: "We couldn't start the payment. Please try again, or call us to book." });
    }
  });

  /**
   * Finish the job after Stripe sends the customer back.
   *
   * The booking is built from the SESSION's metadata, not from anything the returning page
   * sends — the only thing we take from the browser is the session id, and Stripe is the one
   * that says whether it was paid.
   */
  app.post('/api/confirm-checkout', async (req, res) => {
    if (!stripeStatus().enabled) {
      return res.status(503).json({ error: 'Card payments are not configured on this server.' });
    }
    const sessionId = String((req.body || {}).sessionId || '');
    if (!sessionId.startsWith('cs_')) return res.status(400).json({ error: 'Missing payment reference.' });

    // Refreshing the confirmation page must not book twice.
    const already = await findByCheckoutSession(sessionId);
    if (already) {
      return res.json({ booking: already, price: priceBooking({ players: already.players, games: already.games }), alreadyBooked: true });
    }

    let session;
    try {
      session = await getStripe().checkout.sessions.retrieve(sessionId);
    } catch (err) {
      console.error('confirm-checkout:', err.message);
      return res.status(502).json({ error: "We couldn't check that payment. If you were charged, call us and we'll sort it out." });
    }
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: "That payment didn't complete, so nothing was booked." });
    }

    const md = session.metadata || {};
    const priced = priceBooking({ players: md.players, games: md.games });
    if (!priced.ok) return res.status(400).json({ error: priced.error });

    const saved = await addBooking({
      dateISO: md.dateISO,
      startMin: Number(md.startMin),
      games: priced.games,
      players: priced.players,
      name: md.name || '',
      email: md.email || session.customer_details?.email || '',
      phone: md.phone || '',
      kind: 'online',
      totalCents: priced.totalCents,
      group: priced.group,
      checkoutSessionId: session.id,
      paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
    });

    if (!saved.ok) {
      // Paid, but the seats went while they were on Stripe's page. Say so plainly rather
      // than pretending it worked — a real deployment would auto-refund here.
      console.error(`⚠ PAID BUT UNSEATED — session ${session.id}: ${saved.error}`);
      return res.status(409).json({
        error: `Your payment went through, but that game filled up while you were paying. Please call us on ${ARENA.phone} and we'll rebook you or refund you right away.`,
        paid: true,
      });
    }

    console.log(`✅ Booking ${saved.booking.code} — paid via Stripe Checkout (${session.id})`);
    sendBookingConfirmation(saved.booking).catch((e) => console.error('confirmation:', e.message));
    res.json({ booking: saved.booking, price: priced });
  });

  // Seats left in every game session on a date. No customer data — this is public.
  app.get('/api/sessions', async (req, res) => {
    const date = queryDate(req);
    res.json({ date, hours: hoursFor(date), sessions: await availabilityFor(date) });
  });

  // Book a laser tag session. The server re-prices and re-checks capacity: the browser's
  // numbers are display only, and its "seats left" may be seconds out of date.
  app.post('/api/book', async (req, res) => {
    const { dateISO, startMin, games, players, name, email, phone, paymentIntentId } = req.body || {};

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

    // When cards are live, a booking is only real once Stripe says the money arrived — and
    // the payment has to be for THIS booking at THIS price. Trusting the browser's word that
    // it paid would let anyone book for free by posting straight to this endpoint.
    let paidWith = null;
    if (stripeStatus().enabled) {
      if (!paymentIntentId) {
        return res.status(402).json({ error: 'Payment is required to confirm this booking.' });
      }
      try {
        const intent = await getStripe().paymentIntents.retrieve(String(paymentIntentId));
        if (intent.status !== 'succeeded') {
          return res.status(402).json({ error: "That payment hasn't gone through yet. Please try again." });
        }
        if (intent.amount_received !== priced.totalCents) {
          console.warn(`⚠ amount mismatch on ${intent.id}: paid ${intent.amount_received}, owed ${priced.totalCents}`);
          return res.status(400).json({ error: "The payment didn't match the booking total. Please start again, or call us." });
        }
        const md = intent.metadata || {};
        if (md.dateISO !== dateISO || Number(md.startMin) !== Number(startMin)) {
          return res.status(400).json({ error: 'That payment was for a different game time. Please start again.' });
        }
        paidWith = intent.id;
      } catch (err) {
        console.error('verify payment:', err.message);
        return res.status(502).json({ error: "We couldn't verify that payment. If you were charged, call us and we'll sort it out." });
      }
    }

    const saved = await addBooking({
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
      paymentIntentId: paidWith,
    });
    if (!saved.ok) return res.status(saved.status || 400).json({ error: saved.error });

    console.log(`✅ Booking ${saved.booking.code} — ${dateISO} ${startMin}m · ${priced.players}p × ${priced.games} game(s)`);
    // Confirmation goes out after the booking is safely stored. Deliberately not awaited —
    // a slow or failing provider must never cost the customer their confirmation screen.
    sendBookingConfirmation(saved.booking).catch((e) => console.error('confirmation:', e.message));
    res.json({ booking: saved.booking, price: priced });
  });

  /**
   * Strip the party board down to what a member of the public may see. Another family's
   * name, phone and booking code are none of their business — but the *age* is, because it
   * decides whether they can share the slot, so that one field stays.
   */
  async function publicPartySlots(date, age, guests) {
    return (await partySlotsFor(date, age, guests)).map((s) => ({
      ...s,
      parties: s.parties.map((p) => ({ age: p.age })),
    }));
  }

  // The party board for a date. Pass `age` and `guests` to have each slot answer for that
  // specific enquiry: does the guest of honour fit alongside whoever's booked, and is there
  // a room left big enough?
  app.get('/api/party-slots', async (req, res) => {
    const date = queryDate(req);
    const q = req.query || {};
    const age = q.age ? Number(q.age) : null;
    const guests = q.guests ? Number(q.guests) : null;
    res.json({
      date,
      hours: hoursFor(date),
      ageSpreadYears: ARENA.partyAgeSpreadYears,
      maxGuestsOnline: ARENA.maxPartyGuestsOnline,
      depositCents: ARENA.partyDepositCents,
      slots: await publicPartySlots(date, age, guests),
    });
  });

  /**
   * Book a party into a 2-hour room slot.
   * Shared by the public page and the staff desk — `staff: true` unlocks the age override,
   * which is a judgement call the front desk is allowed to make and the public isn't.
   */
  async function bookParty(req, res, { staff = false } = {}) {
    const { dateISO, slotStart, packageId, guests, age, name, phone, email } = req.body || {};

    if (!DATE_RE.test(String(dateISO || ''))) {
      return res.status(400).json({ error: 'Pick a date for the party.' });
    }
    if (hoursFor(dateISO).closed) {
      return res.status(400).json({ error: "We're closed that day. Please pick another date." });
    }
    if (!String(name || '').trim() || !String(phone || '').trim()) {
      return res.status(400).json({ error: 'We need a name and phone number to confirm your party.' });
    }
    if (!validAge(age)) {
      return res.status(400).json({ error: "Please tell us the birthday guest's age — we seat parties with others close in age." });
    }

    const body = req.body || {};
    const priced = priceEventPackage(packageId, guests, { addOns: body.addOns, food: body.food });
    if (!priced.ok) return res.status(400).json({ error: priced.error });

    const saved = await addParty({
      dateISO,
      slotStart,
      age: Number(age),
      guests: priced.guests,
      override: staff && !!body.override,
      name: String(name).trim(),
      phone: String(phone).trim(),
      email: String(email || '').trim(),
      packageId: priced.packageId,
      packageName: priced.name,
      totalCents: priced.totalCents,
      pizzas: priced.pizzas,
      addOns: priced.addOns.map((a) => a.id),
      note: `${priced.name} · ${priced.roomMinutes} min party room`,
    });
    if (!saved.ok) return res.status(saved.status || 400).json({ error: saved.error });

    console.log(`🎉 Party ${saved.booking.code} — ${priced.name} · ${priced.guests} guests, age ${age}, on ${dateISO}`);
    sendPartyConfirmation(saved.booking).catch((e) => console.error('party confirmation:', e.message));
    res.json({ booking: saved.booking, price: priced });
  }

  app.post('/api/party', (req, res) => bookParty(req, res));

  // Look up a booking by its code (the "find my booking" page).
  app.get('/api/booking/:code', async (req, res) => {
    const hit = await findByCode(req.params.code);
    if (!hit) {
      return res.status(404).json({ error: `We couldn't find a booking with that code. Check the code on your confirmation, or call us at ${ARENA.phone}.` });
    }
    res.json({ booking: hit });
  });

  app.post('/api/cancel', async (req, res) => {
    const hit = await findByCode((req.body || {}).code);
    if (!hit) return res.status(404).json({ error: "We couldn't find a booking with that code." });
    const r = await cancelBooking(hit.id);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Staff
  // -------------------------------------------------------------------------
  // Demo only — there's no auth here. Real staff sign-in arrives with Supabase.

  app.get('/api/staff/sheet', async (req, res) => {
    const date = queryDate(req);
    res.json({
      date,
      hours: hoursFor(date),
      sessions: await gameSheetFor(date),
      stats: await statsFor(date),
      partySlots: await partySlotsFor(date),
    });
  });

  // Everything the system has sent, newest first. Includes simulated messages, which is
  // what makes the notification flow demonstrable without a Twilio account.
  app.get('/api/staff/outbox', (req, res) => {
    res.json({
      messaging: messagingStatus(),
      store: storeStatus(),
      messages: getOutbox((req.query && req.query.limit) || 50),
    });
  });

  /**
   * Fire day-before reminders for a date's bookings.
   *
   * A real deployment would run this on a schedule; a button makes it demonstrable without
   * waiting a day. Parties are skipped — the desk calls those personally.
   */
  app.post('/api/staff/send-reminders', async (req, res) => {
    const { dateISO } = req.body || {};
    if (!DATE_RE.test(String(dateISO || ''))) return res.status(400).json({ error: 'Pick a date.' });

    const targets = (await bookingsFor(dateISO)).filter((b) => b.kind !== 'block' && b.kind !== 'party');
    if (!targets.length) return res.json({ sent: 0, message: 'No bookings on that day to remind.' });

    const results = await Promise.all(targets.map((b) => sendReminder(b).catch(() => null)));
    const ok = results.filter(Boolean).length;
    res.json({
      sent: ok,
      total: targets.length,
      message: `Reminders sent for ${ok} booking${ok === 1 ? '' : 's'} on ${dateISO}.`,
    });
  });

  // Re-send a single booking's confirmation — the "I never got the text" button.
  app.post('/api/staff/resend', async (req, res) => {
    const hit = await findByCode((req.body || {}).code);
    if (!hit) return res.status(404).json({ error: "We couldn't find a booking with that code." });
    const out = hit.kind === 'party' ? await sendPartyConfirmation(hit) : await sendBookingConfirmation(hit);
    res.json({ ok: true, sms: out.sms.state, email: out.email.state });
  });

  // Revenue over a trailing window, for the analytics panel.
  app.get('/api/staff/analytics', async (req, res) => {
    const date = queryDate(req);
    const days = Number((req.query && req.query.days) || 7);
    res.json({ date, ...(await analyticsFor(date, days)) });
  });

  // Staff can book a party, and may override the age-matching rule.
  app.post('/api/staff/party', (req, res) => bookParty(req, res, { staff: true }));

  // Open a party-held game to the public, or take one back off it.
  app.post('/api/staff/release-game', async (req, res) => {
    const { dateISO, startMin } = req.body || {};
    if (!DATE_RE.test(String(dateISO || ''))) return res.status(400).json({ error: 'Pick a date.' });
    const r = await releaseHeldGame(dateISO, startMin);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json(r);
  });

  app.post('/api/staff/hold-game', async (req, res) => {
    const { dateISO, startMin } = req.body || {};
    if (!DATE_RE.test(String(dateISO || ''))) return res.status(400).json({ error: 'Pick a date.' });
    const r = await holdGame(dateISO, startMin);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json(r);
  });

  // Walk-in: someone at the front desk, paying at the counter.
  app.post('/api/staff/walkin', async (req, res) => {
    const { dateISO, startMin, players, games, name } = req.body || {};
    if (!DATE_RE.test(String(dateISO || ''))) return res.status(400).json({ error: 'Pick a date.' });

    const priced = priceBooking({ players, games });
    if (!priced.ok) return res.status(400).json({ error: priced.error });

    const saved = await addBooking({
      dateISO,
      startMin,
      games: priced.games,
      players: priced.players,
      name: String(name || '').trim() || 'Walk-in',
      kind: 'walkin',
      totalCents: priced.totalCents,
      group: priced.group,
      allowPast: true,      // the desk records people into the game that's running now
      allowHeld: true,      // and can seat a walk-in in a party-held game if it's going spare
    });
    if (!saved.ok) return res.status(saved.status || 400).json({ error: saved.error });
    res.json({ booking: saved.booking });
  });

  // Close a game to the public (private hire, maintenance).
  app.post('/api/staff/block', async (req, res) => {
    const { dateISO, startMin, note } = req.body || {};
    if (!DATE_RE.test(String(dateISO || ''))) return res.status(400).json({ error: 'Pick a date.' });
    const r = await blockSession(dateISO, startMin, note);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json({ booking: r.booking });
  });

  app.post('/api/staff/cancel', async (req, res) => {
    const r = await cancelBooking((req.body || {}).id);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json({ ok: true });
  });

  // ----- Manager portal -----

  /** Every booking, searchable. Paged — a year of trading is thousands of rows. */
  app.get('/api/staff/bookings', async (req, res) => {
    const q = req.query || {};
    const clamp = (v, d, max) => Math.min(max, Math.max(1, Math.round(Number(v) || d)));
    res.json(await listBookings({
      search: String(q.search || ''),
      from: DATE_RE.test(String(q.from || '')) ? q.from : null,
      to: DATE_RE.test(String(q.to || '')) ? q.to : null,
      kind: ['online', 'walkin', 'party', 'block'].includes(q.kind) ? q.kind : 'all',
      paid: ['paid', 'due'].includes(q.paid) ? q.paid : 'all',
      limit: clamp(q.limit, 100, 500),
      offset: Math.max(0, Math.round(Number(q.offset) || 0)),
    }));
  });

  /** Customers, aggregated from bookings by phone number. */
  app.get('/api/staff/customers', async (req, res) => {
    const q = req.query || {};
    res.json(await listCustomers({
      search: String(q.search || ''),
      limit: Math.min(500, Math.max(1, Math.round(Number(q.limit) || 100))),
      offset: Math.max(0, Math.round(Number(q.offset) || 0)),
    }));
  });

  /** Every party in a window, with the whole record — the desk needs all of it. */
  app.get('/api/staff/parties', async (req, res) => {
    const q = req.query || {};
    const out = await listParties({
      from: DATE_RE.test(String(q.from || '')) ? q.from : null,
      to: DATE_RE.test(String(q.to || '')) ? q.to : null,
    });
    // Slot definitions travel with it so the portal can show the rooms a slot actually has.
    res.json({ ...out, partyRoomSlots: PARTY_ROOM_SLOTS, addOns: ADD_ONS,
               depositCents: ARENA.partyDepositCents, splitAbove: ARENA.partySplitAbove });
  });

  /* ----- Party schedule for one date, and the manager's edits to it ----- */

  app.get('/api/staff/party-slots', async (req, res) => {
    const date = queryDate(req);
    const d = parseISO(date);
    res.json({
      date,
      slots: await slotsFor(date),
      standing: PARTY_ROOM_SLOTS[d ? d.getDay() : 0] || [],
      sessionStepMin: ARENA.sessionStepMin,
    });
  });

  app.put('/api/staff/party-slots', async (req, res) => {
    const { dateISO, slots } = req.body || {};
    if (!DATE_RE.test(String(dateISO || ''))) return res.status(400).json({ error: 'Pick a date.' });
    if (!Array.isArray(slots)) return res.status(400).json({ error: 'Send the full list of slots for the day.' });

    // A slot with no rooms can never take a booking, and two slots starting at the same
    // minute cannot both be real.
    const seen = new Set();
    for (const s of slots) {
      if (!Number.isFinite(Number(s.start)) || !Number.isFinite(Number(s.end)) || Number(s.end) <= Number(s.start)) {
        return res.status(400).json({ error: 'Every slot needs a start and a later end time.' });
      }
      if (!Array.isArray(s.rooms) || !s.rooms.length) {
        return res.status(400).json({ error: `The ${fmtTime(Number(s.start))} slot needs at least one room.` });
      }
      if (seen.has(Number(s.start))) {
        return res.status(400).json({ error: `Two slots both start at ${fmtTime(Number(s.start))}.` });
      }
      seen.add(Number(s.start));
    }

    const r = await saveSlots(dateISO, slots);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json({ ok: true, slots: await slotsFor(dateISO) });
  });

  app.post('/api/staff/party-slots/reset', async (req, res) => {
    const { dateISO } = req.body || {};
    if (!DATE_RE.test(String(dateISO || ''))) return res.status(400).json({ error: 'Pick a date.' });
    const r = await resetSlots(dateISO);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json({ ok: true, slots: await slotsFor(dateISO) });
  });

  /** Reports for a window. Sales are by purchase date, trade by the day games ran. */
  app.get('/api/staff/reports', async (req, res) => {
    const q = req.query || {};
    const to = DATE_RE.test(String(q.to || '')) ? q.to : todayISO();
    let from = DATE_RE.test(String(q.from || '')) ? q.from : null;
    if (!from) {
      const days = Math.min(365, Math.max(1, Math.round(Number(q.days) || 7)));
      const d = parseISO(to);
      d.setDate(d.getDate() - (days - 1));
      from = isoDate(d);
    }
    if (from > to) return res.status(400).json({ error: 'The start date is after the end date.' });

    const data = await reportsFor({ from, to });
    if (!data) return res.status(502).json({ error: "We couldn't build that report. Please try again." });
    res.json({ from, to, capacity: ARENA.capacity, ...data });
  });

  app.get('/api/staff/notes', async (_req, res) => {
    try {
      res.json({ notes: await listNotes(), durable: storeStatus().durable });
    } catch (e) {
      res.status(e.setup ? 503 : 500).json({ error: e.message });
    }
  });

  app.post('/api/staff/notes', async (req, res) => {
    const { body, author, kind } = req.body || {};
    const r = await addNote({ body, author, kind: kind === 'ops' ? 'ops' : 'dev' });
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json({ note: r.note });
  });

  app.post('/api/staff/notes/:id/done', async (req, res) => {
    const r = await setNoteDone(req.params.id, (req.body || {}).done);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json({ ok: true });
  });

  app.delete('/api/staff/notes/:id', async (req, res) => {
    const r = await deleteNote(req.params.id);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json({ ok: true });
  });

  // Any /api path that got this far doesn't exist. Answer in JSON, not HTML, so the
  // browser's `api()` helper can surface a sensible message instead of a parse error.
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));

  return app;
}
