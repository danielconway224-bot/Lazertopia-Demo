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
  ARENA, sessionsFor, sessionSpan, priceBooking, parseISO, isPastSession, isoDate, hoursFor,
  partyRoomSlotsFor, heldGamesFor, gamesInSlot, slotsOverlap, ageCompatible,
  roomFit, roomsFreeIn, maxGuestsIn, splitsForLaserTag, isBookableOnline,
} from './arena.js';

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
export function isHeld(dateISO, startMin) {
  const m = Number(startMin);
  const ov = overridesFor(dateISO);
  if (ov.released.has(m)) return false;      // staff opened it up
  if (ov.extraHeld.has(m)) return true;      // staff took it back
  return heldGamesFor(dateISO).includes(m);
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

/** Seats taken in one session, counting every booking whose span covers it. */
function seatsAt(bookings, dateISO, startMin) {
  let taken = 0;
  for (const b of bookings) {
    if (b.kind === 'block') {
      if (b.startMin === startMin) return ARENA.capacity;    // a block closes the whole game
      continue;
    }
    if (sessionSpan(dateISO, b.startMin, b.games).includes(startMin)) taken += b.players;
  }
  return Math.min(taken, ARENA.capacity);
}

/** Does a prospective booking fit, given a list of existing bookings? */
function fitsIn(bookings, dateISO, startMin, games, players) {
  const span = sessionSpan(dateISO, startMin, games);
  if (span.length < games) return false;                      // would run past closing
  return span.every((m) => ARENA.capacity - seatsAt(bookings, dateISO, m) >= players);
}

/**
 * Public availability for a date: one entry per game session.
 * Deliberately carries no customer data — this feeds the public booking page.
 */
export function availabilityFor(dateISO) {
  const bookings = bookingsFor(dateISO);
  return sessionsFor(dateISO).map((startMin) => {
    const taken = seatsAt(bookings, dateISO, startMin);
    const blocked = bookings.some((b) => b.kind === 'block' && b.startMin === startMin);
    return {
      startMin,
      taken,
      seatsLeft: Math.max(0, ARENA.capacity - taken),
      capacity: ARENA.capacity,
      blocked,
      held: isHeld(dateISO, startMin),
      past: isPastSession(dateISO, startMin),
      // Closed to the website but still sellable at the desk — shown, not hidden, so a
      // half-empty evening doesn't read as sold out.
      cutoff: !isPastSession(dateISO, startMin) && !isBookableOnline(dateISO, startMin),
    };
  });
}

/** The staff view: sessions with the groups in each one. */
export function gameSheetFor(dateISO) {
  const bookings = bookingsFor(dateISO);
  const defaultHeld = heldGamesFor(dateISO);
  return sessionsFor(dateISO).map((startMin) => {
    const span = bookings.filter((b) =>
      b.kind === 'block' ? b.startMin === startMin : sessionSpan(dateISO, b.startMin, b.games).includes(startMin));
    const taken = seatsAt(bookings, dateISO, startMin);
    return {
      startMin,
      taken,
      seatsLeft: Math.max(0, ARENA.capacity - taken),
      capacity: ARENA.capacity,
      blocked: span.some((b) => b.kind === 'block'),
      held: isHeld(dateISO, startMin),
      // Tells the desk whether this is one of the standing party times or one they held
      // back themselves, which changes whether "Release" reads as normal or as an undo.
      heldByDefault: defaultHeld.includes(startMin),
      past: isPastSession(dateISO, startMin),
      // `startsHere` distinguishes "this group's game begins now" from "they're mid-way
      // through a 3-game run", which is what the desk actually needs to see.
      bookings: span.map((b) => ({ ...b, startsHere: b.startMin === startMin })),
    };
  });
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

/** Live parties on a date, each carrying the room slot it occupies. */
function partiesOn(dateISO) {
  return bookingsFor(dateISO).filter((b) => b.kind === 'party' && b.slotStart != null);
}

/**
 * The party board for a date: every room slot with who's in it and whether it can take
 * another booking. `age` is optional — pass the enquiring party's age and each slot comes
 * back with whether that specific age fits.
 */
export function partySlotsFor(dateISO, age = null, guests = null) {
  const parties = partiesOn(dateISO);
  const slots = partyRoomSlotsFor(dateISO);

  return slots.map((slot) => {
    const inSlot = parties.filter((p) => p.slotStart === slot.start);
    // Parties in a *different* slot that still overlap in time are in the same rooms, so
    // they take those rooms out of this slot too.
    const overlapping = parties.filter((p) => p.slotStart !== slot.start
      && slotsOverlap(slot, { start: p.slotStart, end: p.slotEnd }));

    const free = roomsFreeIn(slot, [...inSlot, ...overlapping]);
    const maxGuests = maxGuestsIn(slot, free);

    // Sharing the room means matching ages; a mismatch closes the slot to that enquiry.
    const ages = inSlot.map((p) => p.age).filter((a) => a != null);
    const ageFits = age == null || ages.every((a) => ageCompatible(a, age));

    // When a guest count is supplied, answer the real question: can *this* party fit?
    const fit = guests == null ? null : roomFit(slot, guests, free);
    const sizeFits = fit == null || fit.ok;

    let reason = null;
    if (!free.length) {
      // Two different refusals: this slot's own bookings filled it, or parties in an
      // overlapping slot are using the rooms. The customer can act on the difference —
      // the second one means every nearby time is gone too.
      const takenHere = inSlot.reduce((t, p) => t + (p.positions || 1), 0);
      reason = takenHere >= slot.rooms.length
        ? 'This party slot is fully booked.'
        : 'We already have the maximum number of parties running at that time.';
    } else if (!sizeFits) {
      reason = maxGuests === 0
        ? 'This party slot is fully booked.'
        : `The rooms left in this slot hold up to ${maxGuests} guests. Pick another time, or call us at ${ARENA.phone}.`;
    } else if (!ageFits) {
      const [a] = ages;
      reason = `This slot is shared with a ${a}-year-old's party, and we keep the ages within ${ARENA.partyAgeSpreadYears} years so the kids play together.`;
    }

    return {
      start: slot.start,
      end: slot.end,
      // Positions rather than parties: one booking can occupy two rooms.
      spotsLeft: free.length,
      capacity: slot.rooms.length,
      rooms: slot.rooms,
      roomsFree: free,
      maxGuests,
      positionsNeeded: fit && fit.ok ? fit.positions : null,
      ages,
      ageFits,
      sizeFits,
      available: free.length > 0 && ageFits && sizeFits,
      reason,
      games: gamesInSlot(dateISO, slot.start),
      // Full records — the staff sheet needs them. The public endpoint strips this down to
      // just ages before it leaves the server (see publicPartySlots in api-app.js).
      parties: inSlot,
    };
  });
}

/**
 * Book a party into a 2-hour room slot.
 * Rules, in the order a human would check them: does the slot exist → is there a spot →
 * does the building have room → do the ages match. `override` lets the front desk past the
 * age rule only; it never lets them oversell the building.
 */
export function addParty(input) {
  const { dateISO, slotStart, age, guests, override = false } = input;

  const slot = partyRoomSlotsFor(dateISO).find((s) => s.start === Number(slotStart));
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
    startMin: board.games.length ? board.games[0] : slot.start,
    games: Math.max(1, board.games.length),
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
    depositState: 'due',
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
  const end = parseISO(dateISO);
  if (!end) return { days: [], totals: null };

  const n = Math.max(1, Math.min(31, Math.round(Number(days) || 7)));
  const out = [];

  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
    const iso = isoDate(d);
    const bookings = bookingsFor(iso).filter((b) => b.kind !== 'block');

    const bySource = { online: 0, walkin: 0, party: 0 };
    let players = 0;
    for (const b of bookings) {
      if (bySource[b.kind] != null) bySource[b.kind] += b.totalCents;
      players += b.players;
    }

    out.push({
      date: iso,
      weekday: d.getDay(),
      closed: hoursFor(iso).closed,
      revenueCents: bySource.online + bySource.walkin + bySource.party,
      bySource,
      players,
      bookings: bookings.length,
      gamesRun: availabilityFor(iso).filter((s) => s.taken >= ARENA.minPlayers).length,
    });
  }

  const sum = (f) => out.reduce((t, d) => t + f(d), 0);
  const open = out.filter((d) => !d.closed);
  const revenue = sum((d) => d.revenueCents);
  const best = out.reduce((a, b) => (b.revenueCents > a.revenueCents ? b : a), out[0]);

  return {
    days: out,
    totals: {
      revenueCents: revenue,
      players: sum((d) => d.players),
      bookings: sum((d) => d.bookings),
      // Averaged over trading days — a closure would otherwise drag the average down and
      // make a normal week look worse than it was.
      avgPerOpenDayCents: open.length ? Math.round(revenue / open.length) : 0,
      openDays: open.length,
      bySource: {
        online: sum((d) => d.bySource.online),
        walkin: sum((d) => d.bySource.walkin),
        party: sum((d) => d.bySource.party),
      },
      bestDay: best ? { date: best.date, revenueCents: best.revenueCents } : null,
    },
  };
}

/** Headline numbers for the staff dashboard strip. */
export function statsFor(dateISO) {
  const bookings = bookingsFor(dateISO).filter((b) => b.kind !== 'block');
  const sessions = availabilityFor(dateISO);
  return {
    gamesRunning: sessions.filter((s) => s.taken >= ARENA.minPlayers).length,
    totalSessions: sessions.length,
    playersExpected: bookings.reduce((sum, b) => sum + b.players, 0),
    revenueCents: bookings.reduce((sum, b) => sum + b.totalCents, 0),
    parties: bookings.filter((b) => b.kind === 'party').length,
    groups: bookings.filter((b) => b.group).length,
  };
}
