// Booking store backed by Postgres (Supabase).
//
// Same surface as lib/demo-store.js, but async and durable. The views it returns are built
// by lib/booking-views.js — the identical code the in-memory store uses — so seat
// arithmetic and room allocation cannot drift between the two.
//
// Writes go through the SQL functions in supabase/migrations/0002. Those do the capacity
// check and the insert inside one transaction behind a per-date lock, which is what stops
// two customers taking the same last seat. The checks in this file run first so the
// customer gets a useful message; the SQL is the backstop that makes overselling
// impossible rather than unlikely.

import { getSupabase } from './supabase.js';
import {
  ARENA, sessionsFor, sessionSpan, parseISO, isPastSession,
  partyRoomSlotsFor, heldGamesFor, roomFit, splitsForLaserTag, isBookableOnline,
} from './arena.js';
import {
  availabilityFrom, gameSheetFrom, partySlotsFrom, statsFrom,
  analyticsDates, analyticsFrom,
} from './booking-views.js';

const db = () => getSupabase();

/* ------------------------------------------------------------------ *
 * Row mapping
 *
 * Postgres is snake_case, the domain model is camelCase. Converting in one place keeps
 * column names out of the rest of the app.
 * ------------------------------------------------------------------ */

const SELECT = `
  id, code, date, start_min, games, players, kind, name, email, phone,
  total_cents, is_group, note, payment_intent_id, checkout_session_id,
  cancelled, created_at,
  party_details ( slot_start, slot_end, age, age_override, rooms, positions,
                  split_groups, package_id, package_name, pizzas, add_ons,
                  deposit_cents, deposit_state )`;

function toBooking(row) {
  if (!row) return null;
  const p = Array.isArray(row.party_details) ? row.party_details[0] : row.party_details;
  const b = {
    id: row.id,
    code: row.code,
    dateISO: row.date,
    startMin: row.start_min,
    games: row.games,
    players: row.players,
    kind: row.kind,
    name: row.name || '',
    email: row.email || '',
    phone: row.phone || '',
    totalCents: row.total_cents,
    group: row.is_group,
    note: row.note || '',
    paymentIntentId: row.payment_intent_id,
    checkoutSessionId: row.checkout_session_id,
    cancelled: row.cancelled,
    createdAt: row.created_at,
  };
  if (p) Object.assign(b, {
    slotStart: p.slot_start,
    slotEnd: p.slot_end,
    age: p.age,
    ageOverride: p.age_override,
    rooms: p.rooms || [],
    positions: p.positions,
    splitGroups: p.split_groups,
    packageId: p.package_id,
    packageName: p.package_name,
    pizzas: p.pizzas,
    addOns: p.add_ons || [],
    depositCents: p.deposit_cents,
    depositState: p.deposit_state,
  });
  return b;
}

/** Anything the database refuses comes back as a message a customer can act on. */
function storeError(error, fallback) {
  const m = String(error?.message || '');
  if (/session_full/.test(m)) {
    return { ok: false, status: 409, error: 'That game just filled up. Please pick another time — the grid has been refreshed.' };
  }
  if (/session_blocked/.test(m)) {
    return { ok: false, status: 409, error: 'That game time is closed to bookings. Please pick another time.' };
  }
  if (/slot_full/.test(m)) {
    return { ok: false, status: 409, error: 'That party slot was taken while you were booking. Please pick another time.' };
  }
  if (/duplicate key|unique constraint/i.test(m)) {
    return { ok: false, status: 409, error: 'That booking already exists.' };
  }
  console.error('store:', m);
  return { ok: false, status: 502, error: fallback };
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export async function bookingsFor(dateISO) {
  const { data, error } = await db()
    .from('bookings').select(SELECT).eq('date', dateISO).eq('cancelled', false);
  if (error) { console.error('bookingsFor:', error.message); return []; }
  return data.map(toBooking);
}

/** Bookings across a date range, as a Map — one query instead of N for analytics. */
async function bookingsBetween(fromISO, toISO) {
  const { data, error } = await db()
    .from('bookings').select(SELECT)
    .gte('date', fromISO).lte('date', toISO).eq('cancelled', false);
  const byDate = new Map();
  if (error) { console.error('bookingsBetween:', error.message); return byDate; }
  for (const row of data) {
    const b = toBooking(row);
    if (!byDate.has(b.dateISO)) byDate.set(b.dateISO, []);
    byDate.get(b.dateISO).push(b);
  }
  return byDate;
}

/** Staff overrides to the standing held-game pattern, as a Map of startMin -> state. */
async function overridesFor(dateISO) {
  const { data, error } = await db()
    .from('hold_overrides').select('start_min, state').eq('date', dateISO);
  const out = new Map();
  if (error) { console.error('overridesFor:', error.message); return out; }
  for (const r of data) out.set(r.start_min, r.state);
  return out;
}

/** A synchronous held-check for one date, for the pure views to use. */
function heldChecker(dateISO, overrides) {
  const standing = heldGamesFor(dateISO);
  return (startMin) => {
    const o = overrides.get(startMin);
    if (o === 'released') return false;
    if (o === 'held') return true;
    return standing.includes(startMin);
  };
}

export async function isHeld(dateISO, startMin) {
  return heldChecker(dateISO, await overridesFor(dateISO))(Number(startMin));
}

export async function availabilityFor(dateISO) {
  const [bookings, overrides] = await Promise.all([bookingsFor(dateISO), overridesFor(dateISO)]);
  return availabilityFrom(bookings, dateISO, heldChecker(dateISO, overrides));
}

export async function gameSheetFor(dateISO) {
  const [bookings, overrides] = await Promise.all([bookingsFor(dateISO), overridesFor(dateISO)]);
  return gameSheetFrom(bookings, dateISO, heldChecker(dateISO, overrides), heldGamesFor(dateISO));
}

export async function partySlotsFor(dateISO, age = null, guests = null) {
  return partySlotsFrom(await bookingsFor(dateISO), dateISO, age, guests);
}

export async function statsFor(dateISO) {
  const [bookings, availability] = await Promise.all([bookingsFor(dateISO), availabilityFor(dateISO)]);
  return statsFrom(bookings, availability);
}

export async function analyticsFor(dateISO, days = 7) {
  const dates = analyticsDates(dateISO, days);
  if (!dates.length) return { days: [], totals: null };

  // One query for the whole window, and one for its overrides.
  const byDate = await bookingsBetween(dates[0], dates[dates.length - 1]);
  const overridesByDate = new Map(
    await Promise.all(dates.map(async (d) => [d, await overridesFor(d)])));

  const bookingsOn = (iso) => byDate.get(iso) || [];
  const availabilityOn = (iso) =>
    availabilityFrom(bookingsOn(iso), iso, heldChecker(iso, overridesByDate.get(iso) || new Map()));

  return analyticsFrom(dates, bookingsOn, availabilityOn);
}

export async function findByCode(code) {
  const want = String(code || '').trim().toUpperCase();
  if (!want) return null;
  const { data, error } = await db()
    .from('bookings').select(SELECT).eq('code', want).eq('cancelled', false).maybeSingle();
  if (error) { console.error('findByCode:', error.message); return null; }
  return toBooking(data);
}

/**
 * The booking created for a Stripe Checkout session, if any.
 * This is what stops a refresh of the confirmation page booking — and charging — twice.
 * Cancelled bookings still count: the payment was made, so re-confirming must not re-book.
 */
export async function findByCheckoutSession(sessionId) {
  if (!sessionId) return null;
  const { data, error } = await db()
    .from('bookings').select(SELECT).eq('checkout_session_id', sessionId).maybeSingle();
  if (error) { console.error('findByCheckoutSession:', error.message); return null; }
  return toBooking(data);
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1 — read aloud on the phone

/** A booking code. Crypto RNG, not Math.random: a guessable code reads someone else's booking. */
function codeFor() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `LT-${out}`;
}

export async function addBooking(input) {
  const { dateISO, startMin, games, players, kind = 'online',
          allowPast = false, allowHeld = false } = input;
  const min = Number(startMin);

  if (!sessionsFor(dateISO).includes(min)) {
    return { ok: false, status: 400, error: "That game time isn't on the schedule for this day. Pick another time." };
  }
  if (!allowPast && isPastSession(dateISO, min)) {
    return { ok: false, status: 400, error: 'That game has already started. Please pick a later game time.' };
  }
  if (!allowPast && !isBookableOnline(dateISO, min)) {
    return {
      ok: false, status: 400,
      error: `Online booking closes ${ARENA.onlineCutoffMin} minutes before a game starts, so we can keep seats for walk-ins. Please pick a later game time, or call us at ${ARENA.phone} and we'll get you in.`,
    };
  }
  if (!allowHeld) {
    const held = heldChecker(dateISO, await overridesFor(dateISO));
    const clash = sessionSpan(dateISO, min, Number(games)).find((m) => held(m));
    if (clash != null) {
      return { ok: false, status: 409, error: 'That game time is reserved for birthday parties. Please pick another time, or call us — it may open up.' };
    }
  }

  const { data, error } = await db().rpc('book_session', {
    p_code: input.code || codeFor(),
    p_date: dateISO,
    p_start_min: min,
    p_games: Number(games),
    p_players: Number(players),
    p_kind: kind,
    p_capacity: ARENA.capacity,
    p_step_min: ARENA.sessionStepMin,
    p_name: input.name || '',
    p_email: input.email || '',
    p_phone: input.phone || '',
    p_total_cents: Number(input.totalCents) || 0,
    p_is_group: !!input.group,
    p_note: input.note || '',
    p_payment_intent_id: input.paymentIntentId || null,
    p_checkout_session_id: input.checkoutSessionId || null,
  });

  if (error) return storeError(error, "We couldn't save that booking. Please try again, or call us.");
  return { ok: true, booking: toBooking(data) };
}

export async function addParty(input) {
  const { dateISO, slotStart, age, guests, override = false } = input;

  const slot = partyRoomSlotsFor(dateISO).find((s) => s.start === Number(slotStart));
  if (!slot) {
    return { ok: false, status: 400, error: "That party time isn't one we run on this day. Please pick another slot." };
  }

  const board = (await partySlotsFor(dateISO, age, guests)).find((s) => s.start === slot.start);
  if (board.spotsLeft === 0 || !board.sizeFits) {
    const full = (await partySlotsFor(dateISO, null, guests)).find((s) => s.start === slot.start);
    return { ok: false, status: 409, error: full.reason };
  }
  if (!board.ageFits && !override) {
    return { ok: false, status: 409, error: board.reason };
  }

  const fit = roomFit(slot, guests, board.roomsFree);
  const games = board.games;

  const { data, error } = await db().rpc('book_party', {
    p_code: codeFor(),
    p_date: dateISO,
    p_slot_start: slot.start,
    p_slot_end: slot.end,
    p_slot_capacity: slot.rooms.length,
    p_positions: fit.positions,
    p_rooms: fit.rooms,
    p_start_min: games.length ? games[0] : slot.start,
    p_games: Math.max(1, games.length),
    p_guests: Number(guests),
    p_age: age == null ? null : Number(age),
    p_age_override: !board.ageFits,
    p_split_groups: splitsForLaserTag(guests) ? 2 : 1,
    p_name: input.name || '',
    p_email: input.email || '',
    p_phone: input.phone || '',
    p_package_id: input.packageId || null,
    p_package_name: input.packageName || null,
    p_pizzas: input.pizzas ?? null,
    p_add_ons: input.addOns || [],
    p_total_cents: Number(input.totalCents) || 0,
    p_deposit_cents: ARENA.partyDepositCents,
    p_note: input.note || '',
  });

  if (error) return storeError(error, "We couldn't save that party. Please try again, or call us.");

  // book_party returns the bookings row only. Re-read with the join so the caller gets the
  // slot, rooms and package back — the confirmation message is built from those fields.
  return { ok: true, booking: await byId(data.id) };
}

/** One booking with its party detail attached. */
async function byId(id) {
  const { data, error } = await db().from('bookings').select(SELECT).eq('id', id).maybeSingle();
  if (error) { console.error('byId:', error.message); return null; }
  return toBooking(data);
}

export async function blockSession(dateISO, startMin, note) {
  if (!sessionsFor(dateISO).includes(Number(startMin))) {
    return { ok: false, status: 400, error: "That game time isn't on the schedule for this day." };
  }
  const { data, error } = await db().from('bookings').insert({
    code: `BLK-${Date.now().toString(36).toUpperCase()}`,
    date: dateISO,
    start_min: Number(startMin),
    games: 1,
    players: 0,
    kind: 'block',
    name: note || 'Blocked',
    note: note || '',
  }).select(SELECT).single();

  if (error) return storeError(error, "We couldn't close that game time.");
  return { ok: true, booking: toBooking(data) };
}

export async function cancelBooking(id) {
  const { data, error } = await db()
    .from('bookings').update({ cancelled: true }).eq('id', Number(id)).select(SELECT).maybeSingle();
  if (error) return storeError(error, "We couldn't cancel that booking.");
  if (!data) return { ok: false, status: 404, error: "We couldn't find that booking. Check the code and try again." };
  return { ok: true, booking: toBooking(data) };
}

/* ------------------------------------------------------------------ *
 * Held-game overrides (staff)
 * ------------------------------------------------------------------ */

async function setOverride(dateISO, startMin, state) {
  const m = Number(startMin);
  if (!sessionsFor(dateISO).includes(m)) {
    return { ok: false, status: 400, error: "That game time isn't on the schedule for this day." };
  }
  const { error } = await db()
    .from('hold_overrides')
    .upsert({ date: dateISO, start_min: m, state }, { onConflict: 'date,start_min' });
  if (error) return storeError(error, "We couldn't change that game time.");
  return { ok: true, held: state === 'held' };
}

export const releaseHeldGame = (dateISO, startMin) => setOverride(dateISO, startMin, 'released');
export const holdGame        = (dateISO, startMin) => setOverride(dateISO, startMin, 'held');

/* ------------------------------------------------------------------ *
 * Manager portal
 * ------------------------------------------------------------------ */

/**
 * Booking list for the portal, with search and filters.
 *
 * `search` matches name, email, phone or booking code. Paged, because a year of trading is
 * thousands of rows and the portal must not try to render them all.
 */
export async function listBookings({ search = '', from = null, to = null, kind = 'all',
                                     paid = 'all', limit = 100, offset = 0 } = {}) {
  let q = db().from('bookings').select(SELECT, { count: 'exact' }).eq('cancelled', false);

  if (from) q = q.gte('date', from);
  if (to) q = q.lte('date', to);
  if (kind !== 'all') q = q.eq('kind', kind);

  const term = String(search || '').trim();
  if (term) {
    const like = `%${term.replace(/[%_,]/g, '')}%`;
    q = q.or(`name.ilike.${like},email.ilike.${like},phone.ilike.${like},code.ilike.${like}`);
  }

  q = q.order('date', { ascending: false }).order('start_min', { ascending: false })
       .range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) { console.error('listBookings:', error.message); return { rows: [], total: 0 }; }

  let rows = data.map(toBooking);
  // Payment state is derived, not stored: a booking is paid when Stripe confirmed it.
  rows = rows.map((b) => ({ ...b, paidCents: b.paymentIntentId || b.checkoutSessionId ? b.totalCents : 0 }));
  if (paid === 'paid') rows = rows.filter((b) => b.paidCents >= b.totalCents);
  if (paid === 'due') rows = rows.filter((b) => b.paidCents < b.totalCents);

  return { rows, total: count ?? rows.length };
}

/** Customers, aggregated from bookings by phone number. */
export async function listCustomers({ search = '', limit = 100, offset = 0 } = {}) {
  let q = db().from('customers').select('*', { count: 'exact' });
  const term = String(search || '').trim();
  if (term) {
    const like = `%${term.replace(/[%_,]/g, '')}%`;
    q = q.or(`name.ilike.${like},email.ilike.${like},phone.ilike.${like}`);
  }
  q = q.order('paid_cents', { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) { console.error('listCustomers:', error.message); return { rows: [], total: 0 }; }

  return {
    rows: data.map((r) => ({
      name: r.name || '(no name)',
      phone: r.phone || '',
      email: r.email || '',
      bookings: Number(r.bookings) || 0,
      guestsBrought: Number(r.guests_brought) || 0,
      paidCents: Number(r.paid_cents) || 0,
      firstVisit: r.first_visit,
      lastVisit: r.last_visit,
    })),
    total: count ?? data.length,
  };
}

export async function listNotes() {
  const { data, error } = await db()
    .from('notes').select('*').order('done').order('created_at', { ascending: false });
  if (error) { console.error('listNotes:', error.message); return []; }
  return data.map((n) => ({
    id: n.id, body: n.body, author: n.author, kind: n.kind, done: n.done, createdAt: n.created_at,
  }));
}

export async function addNote({ body, author = '', kind = 'dev' }) {
  const text = String(body || '').trim();
  if (!text) return { ok: false, status: 400, error: 'Write something first.' };
  const { data, error } = await db()
    .from('notes').insert({ body: text, author: String(author || '').trim(), kind })
    .select('*').single();
  if (error) return storeError(error, "We couldn't save that note.");
  return { ok: true, note: { id: data.id, body: data.body, author: data.author, kind: data.kind, done: data.done, createdAt: data.created_at } };
}

export async function setNoteDone(id, done) {
  const { error } = await db().from('notes').update({ done: !!done }).eq('id', Number(id));
  if (error) return storeError(error, "We couldn't update that note.");
  return { ok: true };
}

export async function deleteNote(id) {
  const { error } = await db().from('notes').delete().eq('id', Number(id));
  if (error) return storeError(error, "We couldn't delete that note.");
  return { ok: true };
}
