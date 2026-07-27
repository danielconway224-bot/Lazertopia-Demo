// Lasertopia arena model — hours, game sessions, capacity and per-person pricing.
//
// One source of truth: the Node server imports this, and the browser loads the very same
// file as an ES module (served at /lib/arena.js). Pricing shown to a customer and pricing
// recorded by the server therefore cannot drift.
//
// The shape of the business, in one paragraph: there is ONE arena, not a set of bookable
// resources. Games launch every 15 minutes, up to 25 players per game, and you buy games
// per person (1, 2 or 3). So availability is "seats left in this session", not "is this
// resource free from X to Y".

// ---------------------------------------------------------------------------
// Configuration — everything Lasertopia might want changed lives here.
// ---------------------------------------------------------------------------

export const ARENA = {
  name: 'Lasertopia',
  phone: '204-474-5900',
  address: 'Unit #5 – 1140 Waverley Street, Winnipeg MB, R3T 0P4',

  capacity: 25,          // players per game (2-floor, 4,500 sq ft arena)
  minPlayers: 2,         // a game won't run with fewer than this
  sessionStepMin: 15,    // a new game launches every 15 minutes
  gameLengthMin: 15,     // one game occupies one 15-minute session
  lastGameBeforeCloseMin: 30,   // last game starts 30 min before the doors close

  recommendedAge: 6,
  groupMinPlayers: 12,   // 12+ is a "group" and gets group rates
  groupNoticeHours: 24,  // groups need 24 hours advance notice

  // Multi-game bookings hold consecutive sessions (3 games = 3 back-to-back slots), which is
  // how the front desk actually seats a group and keeps the game sheet honest. Lasertopia's
  // published rate is "same day play", so if they'd rather only hold the first game and let
  // people redeem the rest whenever, flip this to false — nothing else needs to change.
  consecutiveGames: true,

  // Lasertopia doesn't publish the 12+ group rate, so we do NOT invent one. Standard rates
  // apply and group bookings are simply flagged for staff. Set this to e.g. 10 for 10% off
  // once we're told the real number.
  groupDiscountPct: 0,
};

// Per-person prices in cents. Taxes not included (matches their published rates).
export const PACKAGES = [
  { games: 1, cents:  849, label: '1 game'  },
  { games: 2, cents: 1549, label: '2 games' },
  { games: 3, cents: 2149, label: '3 games' },
];

// Regular weekly hours as [openMinute, closeMinute] from midnight. Index = JS weekday (0=Sun).
export const WEEKLY_HOURS = {
  0: [12 * 60, 19 * 60],        // Sunday    12:00pm – 7:00pm
  1: [12 * 60, 21 * 60],        // Monday    12:00pm – 9:00pm
  2: [12 * 60, 21 * 60],        // Tuesday   12:00pm – 9:00pm
  3: [12 * 60, 21 * 60],        // Wednesday 12:00pm – 9:00pm
  4: [12 * 60, 21 * 60],        // Thursday  12:00pm – 9:00pm
  5: [12 * 60, 22 * 60],        // Friday    12:00pm – 10:00pm
  6: [12 * 60, 21 * 60],        // Saturday  12:00pm – 9:00pm
};

// Dated exceptions that beat the weekly pattern. `null` hours = closed all day.
// These are Lasertopia's published July/August special hours.
export const SPECIAL_HOURS = {
  '2026-07-30': { hours: [16 * 60, 21 * 60],      note: 'Special hours' },
  '2026-07-31': { hours: [15 * 60 + 30, 22 * 60], note: 'Special hours' },
  '2026-08-02': { hours: [12 * 60, 18 * 60],      note: 'Special hours' },
  '2026-08-03': { hours: null,                    note: 'Closed' },
  '2026-08-06': { hours: [15 * 60 + 30, 21 * 60], note: 'Special hours' },
  '2026-08-13': { hours: [15 * 60 + 30, 21 * 60], note: 'Special hours' },
  '2026-08-14': { hours: [15 * 60 + 30, 21 * 60], note: 'Special hours' },
};

// Event packages, straight from lasertopia.ca/event-packages. Prices in cents.
export const EVENT_PACKAGES = [
  {
    id: 'traveler',
    name: 'The Traveler',
    cents: 22450,
    extraGuestCents: 2245,
    guests: 10,
    roomMinutes: 90,
    includes: [
      'Private party room for 1.5 hours',
      '2 games of laser tag',
      'Lasertopia merchandise for the guest of honour',
    ],
  },
  {
    id: 'great-adventure',
    name: 'Great Adventure',
    cents: 25950,
    extraGuestCents: 2595,
    guests: 10,
    roomMinutes: 120,
    includes: [
      'Private party room for 2 hours',
      '2 games of laser tag',
      '2 large 1-topping pizzas OR 1 hot dog per guest',
      '1 cupcake per guest',
      'Lasertopia merchandise for the guest of honour',
    ],
    addOn: { name: 'QBIX', cents: 395, per: 'person' },
  },
  {
    id: 'around-the-world',
    name: 'Around The World',
    cents: 35950,
    extraGuestCents: 3595,
    guests: 10,
    roomMinutes: 120,
    includes: [
      'Private party room for 2 hours',
      '2 games of laser tag',
      '1 game of Lazer Frenzy per guest',
      '1 Typhoon Experience per guest',
      '1 $10 Lasertopia Fun Card per guest',
      'Pizza or hot dog and a cupcake per guest',
      'Lasertopia merchandise for the guest of honour',
    ],
  },
];

// Every package includes these.
export const PACKAGE_PERKS = ['VIP host', 'Setup and cleanup', 'Soft drinks and popcorn'];

export const HOUSE_RULES = [
  'Clean, closed-toe shoes required — no flip-flops, sandals or platforms.',
  'Nut-free facility: no outside food, drinks, cakes or candies.',
  'A signed waiver is required for every player.',
  'Players under 18 need a waiver signed by a parent or legal guardian.',
];

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/** Date -> 'YYYY-MM-DD' in local time (never use toISOString: it shifts by timezone). */
export function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DD' -> local midnight Date. Returns null if the string isn't a valid date. */
export function parseISO(dateISO) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateISO || ''));
  if (!m) return null;
  const [y, mo, da] = [+m[1], +m[2], +m[3]];
  const d = new Date(y, mo - 1, da);
  // Rejects impossible dates that JS would otherwise roll over (2026-02-31 -> Mar 3).
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
  return d;
}

/** Minutes from midnight -> '7:15pm'. */
export function fmtTime(min) {
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${pad(m)}${h24 < 12 ? 'am' : 'pm'}`;
}

/** Cents -> '$8.49'. */
export function money(cents) {
  return `$${(Math.round(cents) / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Hours for a given date
// ---------------------------------------------------------------------------

/**
 * Resolve the opening hours for one date.
 * @returns {{open:number|null, close:number|null, closed:boolean, special:boolean, note:string|null}}
 */
export function hoursFor(dateISO) {
  const d = parseISO(dateISO);
  if (!d) return { open: null, close: null, closed: true, special: false, note: null };

  const override = SPECIAL_HOURS[dateISO];
  if (override) {
    if (!override.hours) {
      return { open: null, close: null, closed: true, special: true, note: override.note || 'Closed' };
    }
    const [open, close] = override.hours;
    return { open, close, closed: false, special: true, note: override.note || 'Special hours' };
  }

  const regular = WEEKLY_HOURS[d.getDay()];
  if (!regular) return { open: null, close: null, closed: true, special: false, note: null };
  return { open: regular[0], close: regular[1], closed: false, special: false, note: null };
}

// ---------------------------------------------------------------------------
// Game sessions
// ---------------------------------------------------------------------------

/**
 * Every game start time for a date, as minutes from midnight.
 * Games run every 15 min; the last one starts 30 min before close.
 */
export function sessionsFor(dateISO) {
  const { open, close, closed } = hoursFor(dateISO);
  if (closed || open == null) return [];
  const out = [];
  const lastStart = close - ARENA.lastGameBeforeCloseMin;
  for (let m = open; m <= lastStart; m += ARENA.sessionStepMin) out.push(m);
  return out;
}

/**
 * Has this game already started? Today's earlier sessions must stop being bookable, or a
 * customer can pay at 6pm for the noon game. `now` is injectable so the server judges
 * against its own clock instead of trusting the browser's.
 */
export function isPastSession(dateISO, startMin, now = new Date()) {
  const d = parseISO(dateISO);
  if (!d) return true;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  start.setMinutes(start.getMinutes() + (Number(startMin) || 0));
  return start.getTime() <= now.getTime();
}

/**
 * The session start times a booking occupies. With consecutiveGames on, an N-game booking
 * holds N back-to-back sessions; otherwise it holds only the one it starts in.
 */
export function sessionSpan(dateISO, startMin, games) {
  const n = Math.max(1, Math.round(Number(games) || 1));
  if (!ARENA.consecutiveGames) return [startMin];
  const all = sessionsFor(dateISO);
  const i = all.indexOf(startMin);
  if (i === -1) return [];
  return all.slice(i, i + n);
}

/**
 * True when the arena can still take `players` for an N-game booking starting at `startMin`.
 * Every session in the span needs room — a 3-game group that only fits in the first two
 * sessions can't be seated.
 */
export function spanFits(dateISO, startMin, games, players, seatsTakenAt) {
  const span = sessionSpan(dateISO, startMin, games);
  const need = Math.max(1, Math.round(Number(players) || 1));
  if (span.length < Math.max(1, Math.round(Number(games) || 1))) return false;   // runs past closing
  return span.every((m) => (ARENA.capacity - seatsTakenAt(m)) >= need);
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export function packageFor(games) {
  return PACKAGES.find((p) => p.games === Math.round(Number(games))) || null;
}

/** True once a party is big enough to count as a group. */
export function isGroup(players) {
  return (Number(players) || 0) >= ARENA.groupMinPlayers;
}

/**
 * Price a laser tag booking. Server-authoritative: the browser displays this, it never sets it.
 * @returns {{ok:true, perPersonCents, subtotalCents, discountCents, totalCents, players, games, group}}
 *          or {ok:false, error} when the request doesn't describe a real booking.
 */
export function priceBooking({ players, games }) {
  const n = Math.round(Number(players));
  const g = Math.round(Number(games));

  if (!isFinite(n) || n < ARENA.minPlayers) {
    return { ok: false, error: `A game needs at least ${ARENA.minPlayers} players. Add another player, or call us at ${ARENA.phone} and we'll pair you with a group.` };
  }
  if (n > ARENA.capacity) {
    return { ok: false, error: `The arena holds ${ARENA.capacity} players per game. For a larger group, call us at ${ARENA.phone} and we'll split you across back-to-back games.` };
  }
  const pkg = packageFor(g);
  if (!pkg) {
    return { ok: false, error: 'Choose 1, 2 or 3 games.' };
  }

  const subtotalCents = pkg.cents * n;
  const group = isGroup(n);
  const discountCents = group ? Math.round(subtotalCents * (ARENA.groupDiscountPct / 100)) : 0;

  return {
    ok: true,
    perPersonCents: pkg.cents,
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
    players: n,
    games: g,
    group,
  };
}

/**
 * Group bookings need 24 hours notice. `now` is injectable so this is testable and so the
 * server judges against its own clock rather than trusting the browser's.
 */
export function groupNoticeOk({ dateISO, startMin, players }, now = new Date()) {
  if (!isGroup(players)) return { ok: true };
  const d = parseISO(dateISO);
  if (!d) return { ok: false, error: 'Pick a valid date.' };
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  start.setMinutes(start.getMinutes() + (Number(startMin) || 0));
  const hoursAway = (start.getTime() - now.getTime()) / 3600000;
  if (hoursAway < ARENA.groupNoticeHours) {
    return {
      ok: false,
      error: `Groups of ${ARENA.groupMinPlayers} or more need ${ARENA.groupNoticeHours} hours notice. Please pick a later date, or call us at ${ARENA.phone} — we'll do our best to fit you in today.`,
    };
  }
  return { ok: true };
}

/** Price an event package for a guest count (extra guests are charged above the base 10). */
export function priceEventPackage(packageId, guests) {
  const pkg = EVENT_PACKAGES.find((p) => p.id === packageId);
  if (!pkg) return { ok: false, error: 'Choose one of our party packages.' };
  const n = Math.round(Number(guests));
  if (!isFinite(n) || n < 1) return { ok: false, error: 'Tell us how many guests are coming.' };
  if (n > ARENA.capacity) {
    return { ok: false, error: `Parties over ${ARENA.capacity} guests are booked by phone — call us at ${ARENA.phone}.` };
  }
  const extra = Math.max(0, n - pkg.guests);
  return {
    ok: true,
    packageId: pkg.id,
    name: pkg.name,
    guests: n,
    baseCents: pkg.cents,
    extraGuests: extra,
    extraCents: extra * pkg.extraGuestCents,
    totalCents: pkg.cents + extra * pkg.extraGuestCents,
    roomMinutes: pkg.roomMinutes,
  };
}
