// Views over a day's bookings.
//
// Everything here is a pure function of a list of bookings — no storage, no I/O. Both the
// in-memory store and the Postgres one hand their rows to these, so the seat arithmetic,
// the room allocation and the staff figures exist exactly once. Two copies of this logic
// drifting apart is how a customer ends up in a room that is already full.
//
// `heldAt` is passed in rather than looked up, because whether a game is withheld depends
// on staff overrides, which each store keeps in its own place.

import {
  ARENA, sessionsFor, sessionSpan, isPastSession, isBookableOnline, isoDate, parseISO,
  hoursFor, partyRoomSlotsFor, gamesInSlot, slotsOverlap, ageCompatible,
  roomFit, roomsFreeIn, maxGuestsIn,
} from './arena.js';

/** Seats taken in one session, counting every booking whose span covers it. */
export function seatsAt(bookings, dateISO, startMin) {
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
export function fitsIn(bookings, dateISO, startMin, games, players) {
  const span = sessionSpan(dateISO, startMin, games);
  if (span.length < games) return false;                      // would run past closing
  return span.every((m) => ARENA.capacity - seatsAt(bookings, dateISO, m) >= players);
}

/**
 * Public availability for a date: one entry per game session.
 * Deliberately carries no customer data — this feeds the public booking page.
 */
export function availabilityFrom(bookings, dateISO, heldAt) {
  return sessionsFor(dateISO).map((startMin) => {
    const taken = seatsAt(bookings, dateISO, startMin);
    const blocked = bookings.some((b) => b.kind === 'block' && b.startMin === startMin);
    return {
      startMin,
      taken,
      seatsLeft: Math.max(0, ARENA.capacity - taken),
      capacity: ARENA.capacity,
      blocked,
      held: heldAt(startMin),
      past: isPastSession(dateISO, startMin),
      // Closed to the website but still sellable at the desk — shown, not hidden, so a
      // half-empty evening doesn't read as sold out.
      cutoff: !isPastSession(dateISO, startMin) && !isBookableOnline(dateISO, startMin),
    };
  });
}

/** The staff view: sessions with the groups in each one. */
export function gameSheetFrom(bookings, dateISO, heldAt, defaultHeld) {
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
      held: heldAt(startMin),
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

/**
 * The party board for a date: every room slot with who's in it and whether it can take
 * another booking. `age` and `guests` are optional — pass them and each slot answers for
 * that specific enquiry rather than in the abstract.
 */
export function partySlotsFrom(bookings, dateISO, age = null, guests = null) {
  const parties = bookings.filter((b) => b.kind === 'party' && b.slotStart != null);
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

/** Headline numbers for the staff dashboard strip. */
export function statsFrom(bookings, availability) {
  const live = bookings.filter((b) => b.kind !== 'block');
  return {
    gamesRunning: availability.filter((s) => s.taken >= ARENA.minPlayers).length,
    totalSessions: availability.length,
    playersExpected: live.reduce((sum, b) => sum + b.players, 0),
    revenueCents: live.reduce((sum, b) => sum + b.totalCents, 0),
    parties: live.filter((b) => b.kind === 'party').length,
    groups: live.filter((b) => b.group).length,
  };
}

/** The N dates ending on `dateISO`, oldest first. */
export function analyticsDates(dateISO, days = 7) {
  const end = parseISO(dateISO);
  if (!end) return [];
  const n = Math.max(1, Math.min(31, Math.round(Number(days) || 7)));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(isoDate(new Date(end.getFullYear(), end.getMonth(), end.getDate() - i)));
  }
  return out;
}

/**
 * Revenue over a trailing window.
 *
 * @param {string[]} dates
 * @param {(iso:string) => Array}  bookingsOn
 * @param {(iso:string) => Array}  availabilityOn
 */
export function analyticsFrom(dates, bookingsOn, availabilityOn) {
  if (!dates.length) return { days: [], totals: null };

  const out = dates.map((iso) => {
    const bookings = bookingsOn(iso).filter((b) => b.kind !== 'block');
    const bySource = { online: 0, walkin: 0, party: 0 };
    let players = 0;
    for (const b of bookings) {
      if (bySource[b.kind] != null) bySource[b.kind] += b.totalCents;
      players += b.players;
    }
    return {
      date: iso,
      weekday: parseISO(iso).getDay(),
      closed: hoursFor(iso).closed,
      revenueCents: bySource.online + bySource.walkin + bySource.party,
      bySource,
      players,
      bookings: bookings.length,
      gamesRun: availabilityOn(iso).filter((s) => s.taken >= ARENA.minPlayers).length,
    };
  });

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
