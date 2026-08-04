// In-memory booking store for the demo.
//
// No database yet (Supabase comes later). Two things make this feel real anyway:
//   1. Each date is seeded deterministically the first time it's asked for, so the grid
//      looks like a genuinely busy arena instead of an empty one — and it looks the SAME
//      every time you revisit that date.
//   2. Everything lives in one process, so a booking made on the customer page shows up on
//      the staff game sheet immediately, and a walk-in added at the desk takes seats away
//      from the customer page.
//
// State resets when the server restarts. Vercel runs each API call in its own short-lived
// process, so this shared-state behaviour is exactly what Supabase will need to take over.

import {
  ARENA, sessionsFor, sessionSpan, priceBooking, parseISO, isPastSession, isoDate, hoursFor,
  partyRoomSlotsFor, heldGamesFor, gamesInSlot, slotsOverlap, ageCompatible,
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

// ---------------------------------------------------------------------------
// Deterministic seeding
// ---------------------------------------------------------------------------

// Small string hash -> 32-bit int. Same date always produces the same arena.
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Seeded PRNG (mulberry32) so seeding never touches Math.random.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = ['Avery', 'Jordan', 'Priya', 'Mateo', 'Nia', 'Sam', 'Cassie', 'Devon', 'Rin', 'Owen',
  'Leah', 'Tariq', 'Marcus', 'Ivy', 'Jonah', 'Sofia', 'Wes', 'Amara', 'Kai', 'Dana'];
const LAST_NAMES = ['Okafor', 'Bergeron', 'Nguyen', 'Silva', 'Thompson', 'Patel', 'Lafreniere', 'Chen',
  'Moreau', 'Ahmed', 'Kowalski', 'Reyes', 'Dubois', 'Singh', 'Peters'];

// Busier on weekends and in the evening — the shape a real arena has.
function demandAt(weekday, startMin, r) {
  const evening = startMin >= 17 * 60;
  const weekend = weekday === 0 || weekday === 5 || weekday === 6;
  let base = 0.25;
  if (evening) base += 0.3;
  if (weekend) base += 0.25;
  return r() < base;
}

function seedDate(dateISO) {
  const d = parseISO(dateISO);
  const sessions = sessionsFor(dateISO);
  if (!d || !sessions.length) return [];

  const r = rng(hash(dateISO));
  const out = [];
  const weekday = d.getDay();

  const held = heldGamesFor(dateISO);

  for (const startMin of sessions) {
    // Never seed walk-ins into times the arena reserves for parties — the demo would then
    // show the front desk selling slots it actually holds back.
    if (held.includes(startMin)) continue;
    if (!demandAt(weekday, startMin, r)) continue;
    // One or two groups already in this game.
    const groups = r() < 0.35 ? 2 : 1;
    for (let g = 0; g < groups; g++) {
      const players = 2 + Math.floor(r() * 7);            // 2–8 players
      const games = 1 + Math.floor(r() * 3);              // 1–3 games
      const name = `${FIRST_NAMES[Math.floor(r() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(r() * LAST_NAMES.length)]}`;
      const priced = priceBooking({ players, games });
      if (!priced.ok) continue;
      // A multi-game run must clear held times across its whole span, not just where it
      // starts — a 2-game booking at 5:00pm would otherwise spill into the held 5:15pm.
      if (sessionSpan(dateISO, startMin, games).some((m) => held.includes(m))) continue;
      // Skip anything that would overflow a session in the span.
      if (!fitsIn(out, dateISO, startMin, games, players)) continue;
      out.push({
        id: nextId++,
        code: codeFor(r),
        dateISO,
        startMin,
        games,
        players,
        name,
        email: '',
        phone: `204-555-${String(100 + Math.floor(r() * 900))}`,
        kind: r() < 0.25 ? 'walkin' : 'online',
        totalCents: priced.totalCents,
        group: priced.group,
        createdAt: null,      // seeded rows have no real timestamp
        cancelled: false,
      });
    }
  }

  seedParties(dateISO, out, r);
  return out;
}

const PARTY_PACKAGES = [
  { id: 'traveler', name: 'The Traveler', cents: 22450 },
  { id: 'great-adventure', name: 'Great Adventure', cents: 25950 },
  { id: 'around-the-world', name: 'Around The World', cents: 35950 },
];

/**
 * Put a party or two on the board so the staff party view isn't empty. Written straight into
 * the seeded list rather than through addParty(), which would recurse back into seeding.
 * Respects the same rules addParty enforces: one party per slot here, so a second real
 * booking can still join it if the ages match.
 */
function seedParties(dateISO, out, r) {
  const slots = partyRoomSlotsFor(dateISO);
  if (!slots.length) return;

  // Weekends are party-heavy; weeknights usually have one at most.
  const weekday = parseISO(dateISO).getDay();
  const wanted = (weekday === 0 || weekday === 6) ? (r() < 0.7 ? 2 : 1) : (r() < 0.5 ? 1 : 0);
  if (!wanted) return;

  const used = [];
  for (let i = 0; i < wanted; i++) {
    // Only slots that don't overlap one we've already seeded — the building holds 2 parties
    // at once, and each seeded slot keeps a free spot for a real booking to join.
    const open = slots.filter((s) => !used.some((u) => slotsOverlap(s, u)));
    if (!open.length) return;

    const slot = open[Math.floor(r() * open.length)];
    used.push(slot);

    const pkg = PARTY_PACKAGES[Math.floor(r() * PARTY_PACKAGES.length)];
    const guests = 8 + Math.floor(r() * 6);
    const games = gamesInSlot(dateISO, slot.start);

    out.push({
      id: nextId++,
      code: codeFor(r),
      dateISO,
      slotStart: slot.start,
      slotEnd: slot.end,
      startMin: games.length ? games[0] : slot.start,
      games: Math.max(1, games.length),
      players: guests,
      age: 6 + Math.floor(r() * 7),          // 6–12, the usual laser tag birthday range
      name: `${FIRST_NAMES[Math.floor(r() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(r() * LAST_NAMES.length)]}`,
      email: '',
      phone: `204-555-${String(100 + Math.floor(r() * 900))}`,
      kind: 'party',
      packageId: pkg.id,
      packageName: pkg.name,
      totalCents: pkg.cents,
      note: `${pkg.name} · ${slot.end - slot.start} min party room`,
      createdAt: null,
      cancelled: false,
    });
  }
}

function codeFor(r) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1 — easier to read aloud
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return `LT-${s}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** All live (non-cancelled) bookings for a date, seeding the date on first access. */
export function bookingsFor(dateISO) {
  if (!byDate.has(dateISO)) byDate.set(dateISO, seedDate(dateISO));
  return byDate.get(dateISO).filter((b) => !b.cancelled);
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
export function partySlotsFor(dateISO, age = null) {
  const parties = partiesOn(dateISO);
  const slots = partyRoomSlotsFor(dateISO);

  return slots.map((slot) => {
    const inSlot = parties.filter((p) => p.slotStart === slot.start);
    // Parties in a *different* slot that still overlap in time eat into the building cap.
    const overlapping = parties.filter((p) => p.slotStart !== slot.start
      && slotsOverlap(slot, { start: p.slotStart, end: p.slotEnd }));

    const spotsBySlot = Math.max(0, ARENA.partiesPerSlot - inSlot.length);
    const spotsByBuilding = Math.max(0, ARENA.maxConcurrentParties - inSlot.length - overlapping.length);
    const spotsLeft = Math.min(spotsBySlot, spotsByBuilding);

    // Sharing the room means matching ages; a mismatch closes the slot to that enquiry.
    const ages = inSlot.map((p) => p.age).filter((a) => a != null);
    const ageFits = age == null || ages.every((a) => ageCompatible(a, age));

    let reason = null;
    if (spotsLeft === 0) {
      reason = spotsBySlot === 0
        ? 'This party slot is fully booked.'
        : 'We already have the maximum number of parties running at that time.';
    } else if (!ageFits) {
      const [a] = ages;
      reason = `This slot is shared with a ${a}-year-old's party, and we keep the ages within ${ARENA.partyAgeSpreadYears} years so the kids play together.`;
    }

    return {
      start: slot.start,
      end: slot.end,
      spotsLeft,
      capacity: ARENA.partiesPerSlot,
      ages,
      ageFits,
      available: spotsLeft > 0 && ageFits,
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

  // Ask the board about this exact age so `ageFits` is meaningful either way — an override
  // needs to know it *is* overriding something, not just be handed a clean bill of health.
  const board = partySlotsFor(dateISO, age).find((s) => s.start === slot.start);

  // Capacity is never overridable: the building holds what it holds.
  if (board.spotsLeft === 0) {
    const full = partySlotsFor(dateISO, null).find((s) => s.start === slot.start);
    return { ok: false, status: 409, error: full.reason };
  }
  if (!board.ageFits && !override) {
    return { ok: false, status: 409, error: board.reason };
  }

  const list = byDate.has(dateISO) ? byDate.get(dateISO) : (byDate.set(dateISO, seedDate(dateISO)), byDate.get(dateISO));

  const booking = {
    id: nextId++,
    code: codeFor(rng(hash(`${dateISO}${slot.start}${nextId}${list.length}`))),
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
  // Party-held times are off the public grid until the desk releases them. A multi-game run
  // has to clear every game it occupies, not just the one it starts in — otherwise buying
  // 3 games at 5:00pm would quietly swallow the 5:15 and 5:30 party slots.
  if (!allowHeld) {
    const clash = sessionSpan(dateISO, Number(startMin), Number(games)).find((m) => isHeld(dateISO, m));
    if (clash != null) {
      return { ok: false, status: 409, error: 'That game time is reserved for birthday parties. Please pick another time, or call us — it may open up.' };
    }
  }

  const list = byDate.has(dateISO) ? byDate.get(dateISO) : (byDate.set(dateISO, seedDate(dateISO)), byDate.get(dateISO));
  const live = list.filter((b) => !b.cancelled);

  if (!fitsIn(live, dateISO, Number(startMin), Number(games), Number(players))) {
    return { ok: false, status: 409, error: 'That game just filled up. Please pick another time — the grid has been refreshed.' };
  }

  const booking = {
    id: nextId++,
    code: input.code || codeFor(rng(hash(`${dateISO}${startMin}${nextId}${list.length}`))),
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
  const list = byDate.has(dateISO) ? byDate.get(dateISO) : (byDate.set(dateISO, seedDate(dateISO)), byDate.get(dateISO));
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
 * Each date seeds deterministically, so the trend is stable between visits rather than
 * reshuffling every reload — a demo that changes its own history isn't demonstrating
 * anything. Closed days come back at zero rather than being dropped, so the shape of the
 * week stays honest.
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
