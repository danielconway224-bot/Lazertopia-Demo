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

  // ----- Birthday parties -----
  // Parties share a room slot, which is why age matters: the kids mix, so the guests of
  // honour are kept within a couple of years of each other.
  partyAgeSpreadYears: 2,
  // Weekend party slots start at 10/11am, before public laser tag opens at noon. The arena
  // opens early for a booked party; it does not open early for walk-ins.
  partyOpensEarly: true,

  // A party of more than 20 needs three room positions, which only the weekend 10–12 slot
  // has. Rather than let the site promise a seat it may not be able to honour, anything
  // larger is taken by phone — the desk arranges the rooms and the laser tag split.
  maxPartyGuestsOnline: 20,
  maxPartyGuests: 28,

  // Above this the party can't all play at once and the desk splits them into two groups.
  partySplitAbove: 25,

  // Deposit, and the notice window that decides whether it becomes a gift card or is lost.
  partyDepositCents: 5000,
  partyChangeNoticeDays: 14,

  // ----- Online booking cutoff -----
  // Laser tag stops being bookable online this long before it starts, so seats are left for
  // walk-ins at the door and the desk isn't double-booking against the website. Staff are
  // exempt; parties are unaffected. Set to 0 to sell right up to the start time.
  onlineCutoffMin: 90,
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

// ---------------------------------------------------------------------------
// Party scheduling — exactly as Lasertopia runs it (Shannon, by email).
// Times are minutes from midnight, same convention as WEEKLY_HOURS. Index = JS weekday.
// ---------------------------------------------------------------------------

const hm = (h, m = 0) => h * 60 + m;

/**
 * One 2-hour party room slot.
 *
 * `rooms` is the capacity of each physical room available in that window, largest last.
 * A party takes the smallest room that holds it; if none does, it takes two and is capped
 * at `combined`. `games` are the laser tag times that slot plays — explicit rather than
 * derived, because the weekend 10–12 games run BEFORE the arena opens to the public and so
 * can't be expressed as "public sessions held back".
 *
 * @param {number}   start    minutes past midnight
 * @param {number}   end
 * @param {number[]} rooms    capacity of each room, in guests (guest of honour included)
 * @param {number}   combined capacity when a party takes more than one room
 * @param {number[]} games    laser tag start times played inside this slot
 */
const slot = (start, end, rooms, combined, games) => ({ start, end, rooms, combined, games });

// Mon–Fri: the 5–7 room set takes 14 (20 across two), and 6–8 has a 12 and a 14 (18 across two).
const WEEKDAY_SLOTS = [
  slot(hm(17), hm(19), [14, 14], 20, [hm(17, 15), hm(17, 30)]),
  slot(hm(18), hm(20), [12, 14], 18, [hm(18, 15), hm(18, 45)]),
];

// The weekend 10–12 slot has a third, larger room, and its four games run before opening.
const WEEKEND_MORNING = [
  slot(hm(10), hm(12), [14, 14, 18], 20, [hm(10, 15), hm(10, 30), hm(10, 45), hm(11)]),
  // 11–1 has the same two rooms as every other pair slot. Its laser tag times are the one
  // gap left in the schedule — see README. Empty rather than guessed.
  slot(hm(11), hm(13), [12, 14], 18, []),
];

export const PARTY_ROOM_SLOTS = {
  0: [                                                                    // Sunday
    ...WEEKEND_MORNING,
    slot(hm(13), hm(15), [14, 14], 20, [hm(13, 15), hm(13, 45)]),
    slot(hm(15), hm(17), [12, 14], 18, [hm(15), hm(15, 15)]),
    slot(hm(16), hm(18), [14, 14], 20, [hm(16, 15), hm(16, 45)]),
  ],
  1: WEEKDAY_SLOTS,
  2: WEEKDAY_SLOTS,
  3: WEEKDAY_SLOTS,
  4: WEEKDAY_SLOTS,
  5: WEEKDAY_SLOTS,
  6: [                                                                    // Saturday
    ...WEEKEND_MORNING,
    slot(hm(13), hm(15), [14, 14], 20, [hm(13, 15), hm(13, 45)]),
    slot(hm(15), hm(17), [12, 14], 18, [hm(15, 15), hm(15, 45)]),
    slot(hm(17), hm(19), [14, 14], 20, [hm(17, 15), hm(17, 45)]),
  ],
};

// The most parties the building can run at once is however many rooms the busiest slot has.
export const maxConcurrentParties = Math.max(
  ...Object.values(PARTY_ROOM_SLOTS).flat().map((s) => s.rooms.length));

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

// Every package covers 10 guests: 9 friends plus the Birthday Guest of Honour.
export const PACKAGE_BASE_GUESTS = 10;

/**
 * Optional extras.
 *
 * The two arcade cards are alternatives, not additions — a booking takes one or neither.
 * The 5-Up card has no fixed price: the guest loads money at the counter and Lasertopia
 * matches it, so it is recorded as a choice rather than charged here.
 */
export const ADD_ONS = [
  {
    id: 'qbix',
    group: 'attraction',
    name: 'Q-BIX 5D Attraction',
    cents: 395,
    per: 'person',
    packages: null,                 // null = available on every package
    blurb: 'An immersive 5D interactive game for up to 5 players with a choice of game modes. '
         + 'Wind, motion, sound and lighting react to what happens on screen.',
  },
  {
    id: 'arcade-5up',
    group: 'arcade',
    name: '5-Up Arcade Card',
    cents: 0,                       // paid at the counter, so nothing to charge up front
    matchUpToCents: 2000,
    per: 'guest',
    packages: ['traveler', 'great-adventure'],
    blurb: 'The guest loads $5 and we match it with $5 Bonus Cash — matched all the way up to $20.',
  },
  {
    id: 'arcade-time',
    group: 'arcade',
    name: '45-minute Arcade Time Play',
    cents: 500,
    per: 'guest',
    packages: ['traveler', 'great-adventure'],
    blurb: 'Unlimited arcade time play for 45 minutes. Does not collect points for prizes, '
         + 'and does not work on the Claw Machines or Q-BIX.',
  },
];

/**
 * How many large 1-topping pizzas a package includes at a given guest count.
 *
 * Lasertopia's bands left 11 guests unassigned and listed 20 and 25 twice. These tiers keep
 * every stated figure and close the gaps by reading each band as "up to and including".
 * Confirm with Lasertopia before this reaches a real till — see README.
 */
export const PIZZA_TIERS = [
  { upToGuests: 11, pizzas: 2 },
  { upToGuests: 15, pizzas: 3 },
  { upToGuests: 20, pizzas: 4 },
  { upToGuests: 25, pizzas: 5 },
  { upToGuests: 28, pizzas: 6 },
];

export function pizzasFor(guests) {
  const n = Math.round(Number(guests) || 0);
  const tier = PIZZA_TIERS.find((t) => n <= t.upToGuests);
  return tier ? tier.pizzas : PIZZA_TIERS[PIZZA_TIERS.length - 1].pizzas;
}

/**
 * Extra food, ordered on top of a package.
 *
 * NOTE: unlike every other price in this file, these INCLUDE tax — that's how Lasertopia
 * quotes them. Until we know the rate used, they can't be folded into a pre-tax subtotal,
 * so they are shown and totalled separately. See README.
 */
export const FOOD_PRICES_INCLUDE_TAX = true;

export const EXTRA_PIZZAS = [
  { id: 'cheese', name: 'Large cheese pizza', cents: 2239 },
  { id: 'one-topping', name: 'Large 1-topping pizza', cents: 2463 },
  { id: 'two-topping', name: 'Large 2-topping pizza', cents: 2687 },
];
export const PIZZA_TOPPINGS = ['Pepperoni', 'Bacon', 'Hawaiian'];

export const WINGS = [
  { id: 'wings-8', name: '8 wings', cents: 1007 },
  { id: 'wings-16', name: '16 wings', cents: 1903 },
  { id: 'wings-24', name: '24 wings', cents: 2911 },
];
export const WING_SAUCES = [
  'Louisiana', 'Dry', 'Sweet Chili', 'Honey Garlic',
  'Salt and Pepper', 'Lemon Pepper', 'Honey Garlic BBQ',
];

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

/**
 * The arena's timezone. Everything time-of-day depends on this, not on wherever the code
 * happens to run: Vercel's servers are UTC, and a customer's browser is wherever they are.
 * Without pinning it, a server five hours ahead greys out every game before ~6pm.
 */
export const TIMEZONE = 'America/Winnipeg';

/**
 * The wall-clock date and time in Winnipeg right now.
 * @returns {{dateISO: string, minutes: number}} minutes = minutes past midnight, local to the arena
 */
export function arenaNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);

  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    dateISO: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** Today's date in Winnipeg, as 'YYYY-MM-DD'. */
export function arenaToday(now = new Date()) {
  return arenaNow(now).dateISO;
}

/** Whole days from one ISO date to another, via UTC so no DST shift can skew it. */
function daysBetween(fromISO, toISO) {
  const a = parseISO(fromISO), b = parseISO(toISO);
  if (!a || !b) return 0;
  return Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()))
    / 86400000);
}

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

/** Cents -> '$8.49', with thousands grouped once the numbers get big ('$7,513.68'). */
export function money(cents) {
  return `$${(Math.round(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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
 * Has this game already started, in Winnipeg?
 *
 * Compared against the arena's wall clock, never the machine's. Vercel runs in UTC, so a
 * naive comparison marked every game before ~6pm as gone while it was still lunchtime here.
 */
export function isPastSession(dateISO, startMin, now = new Date()) {
  if (!parseISO(dateISO)) return true;
  const cur = arenaNow(now);
  if (dateISO < cur.dateISO) return true;      // ISO dates sort lexicographically
  if (dateISO > cur.dateISO) return false;
  return Number(startMin) <= cur.minutes;
}

/**
 * Can the public still book this game online?
 *
 * Closes `ARENA.onlineCutoffMin` before the start rather than at the start, so seats are
 * left for walk-ins arriving at the door. Staff bypass this — the desk seats people into the
 * game that is running now — and parties are unaffected.
 */
export function isBookableOnline(dateISO, startMin, now = new Date()) {
  if (!parseISO(dateISO)) return false;
  const cur = arenaNow(now);
  if (dateISO < cur.dateISO) return false;
  if (dateISO > cur.dateISO) return true;
  return Number(startMin) - cur.minutes >= ARENA.onlineCutoffMin;
}

/**
 * Minutes until a game starts, on the arena clock. Negative once it has begun.
 * Used to explain *why* a game closed rather than just greying it out.
 */
export function minutesUntil(dateISO, startMin, now = new Date()) {
  const cur = arenaNow(now);
  return daysBetween(cur.dateISO, dateISO) * 1440 + (Number(startMin) || 0) - cur.minutes;
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
// Parties
// ---------------------------------------------------------------------------

/**
 * The 2-hour party room slots for a date, as [{start, end}].
 * Slots are a property of the weekday, and survive special hours — a party booked into a
 * 5–7 slot isn't cancelled because the venue opens late that day. A full closure clears them.
 */
export function partyRoomSlotsFor(dateISO) {
  const d = parseISO(dateISO);
  if (!d) return [];
  const h = hoursFor(dateISO);
  if (h.closed) return [];        // closed all day means no parties either
  return (PARTY_ROOM_SLOTS[d.getDay()] || []).map((s) => ({ ...s, rooms: [...s.rooms], games: [...s.games] }));
}

/**
 * Public game times withheld from booking because a party plays them.
 *
 * Only the slot games that fall inside public opening hours qualify: the weekend 10–12
 * games run before the doors open, so there is no public session to withhold. A special-
 * hours day that opens at 4pm likewise has no 1:15pm game to hold.
 */
export function heldGamesFor(dateISO) {
  return heldGamesFromSlots(partyRoomSlotsFor(dateISO), dateISO);
}

/**
 * The same, for a slot list that may have been edited by the manager for one date.
 * Kept separate so the standing schedule stays a pure function of the weekday.
 */
export function heldGamesFromSlots(slots, dateISO) {
  const sessions = sessionsFor(dateISO);
  const games = new Set();
  for (const s of slots) {
    for (const m of s.games) if (sessions.includes(m)) games.add(m);
  }
  return [...games].sort((a, b) => a - b);
}

/**
 * Apply a manager's edits for one date on top of the standing weekly slots.
 *
 * The published schedule is the default and loads every day; an override changes, adds or
 * removes a slot for that date only. Stored per date rather than as a new default, because
 * "we moved the 5pm party to 5:30 that Saturday" must not silently rewrite every Saturday.
 *
 * @param {Array} defaults   from partyRoomSlotsFor()
 * @param {Array} overrides  rows: {slotStart, slotEnd, rooms, combined, games, removed}
 */
export function applySlotOverrides(defaults, overrides = []) {
  const out = new Map(defaults.map((s) => [s.start, { ...s }]));
  for (const o of overrides) {
    if (o.removed) { out.delete(o.slotStart); continue; }
    out.set(o.slotStart, {
      start: o.slotStart,
      end: o.slotEnd,
      rooms: [...(o.rooms || [])],
      combined: o.combined,
      games: [...(o.games || [])],
      edited: true,
    });
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}

/**
 * The laser tag games a party in this slot plays.
 *
 * Now read straight off the slot rather than derived from the held list. Parties sharing a
 * slot play the same games together — two parties of ten is twenty players, comfortably
 * inside the arena's twenty-five.
 */
export function gamesInSlot(dateISO, slotStart) {
  const slot = partyRoomSlotsFor(dateISO).find((s) => s.start === Number(slotStart));
  return slot ? [...slot.games] : [];
}

/**
 * Which rooms a party of this size would occupy, given what's still free in the slot.
 *
 * Best fit: the smallest single room that holds them, so the larger rooms stay free for
 * larger parties. If no single room is big enough it takes the two largest free rooms and
 * is capped at the slot's combined figure.
 *
 * @param {object}   slot       from partyRoomSlotsFor()
 * @param {number}   guests
 * @param {number[]} freeRooms  capacities still unbooked; defaults to the whole slot
 * @returns {{ok:true, positions:number, rooms:number[], capacity:number}|{ok:false, max:number}}
 */
export function roomFit(slot, guests, freeRooms = null) {
  const avail = [...(freeRooms || slot.rooms)].sort((a, b) => a - b);
  const n = Math.round(Number(guests) || 0);

  const single = avail.find((cap) => n <= cap);
  if (single != null) return { ok: true, positions: 1, rooms: [single], capacity: single };

  if (avail.length >= 2 && n <= slot.combined) {
    const two = avail.slice(-2);          // the two largest free rooms
    return { ok: true, positions: 2, rooms: two, capacity: slot.combined };
  }

  return {
    ok: false,
    max: avail.length >= 2 ? slot.combined : (avail.length ? Math.max(...avail) : 0),
  };
}

/** The room capacities still unbooked in a slot, given the parties already in it. */
export function roomsFreeIn(slot, parties) {
  const free = [...slot.rooms].sort((a, b) => a - b);
  for (const p of parties) {
    // Older rows predate room tracking; charge them one position so they still occupy space.
    const taken = (p.rooms && p.rooms.length) ? p.rooms : [free[free.length - 1]];
    for (const cap of taken) {
      const i = free.indexOf(cap);
      if (i !== -1) free.splice(i, 1);
      else if (free.length) free.pop();
    }
  }
  return free;
}

/** The largest party the free rooms could still take. */
export function maxGuestsIn(slot, freeRooms) {
  if (!freeRooms.length) return 0;
  const biggest = Math.max(...freeRooms);
  return freeRooms.length >= 2 ? Math.max(biggest, slot.combined) : biggest;
}

/** True when a party this size can't all play at once and the desk splits them. */
export function splitsForLaserTag(guests) {
  return (Number(guests) || 0) > ARENA.partySplitAbove;
}

/** Do two [start,end) ranges overlap in time? */
export function slotsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

/** Are two guests of honour close enough in age to share a room slot? */
export function ageCompatible(ageA, ageB) {
  const a = Number(ageA), b = Number(ageB);
  if (!isFinite(a) || !isFinite(b)) return true;   // unknown age can't conflict
  return Math.abs(a - b) <= ARENA.partyAgeSpreadYears;
}

/** Validate a guest-of-honour age. Kept loose — it's a birthday, not a passport check. */
export function validAge(age) {
  const n = Number(age);
  return isFinite(n) && n >= 1 && n <= 99;
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
  if (!parseISO(dateISO)) return { ok: false, error: 'Pick a valid date.' };

  // Measured on the arena's clock, so the rule means the same thing wherever the code runs.
  const cur = arenaNow(now);
  const minutesAway = daysBetween(cur.dateISO, dateISO) * 1440 + (Number(startMin) || 0) - cur.minutes;
  const hoursAway = minutesAway / 60;

  if (hoursAway < ARENA.groupNoticeHours) {
    return {
      ok: false,
      error: `Groups of ${ARENA.groupMinPlayers} or more need ${ARENA.groupNoticeHours} hours notice. Please pick a later date, or call us at ${ARENA.phone} — we'll do our best to fit you in today.`,
    };
  }
  return { ok: true };
}

/** The add-ons a given package is allowed to have. */
export function addOnsFor(packageId) {
  return ADD_ONS.filter((a) => !a.packages || a.packages.includes(packageId));
}

/**
 * Price an event package.
 *
 * Extra guests are charged above the base 10. Add-ons and extra food are itemised
 * separately: package and add-on prices exclude tax, food prices include it, so folding
 * them into one subtotal would be wrong until we know the rate. `totalCents` is the
 * package plus its add-ons; `foodCents` is reported alongside, never merged.
 *
 * @param {string} packageId
 * @param {number} guests
 * @param {{addOns?: string[], food?: Array<{id:string, qty:number}>}} extras
 */
export function priceEventPackage(packageId, guests, extras = {}) {
  const pkg = EVENT_PACKAGES.find((p) => p.id === packageId);
  if (!pkg) return { ok: false, error: 'Choose one of our party packages.' };

  const n = Math.round(Number(guests));
  if (!isFinite(n) || n < 1) return { ok: false, error: 'Tell us how many guests are coming.' };
  if (n > ARENA.maxPartyGuestsOnline) {
    return {
      ok: false,
      error: `Parties over ${ARENA.maxPartyGuestsOnline} guests are booked by phone — call us at ${ARENA.phone} and we'll arrange the rooms for you.`,
    };
  }

  const extra = Math.max(0, n - pkg.guests);
  const packageCents = pkg.cents + extra * pkg.extraGuestCents;

  // Add-ons. Only one arcade card may be chosen — they're alternatives, not extras.
  const wanted = Array.isArray(extras.addOns) ? extras.addOns : [];
  const chosen = addOnsFor(pkg.id).filter((a) => wanted.includes(a.id));
  if (chosen.filter((a) => a.group === 'arcade').length > 1) {
    return { ok: false, error: 'Choose either the 5-Up Arcade Card or the 45-minute Time Play card, not both.' };
  }
  const addOnLines = chosen.map((a) => ({
    id: a.id,
    name: a.name,
    // A per-person add-on multiplies by the guest count; the 5-Up card is paid at the counter.
    cents: a.cents * (a.cents ? n : 0),
    perPersonCents: a.cents,
    payAtCounter: a.cents === 0,
  }));
  const addOnCents = addOnLines.reduce((t, l) => t + l.cents, 0);

  // Extra food. Priced with tax already in, so kept out of the pre-tax total.
  const menu = [...EXTRA_PIZZAS, ...WINGS];
  const foodLines = (Array.isArray(extras.food) ? extras.food : [])
    .map(({ id, qty }) => {
      const item = menu.find((m) => m.id === id);
      const q = Math.max(0, Math.round(Number(qty) || 0));
      return item && q ? { id, name: item.name, qty: q, cents: item.cents * q } : null;
    })
    .filter(Boolean);
  const foodCents = foodLines.reduce((t, l) => t + l.cents, 0);

  return {
    ok: true,
    packageId: pkg.id,
    name: pkg.name,
    guests: n,
    baseCents: pkg.cents,
    extraGuests: extra,
    extraCents: extra * pkg.extraGuestCents,
    packageCents,
    addOns: addOnLines,
    addOnCents,
    food: foodLines,
    foodCents,
    foodIncludesTax: FOOD_PRICES_INCLUDE_TAX,
    // Pre-tax total. Food sits outside it because its prices already include tax.
    totalCents: packageCents + addOnCents,
    dueTodayCents: ARENA.partyDepositCents,
    pizzas: pizzasFor(n),
    splitsForLaserTag: splitsForLaserTag(n),
    roomMinutes: pkg.roomMinutes,
  };
}
