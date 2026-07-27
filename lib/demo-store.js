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

import { ARENA, sessionsFor, sessionSpan, priceBooking, parseISO, isPastSession } from './arena.js';

/** @type {Map<string, Array>} dateISO -> bookings for that date */
const byDate = new Map();
let nextId = 1;

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

  for (const startMin of sessions) {
    if (!demandAt(weekday, startMin, r)) continue;
    // One or two groups already in this game.
    const groups = r() < 0.35 ? 2 : 1;
    for (let g = 0; g < groups; g++) {
      const players = 2 + Math.floor(r() * 7);            // 2–8 players
      const games = 1 + Math.floor(r() * 3);              // 1–3 games
      const name = `${FIRST_NAMES[Math.floor(r() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(r() * LAST_NAMES.length)]}`;
      const priced = priceBooking({ players, games });
      if (!priced.ok) continue;
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
  return out;
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
      past: isPastSession(dateISO, startMin),
    };
  });
}

/** The staff view: sessions with the groups in each one. */
export function gameSheetFor(dateISO) {
  const bookings = bookingsFor(dateISO);
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
      past: isPastSession(dateISO, startMin),
      // `startsHere` distinguishes "this group's game begins now" from "they're mid-way
      // through a 3-game run", which is what the desk actually needs to see.
      bookings: span.map((b) => ({ ...b, startsHere: b.startMin === startMin })),
    };
  });
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
  const { dateISO, startMin, games, players, kind = 'online', allowPast = false } = input;

  if (!sessionsFor(dateISO).includes(Number(startMin))) {
    return { ok: false, status: 400, error: "That game time isn't on the schedule for this day. Pick another time." };
  }
  // Staff can record a walk-in against a game that's already underway; the public can't.
  if (!allowPast && isPastSession(dateISO, Number(startMin))) {
    return { ok: false, status: 400, error: 'That game has already started. Please pick a later game time.' };
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
