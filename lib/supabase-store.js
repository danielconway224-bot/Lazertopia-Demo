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

import { randomUUID } from 'node:crypto';
import { getSupabase } from './supabase.js';
import {
  ARENA, sessionsFor, sessionSpan, parseISO, isoDate, isPastSession,
  partyRoomSlotsFor, heldGamesFor, heldGamesFromSlots, applySlotOverrides,
  roomFit, splitsForLaserTag, isBookableOnline,
} from './arena.js';
import {
  availabilityFrom, gameSheetFrom, partySlotsFrom, statsFrom,
  analyticsDates, analyticsFrom, buildReports,
} from './booking-views.js';

const db = () => getSupabase();

/* ------------------------------------------------------------------ *
 * Row mapping
 *
 * Postgres is snake_case, the domain model is camelCase. Converting in one place keeps
 * column names out of the rest of the app.
 * ------------------------------------------------------------------ */

const BASE_PARTY_COLS = `slot_start, slot_end, age, age_override, rooms, positions,
                  split_groups, package_id, package_name, pizzas, add_ons,
                  deposit_cents, deposit_state`;

/**
 * Whether party_details carries the columns migration 0007 adds.
 *
 * PostgREST fails the WHOLE query when one selected column is missing, so naming a column
 * the database has not got yet does not degrade a read — it empties it. Asking for `food`
 * before 0007 was run therefore returned zero bookings for every date, on every page,
 * while the rows sat there perfectly intact. An empty arena is a far worse failure than a
 * missing field, so the select adapts instead.
 *
 * null = not yet known.
 */
let hasFoodColumns = null;

const selectFor = () => `
  id, code, date, start_min, games, players, kind, name, email, phone,
  total_cents, is_group, note, payment_intent_id, checkout_session_id,
  cancelled, created_at,
  party_details ( ${BASE_PARTY_COLS}${hasFoodColumns === false ? '' : ', food, food_cents'} )`;

const missingColumn = (e) => /column .* does not exist|does not exist/i.test(String(e?.message || ''));

/**
 * Run a select, and if it fails only because the schema is behind, drop the newer columns
 * and run it once more. The downgrade is remembered, so this costs one wasted query per
 * process rather than one per request.
 */
async function withSelect(run) {
  let res = await run(selectFor());
  if (res.error && missingColumn(res.error) && hasFoodColumns !== false) {
    hasFoodColumns = false;
    console.warn('supabase: party_details.food missing — run migration 0007. Falling back.');
    res = await run(selectFor());
  } else if (!res.error && hasFoodColumns === null) {
    hasFoodColumns = true;
  }
  return res;
}

// Kept for the handful of places that build their own query text.
const SELECT = `
  id, code, date, start_min, games, players, kind, name, email, phone,
  total_cents, is_group, note, payment_intent_id, checkout_session_id,
  cancelled, created_at,
  party_details ( ${BASE_PARTY_COLS} )`;

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
    food: p.food || [],
    foodCents: p.food_cents || 0,
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
  // A changed function signature looks like a missing function to PostgREST. Say which
  // migration is behind rather than "could not save", which sends people hunting for a
  // data problem that is not there.
  if (/could not find the function|schema cache|does not exist/i.test(m)) {
    return {
      ok: false, status: 503,
      error: 'The database is behind the code — run the newest file in supabase/migrations/ (or supabase/RUN_ALL.sql) in the SQL Editor.',
    };
  }
  console.error('store:', m);
  return { ok: false, status: 502, error: fallback };
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export async function bookingsFor(dateISO) {
  const { data, error } = await withSelect((sel) => db()
    .from('bookings').select(sel).eq('date', dateISO).eq('cancelled', false));
  if (error) { console.error('bookingsFor:', error.message); return []; }
  return data.map(toBooking);
}

/** Bookings across a date range, as a Map — one query instead of N for analytics. */
async function bookingsBetween(fromISO, toISO) {
  const { data, error } = await withSelect((sel) => db()
    .from('bookings').select(sel)
    .gte('date', fromISO).lte('date', toISO).eq('cancelled', false));
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

/**
 * The party slots in force on a date: the standing weekly schedule with any manager edits
 * for that date applied on top.
 */
export async function slotsFor(dateISO) {
  const { data, error } = await db()
    .from('party_slot_overrides').select('*').eq('date', dateISO);
  if (error) {
    // Not installed yet is not a reason to break the day — fall back to the schedule.
    if (!/schema cache|does not exist/i.test(error.message)) console.error('slotsFor:', error.message);
    return partyRoomSlotsFor(dateISO);
  }
  return applySlotOverrides(partyRoomSlotsFor(dateISO), data.map((r) => ({
    slotStart: r.slot_start, slotEnd: r.slot_end,
    rooms: r.rooms, combined: r.combined, games: r.games, removed: r.removed,
  })));
}

/** Replace a date's party schedule. Pass the full list; anything absent is removed. */
export async function saveSlots(dateISO, slots) {
  const standing = partyRoomSlotsFor(dateISO);
  const rows = slots.map((s) => ({
    date: dateISO,
    slot_start: Number(s.start),
    slot_end: Number(s.end),
    rooms: (s.rooms || []).map(Number),
    combined: Number(s.combined) || 0,
    games: (s.games || []).map(Number),
    removed: false,
  }));
  // A standing slot the manager deleted needs a tombstone, or it comes straight back.
  for (const std of standing) {
    if (!slots.some((s) => Number(s.start) === std.start)) {
      rows.push({ date: dateISO, slot_start: std.start, slot_end: std.end,
                  rooms: [], combined: 0, games: [], removed: true });
    }
  }

  const notInstalled = (e) => /schema cache|does not exist/i.test(String(e?.message || ''));
  const setupError = {
    ok: false, status: 503,
    error: 'Editing the party schedule needs supabase/migrations/0004_party_slot_overrides.sql run in the SQL Editor.',
  };

  const del = await db().from('party_slot_overrides').delete().eq('date', dateISO);
  if (del.error) {
    if (notInstalled(del.error)) return setupError;
    return storeError(del.error, "We couldn't save that schedule.");
  }
  if (rows.length) {
    const { error } = await db().from('party_slot_overrides').insert(rows);
    if (error) {
      if (notInstalled(error)) return setupError;
      return storeError(error, "We couldn't save that schedule.");
    }
  }
  return { ok: true };
}

/** Put a date back on the standing weekly schedule. */
export async function resetSlots(dateISO) {
  const { error } = await db().from('party_slot_overrides').delete().eq('date', dateISO);
  // Nothing to reset if the table was never installed — the day is already on the standard
  // schedule, which is exactly what reset means.
  if (error && !/schema cache|does not exist/i.test(error.message)) {
    return storeError(error, "We couldn't reset that day.");
  }
  return { ok: true };
}

/** A synchronous held-check for one date, for the pure views to use. */
function heldChecker(dateISO, overrides, slots = null) {
  const standing = slots ? heldGamesFromSlots(slots, dateISO) : heldGamesFor(dateISO);
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
  const [bookings, overrides, slots] = await Promise.all(
    [bookingsFor(dateISO), overridesFor(dateISO), slotsFor(dateISO)]);
  return availabilityFrom(bookings, dateISO, heldChecker(dateISO, overrides, slots), slots);
}

export async function gameSheetFor(dateISO) {
  const [bookings, overrides, slots] = await Promise.all(
    [bookingsFor(dateISO), overridesFor(dateISO), slotsFor(dateISO)]);
  return gameSheetFrom(bookings, dateISO, heldChecker(dateISO, overrides, slots),
    heldGamesFromSlots(slots, dateISO), slots);
}

export async function partySlotsFor(dateISO, age = null, guests = null) {
  const [bookings, slots] = await Promise.all([bookingsFor(dateISO), slotsFor(dateISO)]);
  return partySlotsFrom(bookings, dateISO, age, guests, slots);
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
  const { data, error } = await withSelect((sel) => db()
    .from('bookings').select(sel).eq('code', want).eq('cancelled', false).maybeSingle());
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
  const { data, error } = await withSelect((sel) => db()
    .from('bookings').select(sel).eq('checkout_session_id', sessionId).maybeSingle());
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

  const slot = (await slotsFor(dateISO)).find((s) => s.start === Number(slotStart));
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
  const games = slot.games;

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
    p_deposit_state: input.depositState || 'due',
    p_payment_intent_id: input.paymentIntentId || null,
    p_checkout_session_id: input.checkoutSessionId || null,
    ...(hasFoodColumns === false ? {} : {
      p_food: input.food || [],
      p_food_cents: Number(input.foodCents) || 0,
    }),
  });

  if (error) return storeError(error, "We couldn't save that party. Please try again, or call us.");

  // book_party returns the bookings row only. Re-read with the join so the caller gets the
  // slot, rooms and package back — the confirmation message is built from those fields.
  return { ok: true, booking: await byId(data.id) };
}

/** One booking with its party detail attached. */
async function byId(id) {
  const { data, error } = await withSelect((sel) =>
    db().from('bookings').select(sel).eq('id', id).maybeSingle());
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
  let q = db().from('bookings').select(selectFor(), { count: 'exact' }).eq('cancelled', false);

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
  if (error) {
    console.error('listCustomers:', error.message);
    // An empty list and a missing table look identical on screen, and one of them is a
    // setup problem the operator can actually fix. Say which.
    if (/schema cache|does not exist/i.test(error.message)) {
      return { rows: [], total: 0, error: 'The customers view is not installed yet — run supabase/migrations/0003_portal.sql in the SQL Editor.' };
    }
    return { rows: [], total: 0, error: error.message };
  }

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
  if (error) {
    console.error('listNotes:', error.message);
    if (/schema cache|does not exist/i.test(error.message)) {
      const e = new Error('The notes table is not installed yet — run supabase/migrations/0003_portal.sql in the SQL Editor.');
      e.setup = true;
      throw e;
    }
    return [];
  }
  const images = await imagesForNotes(data.map((n) => n.id));
  return data.map((n) => ({
    id: n.id, body: n.body, author: n.author, kind: n.kind, done: n.done, createdAt: n.created_at,
    images: images[n.id] || [],
  }));
}

export async function addNote({ body, author = '', kind = 'dev' }) {
  const text = String(body || '').trim();
  if (!text) return { ok: false, status: 400, error: 'Write something first.' };
  const { data, error } = await db()
    .from('notes').insert({ body: text, author: String(author || '').trim(), kind })
    .select('*').single();
  if (error) {
    if (/schema cache|does not exist/i.test(error.message)) {
      return { ok: false, status: 503, error: 'The notes table is not installed yet — run supabase/migrations/0003_portal.sql in the SQL Editor.' };
    }
    return storeError(error, "We couldn't save that note.");
  }
  return { ok: true, note: { id: data.id, body: data.body, author: data.author, kind: data.kind, done: data.done, createdAt: data.created_at } };
}

export async function setNoteDone(id, done) {
  const { error } = await db().from('notes').update({ done: !!done }).eq('id', Number(id));
  if (error) return storeError(error, "We couldn't update that note.");
  return { ok: true };
}

export async function deleteNote(id) {
  // The foreign key cascade removes the image ROWS, but nothing in Postgres knows about
  // the files in the bucket. Collect the paths before the delete or those bytes stay
  // there forever with no row left pointing at them.
  const paths = await noteImagePaths(id);
  const { error } = await db().from('notes').delete().eq('id', Number(id));
  if (error) return storeError(error, "We couldn't delete that note.");
  if (paths.length) await db().storage.from(NOTE_BUCKET).remove(paths);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Note images
 *
 * The bytes live in Supabase Storage; note_images only records where. See migration 0008
 * for why the bucket is private rather than public.
 * ------------------------------------------------------------------ */

const NOTE_BUCKET = 'note-images';

/** What the browser is allowed to attach, and the extension each is stored under. */
const IMAGE_TYPES = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
};

const NEEDS_0008 = 'Image attachments are not set up yet — run supabase/migrations/0008_note_images.sql in the SQL Editor.';

/** null = not yet known; false = migration 0008 has not been run on this database. */
let hasNoteImages = null;

const missing = (error) => /schema cache|does not exist|not found/i.test(error.message || '');

/**
 * Images for a set of notes, keyed by note id.
 *
 * Deliberately a SEPARATE query rather than a join inside listNotes. PostgREST fails the
 * WHOLE query when one selected relation is missing, so joining this before 0008 has been
 * run would empty the Notes tab entirely rather than merely drop the pictures — the same
 * trap that once returned zero bookings for every date. Notes without images is a small
 * disappointment; a blank Notes tab is a bug report.
 */
async function imagesForNotes(noteIds) {
  if (!noteIds.length || hasNoteImages === false) return {};
  const { data, error } = await db()
    .from('note_images').select('id, note_id, mime, width, height')
    .in('note_id', noteIds).order('created_at');
  if (error) {
    if (missing(error)) {
      if (hasNoteImages !== false) console.warn('supabase: note_images missing — run migration 0008. Notes will show without images.');
      hasNoteImages = false;
    } else {
      console.error('imagesForNotes:', error.message);
    }
    return {};
  }
  hasNoteImages = true;
  const out = {};
  for (const r of data) (out[r.note_id] ||= []).push({ id: r.id, mime: r.mime, width: r.width, height: r.height });
  return out;
}

/** Bucket paths belonging to a note, so its files can be removed alongside it. */
async function noteImagePaths(noteId) {
  const { data, error } = await db().from('note_images').select('path').eq('note_id', Number(noteId));
  if (error || !data) return [];
  return data.map((r) => r.path);
}

/**
 * Store one image against a note.
 *
 * The file goes up first and the row second. That order matters: a row pointing at a file
 * that isn't there would render as a broken image forever, whereas a file with no row is
 * merely wasted space — and the catch below removes it anyway.
 */
export async function addNoteImage(noteId, bytes, { mime, width = null, height = null }) {
  const id = Number(noteId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 400, error: 'That note no longer exists.' };
  const ext = IMAGE_TYPES[mime];
  if (!ext) return { ok: false, status: 415, error: 'That file is not an image we can store.' };

  const path = `${id}/${randomUUID()}.${ext}`;
  const up = await db().storage.from(NOTE_BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
  if (up.error) {
    if (/bucket.*not found/i.test(up.error.message)) return { ok: false, status: 503, error: NEEDS_0008 };
    console.error('addNoteImage upload:', up.error.message);
    return { ok: false, status: 502, error: "We couldn't store that image. Try again in a moment." };
  }

  const { data, error } = await db().from('note_images')
    .insert({ note_id: id, path, mime, bytes: bytes.length, width, height })
    .select('id, mime, width, height').single();
  if (error) {
    // Nothing references the file now, so don't leave it behind.
    await db().storage.from(NOTE_BUCKET).remove([path]);
    if (missing(error)) return { ok: false, status: 503, error: NEEDS_0008 };
    if (/foreign key/i.test(error.message)) return { ok: false, status: 404, error: 'That note no longer exists.' };
    return storeError(error, "We couldn't attach that image.");
  }
  hasNoteImages = true;
  return { ok: true, image: data };
}

/** The bytes of one image, or null if it has gone. Callers turn null into a 404. */
export async function readNoteImage(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const { data: row, error } = await db()
    .from('note_images').select('path, mime').eq('id', n).maybeSingle();
  if (error || !row) return null;
  const dl = await db().storage.from(NOTE_BUCKET).download(row.path);
  if (dl.error || !dl.data) return null;
  return { bytes: Buffer.from(await dl.data.arrayBuffer()), mime: row.mime };
}

export async function deleteNoteImage(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return { ok: true };
  const { data: row } = await db().from('note_images').select('path').eq('id', n).maybeSingle();
  if (!row) return { ok: true };                       // already gone; deleting twice is fine
  const { error } = await db().from('note_images').delete().eq('id', n);
  if (error) return storeError(error, "We couldn't remove that image.");
  await db().storage.from(NOTE_BUCKET).remove([row.path]);
  return { ok: true };
}

/**
 * Every party in a date range, with the full record.
 *
 * The desk needs all of it on the morning of: which rooms, how many pizzas, which add-ons,
 * whether the deposit is in, and whether the group is too big to play in one go.
 */
export async function listParties({ from = null, to = null, limit = 200 } = {}) {
  let q = db().from('bookings').select(selectFor()).eq('kind', 'party').eq('cancelled', false);
  if (from) q = q.gte('date', from);
  if (to) q = q.lte('date', to);
  q = q.order('date').order('start_min').limit(limit);

  const { data, error } = await q;
  if (error) { console.error('listParties:', error.message); return { rows: [], error: error.message }; }
  return { rows: data.map(toBooking) };
}


/** Everything the Reports tab needs for a window, in two queries. */
export async function reportsFor({ from, to }) {
  const [session, sale] = await Promise.all([
    db().from('bookings').select(SELECT).gte('date', from).lte('date', to).eq('cancelled', false),
    db().from('bookings').select(SELECT)
      .gte('created_at', `${from}T00:00:00Z`).lte('created_at', `${to}T23:59:59Z`)
      .eq('cancelled', false),
  ]);
  if (session.error || sale.error) {
    console.error('reportsFor:', (session.error || sale.error).message);
    return null;
  }
  const dates = [];
  for (let d = parseISO(from); isoDate(d) <= to; d.setDate(d.getDate() + 1)) dates.push(isoDate(d));

  return buildReports({
    bySession: session.data.map(toBooking),
    bySale: sale.data.map(toBooking),
    dates,
    sessionsOn: sessionsFor,
  });
}

/* ------------------------------------------------------------------ *
 * Waivers
 * ------------------------------------------------------------------ */

const WAIVER_SELECT = `
  id, first_name, last_name, email, date_of_birth, guardian_first, guardian_last,
  country, address1, address2, city, province, postal_code,
  heard_about, comments, agreed, terms_version, signed_at`;

function toWaiver(r) {
  if (!r) return null;
  return {
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    dateOfBirth: r.date_of_birth,
    guardianFirst: r.guardian_first || '',
    guardianLast: r.guardian_last || '',
    country: r.country,
    address1: r.address1,
    address2: r.address2,
    city: r.city,
    province: r.province,
    postalCode: r.postal_code,
    heardAbout: r.heard_about || [],
    comments: r.comments || '',
    agreed: r.agreed,
    termsVersion: r.terms_version,
    signedAt: r.signed_at,
  };
}

export async function addWaiver(input) {
  const { data, error } = await db().from('waivers').insert({
    first_name: input.firstName,
    last_name: input.lastName,
    email: input.email,
    date_of_birth: input.dateOfBirth,
    guardian_first: input.guardianFirst || '',
    guardian_last: input.guardianLast || '',
    country: input.country || 'Canada',
    address1: input.address1 || '',
    address2: input.address2 || '',
    city: input.city || '',
    province: input.province || '',
    postal_code: input.postalCode || '',
    heard_about: input.heardAbout || [],
    comments: input.comments || '',
    agreed: true,
    terms_version: input.termsVersion || '',
    signed_ip: input.ip || '',
    user_agent: input.userAgent || '',
  }).select(WAIVER_SELECT).single();

  if (error) {
    if (/schema cache|does not exist/i.test(error.message)) {
      return { ok: false, status: 503, error: 'Waivers need supabase/migrations/0006_waivers.sql run in the SQL Editor.' };
    }
    return storeError(error, "We couldn't save that waiver. Please try again, or sign at the desk.");
  }
  return { ok: true, waiver: toWaiver(data) };
}

/** Waivers, newest first. `search` matches name or email — how the desk actually looks. */
export async function listWaivers({ search = '', limit = 100, offset = 0 } = {}) {
  let q = db().from('waivers').select(WAIVER_SELECT, { count: 'exact' });
  const term = String(search || '').trim();
  if (term) {
    const like = `%${term.replace(/[%_,]/g, '')}%`;
    q = q.or(`first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like}`);
  }
  q = q.order('signed_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) {
    if (/schema cache|does not exist/i.test(error.message)) {
      return { rows: [], total: 0, error: 'Waivers need supabase/migrations/0006_waivers.sql run in the SQL Editor.' };
    }
    console.error('listWaivers:', error.message);
    return { rows: [], total: 0, error: error.message };
  }
  return { rows: data.map(toWaiver), total: count ?? data.length };
}
