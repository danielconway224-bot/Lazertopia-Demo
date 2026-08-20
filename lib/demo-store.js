// In-memory booking store.
//
// Starts EMPTY and holds only what is actually booked. It used to invent a plausible day's
// trade on first access so the prototype looked busy; that is gone, because invented
// bookings in a system that takes real ones is how a customer ends up double-booked
// against a group that never existed.
//
// This is now the fallback for local development and the unit tests. Real bookings live in
// Postgres via lib/supabase-store.js. State here resets when the process restarts.

import { randomBytes } from 'node:crypto';

import {
  ARENA, sessionsFor, sessionSpan, parseISO, isoDate, isPastSession,
  partyRoomSlotsFor, heldGamesFor, heldGamesFromSlots, applySlotOverrides,
  roomFit, splitsForLaserTag, isBookableOnline,
} from './arena.js';
import {
  seatsAt, fitsIn, availabilityFrom, gameSheetFrom, partySlotsFrom, statsFrom,
  analyticsDates, analyticsFrom, buildReports,
} from './booking-views.js';

/** @type {Map<string, Array>} dateISO -> bookings for that date */
const byDate = new Map();

/**
 * Staff overrides to the default held-game pattern, per date:
 *   released — a party-held game the desk has opened to the public
 *   extraHeld — a normally-public game the desk has taken back for a party
 * @type {Map<string, {released:Set<number>, extraHeld:Set<number>}>}
 */
const holdOverrides = new Map();
let nextId = 1;

function overridesFor(dateISO) {
  if (!holdOverrides.has(dateISO)) holdOverrides.set(dateISO, { released: new Set(), extraHeld: new Set() });
  return holdOverrides.get(dateISO);
}

/** Is this game time currently withheld from public booking? */
export function isHeld(dateISO, startMin, slots = null) {
  const m = Number(startMin);
  const ov = overridesFor(dateISO);
  if (ov.released.has(m)) return false;      // staff opened it up
  if (ov.extraHeld.has(m)) return true;      // staff took it back
  return (slots ? heldGamesFromSlots(slots, dateISO) : heldGamesFor(dateISO)).includes(m);
}

/**
 * A booking code, e.g. LT-9SEDK8.
 *
 * The alphabet drops I, O, 0 and 1 — these get read aloud down the phone and written on a
 * whiteboard, and those four are the ones people mishear. Uses the crypto RNG rather than
 * Math.random: a guessable code is a way to look up someone else's booking.
 */
function codeFor() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return `LT-${out}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** All live (non-cancelled) bookings for a date. Empty until something is booked. */
export function bookingsFor(dateISO) {
  return (byDate.get(dateISO) || []).filter((b) => !b.cancelled);
}

/** The mutable list for a date, created on first write. */
function listFor(dateISO) {
  if (!byDate.has(dateISO)) byDate.set(dateISO, []);
  return byDate.get(dateISO);
}

/** @type {Map<string, Array>} dateISO -> manager edits to the party schedule */
const slotEdits = new Map();

/** The party slots in force on a date: weekly schedule plus any edits for that date. */
export function slotsFor(dateISO) {
  return applySlotOverrides(partyRoomSlotsFor(dateISO), slotEdits.get(dateISO) || []);
}

export function saveSlots(dateISO, slots) {
  const standing = partyRoomSlotsFor(dateISO);
  const rows = slots.map((s) => ({
    slotStart: Number(s.start), slotEnd: Number(s.end),
    rooms: (s.rooms || []).map(Number), combined: Number(s.combined) || 0,
    games: (s.games || []).map(Number), removed: false,
  }));
  for (const std of standing) {
    if (!slots.some((s) => Number(s.start) === std.start)) {
      rows.push({ slotStart: std.start, slotEnd: std.end, rooms: [], combined: 0, games: [], removed: true });
    }
  }
  slotEdits.set(dateISO, rows);
  return { ok: true };
}

export function resetSlots(dateISO) {
  slotEdits.delete(dateISO);
  return { ok: true };
}

/** Public availability for a date: one entry per game session. */
export function availabilityFor(dateISO) {
  const slots = slotsFor(dateISO);
  return availabilityFrom(bookingsFor(dateISO), dateISO, (m) => isHeld(dateISO, m, slots), slots);
}

/** The staff view: sessions with the groups in each one. */
export function gameSheetFor(dateISO) {
  const slots = slotsFor(dateISO);
  return gameSheetFrom(bookingsFor(dateISO), dateISO,
    (m) => isHeld(dateISO, m, slots), heldGamesFromSlots(slots, dateISO), slots);
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

/** The party board for a date. */
export function partySlotsFor(dateISO, age = null, guests = null) {
  return partySlotsFrom(bookingsFor(dateISO), dateISO, age, guests, slotsFor(dateISO));
}

/**
 * Book a party into a 2-hour room slot.
 * Rules, in the order a human would check them: does the slot exist → is there a spot →
 * does the building have room → do the ages match. `override` lets the front desk past the
 * age rule only; it never lets them oversell the building.
 */
export function addParty(input) {
  const { dateISO, slotStart, age, guests, override = false } = input;

  const slot = slotsFor(dateISO).find((s) => s.start === Number(slotStart));
  if (!slot) {
    return { ok: false, status: 400, error: "That party time isn't one we run on this day. Please pick another slot." };
  }

  // Ask the board about this exact age AND size so `ageFits` is meaningful either way — an
  // override needs to know it *is* overriding something, not a clean bill of health.
  const board = partySlotsFor(dateISO, age, guests).find((s) => s.start === slot.start);

  // Capacity is never overridable: the building holds what it holds.
  if (board.spotsLeft === 0 || !board.sizeFits) {
    const full = partySlotsFor(dateISO, null, guests).find((s) => s.start === slot.start);
    return { ok: false, status: 409, error: full.reason };
  }
  if (!board.ageFits && !override) {
    return { ok: false, status: 409, error: board.reason };
  }

  // Which physical rooms this party takes, so the next booking sees them gone.
  const fit = roomFit(slot, guests, board.roomsFree);

  const list = listFor(dateISO);

  const booking = {
    id: nextId++,
    code: codeFor(),
    dateISO,
    slotStart: slot.start,
    slotEnd: slot.end,
    // The party's laser tag games come from the held times inside its slot. Booking the
    // first of them keeps the party visible on the game sheet in the right place.
    startMin: slot.games.length ? slot.games[0] : slot.start,
    games: Math.max(1, slot.games.length),
    players: Number(guests),
    age: age == null ? null : Number(age),
    name: input.name || '',
    email: input.email || '',
    phone: input.phone || '',
    kind: 'party',
    packageId: input.packageId || null,
    packageName: input.packageName || null,
    totalCents: Number(input.totalCents) || 0,
    note: input.note || '',
    // Room allocation, so the board can tell what's genuinely left.
    rooms: fit.rooms,
    positions: fit.positions,
    // A party this size can't all play at once — the desk runs them as two groups.
    splitGroups: splitsForLaserTag(guests) ? 2 : 1,
    pizzas: input.pizzas ?? null,
    addOns: input.addOns || [],
    depositCents: ARENA.partyDepositCents,
    depositState: input.depositState || 'due',
    paymentIntentId: input.paymentIntentId || null,
    checkoutSessionId: input.checkoutSessionId || null,
    food: input.food || [],
    foodCents: Number(input.foodCents) || 0,
    // Flags a party the desk seated against the age rule, so the sheet can show it.
    ageOverride: !board.ageFits,
    createdAt: new Date().toISOString(),
    cancelled: false,
  };
  list.push(booking);
  return { ok: true, booking };
}

// ---------------------------------------------------------------------------
// Held-game overrides (staff)
// ---------------------------------------------------------------------------

/** Open a party-held game to the public. */
export function releaseHeldGame(dateISO, startMin) {
  const m = Number(startMin);
  if (!sessionsFor(dateISO).includes(m)) {
    return { ok: false, status: 400, error: "That game time isn't on the schedule for this day." };
  }
  const ov = overridesFor(dateISO);
  ov.extraHeld.delete(m);
  ov.released.add(m);
  return { ok: true, held: false };
}

/** Take a game back off the public — "we sometimes have to book off other time slots". */
export function holdGame(dateISO, startMin) {
  const m = Number(startMin);
  if (!sessionsFor(dateISO).includes(m)) {
    return { ok: false, status: 400, error: "That game time isn't on the schedule for this day." };
  }
  const ov = overridesFor(dateISO);
  ov.released.delete(m);
  ov.extraHeld.add(m);
  return { ok: true, held: true };
}

/**
 * Find the booking created for a Stripe Checkout session, if any.
 * This is what stops a refresh of the confirmation page booking (and charging for) twice.
 * Cancelled bookings still count — the payment was made, so re-confirming must not re-book.
 */
export function findByCheckoutSession(sessionId) {
  if (!sessionId) return null;
  for (const list of byDate.values()) {
    const hit = list.find((b) => b.checkoutSessionId === sessionId);
    if (hit) return hit;
  }
  return null;
}

/** Find one booking by its customer-facing code, across every date currently in memory. */
export function findByCode(code) {
  const want = String(code || '').trim().toUpperCase();
  if (!want) return null;
  for (const list of byDate.values()) {
    const hit = list.find((b) => b.code === want && !b.cancelled);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Add a booking. Capacity is re-checked here against live state — the browser's view of
 * "seats left" may be seconds stale, and two people can pick the same last seat.
 * @returns {{ok:true, booking}|{ok:false, error, status}}
 */
export function addBooking(input) {
  const { dateISO, startMin, games, players, kind = 'online', allowPast = false, allowHeld = false } = input;

  if (!sessionsFor(dateISO).includes(Number(startMin))) {
    return { ok: false, status: 400, error: "That game time isn't on the schedule for this day. Pick another time." };
  }
  // Staff can record a walk-in against a game that's already underway; the public can't.
  if (!allowPast && isPastSession(dateISO, Number(startMin))) {
    return { ok: false, status: 400, error: 'That game has already started. Please pick a later game time.' };
  }
  // Online sales stop early so seats are left for walk-ins at the door. The desk is exempt —
  // it shares the `allowPast` permission, since both are "staff booking close to the wire".
  if (!allowPast && !isBookableOnline(dateISO, Number(startMin))) {
    return {
      ok: false,
      status: 400,
      error: `Online booking closes ${ARENA.onlineCutoffMin} minutes before a game starts, so we can keep seats for walk-ins. Please pick a later game time, or call us at ${ARENA.phone} and we'll get you in.`,
    };
  }
  // Party-held times are off the public grid until the desk releases them. A multi-game run
  // has to clear every game it occupies, not just the one it starts in — otherwise buying
  // 3 games at 5:00pm would quietly swallow the 5:15 and 5:30 party slots.
  if (!allowHeld) {
    const clash = sessionSpan(dateISO, Number(startMin), Number(games)).find((m) => isHeld(dateISO, m));
    if (clash != null) {
      return { ok: false, status: 409, error: 'That game time is reserved for birthday parties. Please pick another time, or call us — it may open up.' };
    }
  }

  const list = listFor(dateISO);
  const live = list.filter((b) => !b.cancelled);

  if (!fitsIn(live, dateISO, Number(startMin), Number(games), Number(players))) {
    return { ok: false, status: 409, error: 'That game just filled up. Please pick another time — the grid has been refreshed.' };
  }

  const booking = {
    id: nextId++,
    code: input.code || codeFor(),
    dateISO,
    startMin: Number(startMin),
    games: Number(games),
    players: Number(players),
    name: input.name || '',
    email: input.email || '',
    phone: input.phone || '',
    kind,
    packageId: input.packageId || null,
    packageName: input.packageName || null,
    totalCents: Number(input.totalCents) || 0,
    group: !!input.group,
    note: input.note || '',
    // Set once a card payment has been verified with Stripe; null in simulated mode.
    paymentIntentId: input.paymentIntentId || null,
    checkoutSessionId: input.checkoutSessionId || null,
    food: input.food || [],
    foodCents: Number(input.foodCents) || 0,
    createdAt: new Date().toISOString(),
    cancelled: false,
  };
  list.push(booking);
  return { ok: true, booking };
}

/** Close a whole game session (private hire, maintenance). */
export function blockSession(dateISO, startMin, note) {
  if (!sessionsFor(dateISO).includes(Number(startMin))) {
    return { ok: false, status: 400, error: "That game time isn't on the schedule for this day." };
  }
  const list = listFor(dateISO);
  const booking = {
    id: nextId++,
    code: `BLK-${nextId}`,
    dateISO,
    startMin: Number(startMin),
    games: 1,
    players: 0,
    name: note || 'Blocked',
    kind: 'block',
    totalCents: 0,
    note: note || '',
    createdAt: new Date().toISOString(),
    cancelled: false,
  };
  list.push(booking);
  return { ok: true, booking };
}

export function cancelBooking(id) {
  for (const list of byDate.values()) {
    const hit = list.find((b) => b.id === Number(id));
    if (hit) { hit.cancelled = true; return { ok: true, booking: hit }; }
  }
  return { ok: false, status: 404, error: "We couldn't find that booking. Check the code and try again." };
}

/**
 * Revenue over the N days ending on `dateISO`, for the analytics panel.
 *
 * Closed days come back at zero rather than being dropped, so the shape of the week stays
 * honest — a quiet Monday and a closed Monday are different facts.
 */
export function analyticsFor(dateISO, days = 7) {
  return analyticsFrom(analyticsDates(dateISO, days), bookingsFor, availabilityFor);
}

/** Headline numbers for the staff dashboard strip. */
export function statsFor(dateISO) {
  return statsFrom(bookingsFor(dateISO), availabilityFor(dateISO));
}

/* ------------------------------------------------------------------ *
 * Manager portal
 *
 * The Postgres store does this work in SQL. Here it is plain JS over the Map, which is
 * fine for the handful of rows local development produces.
 * ------------------------------------------------------------------ */

/** Every live booking across every date currently in memory. */
function allBookings() {
  const out = [];
  for (const list of byDate.values()) {
    for (const b of list) if (!b.cancelled) out.push(b);
  }
  return out;
}

export function listBookings({ search = '', from = null, to = null, kind = 'all',
                               paid = 'all', limit = 100, offset = 0 } = {}) {
  const term = String(search || '').trim().toLowerCase();
  let rows = allBookings()
    .filter((b) => (from ? b.dateISO >= from : true))
    .filter((b) => (to ? b.dateISO <= to : true))
    .filter((b) => (kind === 'all' ? true : b.kind === kind))
    .filter((b) => (!term ? true : [b.name, b.email, b.phone, b.code]
      .some((f) => String(f || '').toLowerCase().includes(term))))
    .map((b) => ({ ...b, paidCents: b.paymentIntentId || b.checkoutSessionId ? b.totalCents : 0 }));

  if (paid === 'paid') rows = rows.filter((b) => b.paidCents >= b.totalCents);
  if (paid === 'due') rows = rows.filter((b) => b.paidCents < b.totalCents);

  rows.sort((a, b) => (b.dateISO === a.dateISO ? b.startMin - a.startMin : (a.dateISO < b.dateISO ? 1 : -1)));
  return { rows: rows.slice(offset, offset + limit), total: rows.length };
}

export function listCustomers({ search = '', limit = 100, offset = 0 } = {}) {
  const byPhone = new Map();
  for (const b of allBookings()) {
    if (b.kind === 'block') continue;
    const key = String(b.phone || '').replace(/\D/g, '');
    if (!key) continue;
    if (!byPhone.has(key)) {
      byPhone.set(key, {
        name: b.name || '(no name)', phone: b.phone, email: b.email || '',
        bookings: 0, guestsBrought: 0, paidCents: 0,
        firstVisit: b.dateISO, lastVisit: b.dateISO,
      });
    }
    const c = byPhone.get(key);
    c.bookings += 1;
    c.guestsBrought += b.players;
    c.paidCents += b.totalCents;
    if (b.dateISO < c.firstVisit) c.firstVisit = b.dateISO;
    if (b.dateISO > c.lastVisit) c.lastVisit = b.dateISO;
    if (b.email) c.email = b.email;
  }

  const term = String(search || '').trim().toLowerCase();
  let rows = [...byPhone.values()]
    .filter((c) => (!term ? true : [c.name, c.email, c.phone]
      .some((f) => String(f || '').toLowerCase().includes(term))));
  rows.sort((a, b) => b.paidCents - a.paidCents);
  return { rows: rows.slice(offset, offset + limit), total: rows.length };
}

// Notes have nowhere durable to live without a database, so they last as long as the
// process does. The portal says so rather than pretending otherwise.
const notes = [];
let nextNoteId = 1;

export function listNotes() {
  return [...notes].sort((a, b) => (a.done === b.done ? (a.createdAt < b.createdAt ? 1 : -1) : (a.done ? 1 : -1)));
}

export function addNote({ body, author = '', kind = 'dev' }) {
  const text = String(body || '').trim();
  if (!text) return { ok: false, status: 400, error: 'Write something first.' };
  const note = { id: nextNoteId++, body: text, author: String(author || '').trim(), kind, done: false, createdAt: new Date().toISOString() };
  notes.push(note);
  return { ok: true, note };
}

export function setNoteDone(id, done) {
  const n = notes.find((x) => x.id === Number(id));
  if (!n) return { ok: false, status: 404, error: "We couldn't find that note." };
  n.done = !!done;
  return { ok: true };
}

export function deleteNote(id) {
  const i = notes.findIndex((x) => x.id === Number(id));
  if (i === -1) return { ok: false, status: 404, error: "We couldn't find that note." };
  notes.splice(i, 1);
  return { ok: true };
}

export function listParties({ from = null, to = null, limit = 200 } = {}) {
  const rows = allBookings()
    .filter((b) => b.kind === 'party')
    .filter((b) => (from ? b.dateISO >= from : true))
    .filter((b) => (to ? b.dateISO <= to : true))
    .sort((a, b) => (a.dateISO === b.dateISO ? a.startMin - b.startMin : (a.dateISO < b.dateISO ? -1 : 1)));
  return { rows: rows.slice(0, limit) };
}

export function reportsFor({ from, to }) {
  const all = allBookings();
  const dates = [];
  for (let d = parseISO(from); isoDate(d) <= to; d.setDate(d.getDate() + 1)) dates.push(isoDate(d));
  return buildReports({
    bySession: all.filter((b) => b.dateISO >= from && b.dateISO <= to),
    bySale: all.filter((b) => (b.createdAt || '').slice(0, 10) >= from && (b.createdAt || '').slice(0, 10) <= to),
    dates,
    sessionsOn: sessionsFor,
  });
}

// Waivers, in memory. Legal records that vanish on restart are useless, which is exactly
// why the real store is Postgres — this exists so local work does not crash.
const waivers = [];
let nextWaiverId = 1;

export function addWaiver(input) {
  const w = { id: nextWaiverId++, ...input, agreed: true, signedAt: new Date().toISOString() };
  waivers.push(w);
  return { ok: true, waiver: w };
}

export function listWaivers({ search = '', limit = 100, offset = 0 } = {}) {
  const term = String(search || '').trim().toLowerCase();
  const rows = waivers
    .filter((w) => (!term ? true : [w.firstName, w.lastName, w.email]
      .some((f) => String(f || '').toLowerCase().includes(term))))
    .sort((a, b) => (a.signedAt < b.signedAt ? 1 : -1));
  return { rows: rows.slice(offset, offset + limit), total: rows.length };
}
