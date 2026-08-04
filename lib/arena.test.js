// Run with:  npm test   (node --test)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARENA, PACKAGES, hoursFor, sessionsFor, sessionSpan, priceBooking, groupNoticeOk,
  priceEventPackage, fmtTime, money, isoDate, parseISO, isPastSession,
  partyRoomSlotsFor, heldGamesFor, gamesInSlot, slotsOverlap, ageCompatible, validAge,
} from './arena.js';

import {
  availabilityFor, addBooking, blockSession, gameSheetFor, statsFor,
  partySlotsFor, addParty, releaseHeldGame, holdGame, isHeld,
} from './demo-store.js';

import { stripeStatus } from './payments.js';

// Reference weekdays used across the party tests, all comfortably in the future so the
// past-session guard never interferes.
const FRI = '2026-11-06';
const SAT = '2026-11-07';
const SUN = '2026-11-08';

// ---------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------

test('regular weekly hours match the published schedule', () => {
  // 2026-07-27 is a Monday.
  assert.deepEqual(hoursFor('2026-07-27'), { open: 720, close: 1260, closed: false, special: false, note: null });
  // Friday runs an hour later.
  const fri = hoursFor('2026-07-24');
  assert.equal(fri.close, 22 * 60);
  // Sunday closes at 7pm.
  const sun = hoursFor('2026-07-26');
  assert.equal(sun.close, 19 * 60);
});

test('special hours beat the weekly pattern', () => {
  const jul30 = hoursFor('2026-07-30');       // Thursday, normally 12pm
  assert.equal(jul30.open, 16 * 60, 'Jul 30 opens at 4pm, not noon');
  assert.equal(jul30.special, true);

  const jul31 = hoursFor('2026-07-31');
  assert.equal(jul31.open, 15 * 60 + 30);
  assert.equal(jul31.close, 22 * 60);
});

test('Aug 3 is closed all day', () => {
  const aug3 = hoursFor('2026-08-03');
  assert.equal(aug3.closed, true);
  assert.equal(aug3.note, 'Closed');
  assert.deepEqual(sessionsFor('2026-08-03'), [], 'a closed day has no game sessions');
});

test('invalid dates are rejected rather than rolled over', () => {
  assert.equal(parseISO('2026-02-31'), null);
  assert.equal(parseISO('not-a-date'), null);
  assert.equal(hoursFor('2026-02-31').closed, true);
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

test('games launch every 15 minutes, last one 30 min before close', () => {
  const s = sessionsFor('2026-07-27');        // Monday 12pm–9pm
  assert.equal(s[0], 12 * 60, 'first game at noon');
  assert.equal(s[1] - s[0], 15, 'spaced 15 minutes apart');
  assert.equal(s[s.length - 1], 21 * 60 - 30, 'last game starts 8:30pm');
  assert.equal(s.length, 35);
});

test('a multi-game booking spans consecutive sessions', () => {
  assert.deepEqual(sessionSpan('2026-07-27', 13 * 60, 3), [780, 795, 810]);
  assert.deepEqual(sessionSpan('2026-07-27', 13 * 60, 1), [780]);
});

test('a booking that would run past closing gets a short span', () => {
  const last = sessionsFor('2026-07-27').at(-1);       // 8:30pm
  assert.equal(sessionSpan('2026-07-27', last, 3).length, 1, 'only one session left before close');
});

// ---------------------------------------------------------------------------
// Games that already started
// ---------------------------------------------------------------------------

test("today's earlier games are past, later ones are not", () => {
  const now = new Date(2026, 6, 27, 18, 5);                  // Mon Jul 27, 6:05pm
  assert.equal(isPastSession('2026-07-27', 12 * 60, now), true,  'noon has gone');
  assert.equal(isPastSession('2026-07-27', 18 * 60, now), true,  '6:00pm has gone');
  assert.equal(isPastSession('2026-07-27', 18 * 60 + 15, now), false, '6:15pm is still bookable');
  assert.equal(isPastSession('2026-07-28', 12 * 60, now), false, "tomorrow's noon game is fine");
});

test('a game that already started cannot be booked online', () => {
  const past = '2020-01-02';                                  // long gone
  const r = addBooking({ dateISO: past, startMin: 12 * 60, games: 1, players: 4 });
  assert.equal(r.ok, false);
  assert.match(r.error, /already started/);
});

test('but staff can still record a walk-in into a game underway', () => {
  const past = '2020-01-03';
  const r = addBooking({ dateISO: past, startMin: 12 * 60, games: 1, players: 4, kind: 'walkin', allowPast: true });
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

test('per-person package prices match the published rates', () => {
  assert.deepEqual(PACKAGES.map((p) => p.cents), [849, 1549, 2149]);
  assert.equal(priceBooking({ players: 1 + 1, games: 1 }).totalCents, 1698);
});

test('4 players x 2 games = $61.96', () => {
  const p = priceBooking({ players: 4, games: 2 });
  assert.equal(p.ok, true);
  assert.equal(p.perPersonCents, 1549);
  assert.equal(p.totalCents, 6196);
  assert.equal(money(p.totalCents), '$61.96');
});

test('a game needs at least 2 players', () => {
  const p = priceBooking({ players: 1, games: 1 });
  assert.equal(p.ok, false);
  assert.match(p.error, /at least 2 players/);
});

test('a booking cannot exceed arena capacity', () => {
  const p = priceBooking({ players: 26, games: 1 });
  assert.equal(p.ok, false);
  assert.match(p.error, /holds 25 players/);
});

test('only 1, 2 or 3 games can be bought', () => {
  assert.equal(priceBooking({ players: 4, games: 4 }).ok, false);
  assert.equal(priceBooking({ players: 4, games: 0 }).ok, false);
});

test('12+ players is flagged as a group, and no discount is invented', () => {
  const p = priceBooking({ players: 12, games: 1 });
  assert.equal(p.group, true);
  assert.equal(p.discountCents, 0, 'group discount stays 0 until Lasertopia gives us the real rate');
  assert.equal(p.totalCents, 849 * 12);
  assert.equal(priceBooking({ players: 11, games: 1 }).group, false);
});

// ---------------------------------------------------------------------------
// Group 24-hour notice
// ---------------------------------------------------------------------------

test('a group inside 24 hours is blocked with the shop phone number', () => {
  const now = new Date(2026, 6, 27, 18, 0);                  // Mon Jul 27, 6pm
  // Tuesday 1pm is only 19 hours away — not enough notice for 14 players.
  const r = groupNoticeOk({ dateISO: '2026-07-28', startMin: 13 * 60, players: 14 }, now);
  assert.equal(r.ok, false);
  assert.match(r.error, /24 hours notice/);
  assert.match(r.error, /204-474-5900/);
});

test('the group notice boundary is exactly 24 hours', () => {
  const now = new Date(2026, 6, 27, 13, 0);                  // Mon Jul 27, 1pm
  // Tuesday 1pm is exactly 24 hours out — allowed.
  assert.equal(groupNoticeOk({ dateISO: '2026-07-28', startMin: 13 * 60, players: 14 }, now).ok, true);
  // One session earlier (12:45pm) is 23h45m — refused.
  assert.equal(groupNoticeOk({ dateISO: '2026-07-28', startMin: 12 * 60 + 45, players: 14 }, now).ok, false);
});

test('the same group books fine with more notice', () => {
  const now = new Date(2026, 6, 27, 12, 0);
  assert.equal(groupNoticeOk({ dateISO: '2026-07-31', startMin: 18 * 60, players: 14 }, now).ok, true);
});

test('small parties are never subject to the group notice rule', () => {
  const now = new Date(2026, 6, 27, 12, 0);
  assert.equal(groupNoticeOk({ dateISO: '2026-07-27', startMin: 13 * 60, players: 4 }, now).ok, true);
});

// ---------------------------------------------------------------------------
// Event packages
// ---------------------------------------------------------------------------

test('event packages price extra guests above the base 10', () => {
  const base = priceEventPackage('great-adventure', 10);
  assert.equal(base.totalCents, 25950);
  assert.equal(base.extraGuests, 0);

  const bigger = priceEventPackage('great-adventure', 14);
  assert.equal(bigger.extraGuests, 4);
  assert.equal(bigger.totalCents, 25950 + 4 * 2595);
  assert.equal(money(bigger.totalCents), '$363.30');
});

test('unknown packages and oversized parties are refused clearly', () => {
  assert.equal(priceEventPackage('nope', 10).ok, false);
  assert.match(priceEventPackage('traveler', 30).error, /call us/);
});

// ---------------------------------------------------------------------------
// Capacity, via the demo store
// ---------------------------------------------------------------------------

const D = '2026-09-15';    // a quiet future Tuesday, isolated from other tests

test('booking players removes seats from every session in the span', () => {
  const before = availabilityFor(D);
  const slot = before.find((s) => s.seatsLeft >= 10);
  const i = before.indexOf(slot);

  const r = addBooking({ dateISO: D, startMin: slot.startMin, games: 2, players: 4, name: 'Test Group', totalCents: 12392 });
  assert.equal(r.ok, true);

  const after = availabilityFor(D);
  assert.equal(after[i].seatsLeft, before[i].seatsLeft - 4, 'first game loses 4 seats');
  assert.equal(after[i + 1].seatsLeft, before[i + 1].seatsLeft - 4, 'second game loses 4 seats too');
  assert.equal(after[i + 2].seatsLeft, before[i + 2].seatsLeft, 'third game untouched');
});

test('a full game refuses further bookings', () => {
  const D2 = '2026-09-16';
  const slot = availabilityFor(D2).find((s) => s.seatsLeft === ARENA.capacity);
  // Fill it exactly.
  assert.equal(addBooking({ dateISO: D2, startMin: slot.startMin, games: 1, players: 25, name: 'Full House' }).ok, true);
  assert.equal(availabilityFor(D2).find((s) => s.startMin === slot.startMin).seatsLeft, 0);

  const overflow = addBooking({ dateISO: D2, startMin: slot.startMin, games: 1, players: 2, name: 'Too Late' });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.status, 409);
  assert.match(overflow.error, /just filled up/);
});

test('a blocked session is closed to everyone', () => {
  const D3 = '2026-09-17';
  const slot = availabilityFor(D3).find((s) => s.seatsLeft === ARENA.capacity);
  assert.equal(blockSession(D3, slot.startMin, 'Private hire').ok, true);

  const after = availabilityFor(D3).find((s) => s.startMin === slot.startMin);
  assert.equal(after.blocked, true);
  assert.equal(after.seatsLeft, 0);
  assert.equal(addBooking({ dateISO: D3, startMin: slot.startMin, games: 1, players: 2 }).ok, false);
});

test('bookings off the schedule are refused', () => {
  const r = addBooking({ dateISO: D, startMin: 3 * 60, games: 1, players: 4 });   // 3am
  assert.equal(r.ok, false);
  assert.match(r.error, /isn't on the schedule/);
});

test('the staff sheet shows mid-run groups, not just the games they started in', () => {
  const D4 = '2026-09-18';
  const first = availabilityFor(D4)[0];
  addBooking({ dateISO: D4, startMin: first.startMin, games: 3, players: 5, name: 'Three Gamers', totalCents: 10745 });

  const sheet = gameSheetFor(D4);
  const inSecond = sheet[1].bookings.find((b) => b.name === 'Three Gamers');
  assert.ok(inSecond, 'the group appears in their second game');
  assert.equal(inSecond.startsHere, false, 'and is marked as mid-run, not a new arrival');
  assert.equal(sheet[0].bookings.find((b) => b.name === 'Three Gamers').startsHere, true);
});

test('the same date always seeds the same arena', () => {
  const a = availabilityFor('2026-10-01').map((s) => s.taken);
  const b = availabilityFor('2026-10-01').map((s) => s.taken);
  assert.deepEqual(a, b);
});

test('stats add up for the staff dashboard', () => {
  const s = statsFor(D);
  assert.equal(s.totalSessions, sessionsFor(D).length);
  assert.ok(s.playersExpected > 0);
  assert.ok(s.revenueCents > 0);
});

// ---------------------------------------------------------------------------
// Party-held game times  (Shannon's email)
// ---------------------------------------------------------------------------

test('held game times match the email, per weekday', () => {
  assert.deepEqual(heldGamesFor(FRI), [17 * 60 + 15, 17 * 60 + 30, 18 * 60 + 15, 18 * 60 + 45]);
  assert.deepEqual(heldGamesFor(SAT).map(fmtTime), ['1:15pm', '1:45pm', '3:15pm', '3:45pm', '5:15pm', '5:45pm']);
  assert.deepEqual(heldGamesFor(SUN).map(fmtTime), ['1:15pm', '1:45pm', '3:00pm', '3:15pm', '4:15pm', '4:45pm']);
});

test('a held game is not publicly bookable, but its neighbour is', () => {
  const held = addBooking({ dateISO: FRI, startMin: 17 * 60 + 15, games: 1, players: 4, name: 'Nope' });
  assert.equal(held.ok, false);
  assert.match(held.error, /reserved for birthday parties/);

  // 5:45pm is not on the held list, so it stays open — this is a targeted hold, not a blanket one.
  assert.equal(addBooking({ dateISO: FRI, startMin: 17 * 60 + 45, games: 1, players: 4, name: 'Fine' }).ok, true);
});

test('a multi-game run cannot swallow a held game', () => {
  // 5:00pm + 3 games would cover 5:00, 5:15, 5:30 — the last two are held.
  const r = addBooking({ dateISO: FRI, startMin: 17 * 60, games: 3, players: 4, name: 'Sneaky' });
  assert.equal(r.ok, false);
  assert.match(r.error, /reserved for birthday parties/);
  // The same start with a single game is fine.
  assert.equal(addBooking({ dateISO: FRI, startMin: 17 * 60, games: 1, players: 4, name: 'Fine' }).ok, true);
});

test('staff can release a held game to the public, and take it back', () => {
  const D = '2026-11-13';                       // another Friday
  const t = 18 * 60 + 15;
  assert.equal(isHeld(D, t), true);
  assert.equal(availabilityFor(D).find((s) => s.startMin === t).held, true);

  assert.equal(releaseHeldGame(D, t).ok, true);
  assert.equal(isHeld(D, t), false);
  assert.equal(addBooking({ dateISO: D, startMin: t, games: 1, players: 4, name: 'Released' }).ok, true);

  // And the desk can pull a normally-public time off the grid for a party.
  const spare = 19 * 60;
  assert.equal(isHeld(D, spare), false);
  assert.equal(holdGame(D, spare).ok, true);
  assert.equal(addBooking({ dateISO: D, startMin: spare, games: 1, players: 4, name: 'Too late' }).ok, false);
});

test('staff walk-ins can still be seated in a held game', () => {
  const D = '2026-11-20';
  const r = addBooking({ dateISO: D, startMin: 17 * 60 + 15, games: 1, players: 4, kind: 'walkin', allowHeld: true });
  assert.equal(r.ok, true);
});

test('the seeder never puts walk-ins into party-held times', () => {
  for (const d of ['2026-11-27', '2026-11-28', '2026-11-29']) {
    const held = new Set(heldGamesFor(d));
    for (const s of gameSheetFor(d)) {
      if (!held.has(s.startMin)) continue;
      // Parties are exactly who these slots are for — anything else is the bug.
      const intruders = s.bookings.filter((b) => b.kind !== 'party');
      assert.deepEqual(intruders, [], `${d} ${fmtTime(s.startMin)} is held but has non-party bookings`);
    }
  }
});

// ---------------------------------------------------------------------------
// Party room slots
// ---------------------------------------------------------------------------

test('room slots match the email, per weekday', () => {
  assert.deepEqual(partyRoomSlotsFor(FRI).map((s) => `${fmtTime(s.start)}-${fmtTime(s.end)}`),
    ['5:00pm-7:00pm', '6:00pm-8:00pm']);
  assert.equal(partyRoomSlotsFor(SAT).length, 5);
  assert.equal(partyRoomSlotsFor(SUN).length, 5);
});

test('weekend parties can start at 10am even though public games start at noon', () => {
  const morning = partyRoomSlotsFor(SAT)[0];
  assert.equal(morning.start, 10 * 60, 'Saturday parties open at 10am');
  assert.equal(sessionsFor(SAT)[0], 12 * 60, 'public laser tag still starts at noon');
});

test('a party plays the held games inside its slot', () => {
  assert.deepEqual(gamesInSlot(FRI, 17 * 60).map(fmtTime), ['5:15pm', '5:30pm']);
  assert.deepEqual(gamesInSlot(FRI, 18 * 60).map(fmtTime), ['6:15pm', '6:45pm']);
  // Saturday mornings have no held games in Shannon's list — see the README note.
  assert.deepEqual(gamesInSlot(SAT, 10 * 60), []);
});

test('a closed day has no party slots', () => {
  assert.deepEqual(partyRoomSlotsFor('2026-08-03'), []);
});

test('slot overlap detection', () => {
  assert.equal(slotsOverlap({ start: 17 * 60, end: 19 * 60 }, { start: 18 * 60, end: 20 * 60 }), true);
  assert.equal(slotsOverlap({ start: 17 * 60, end: 19 * 60 }, { start: 19 * 60, end: 21 * 60 }), false);
});

// ---------------------------------------------------------------------------
// Two parties per slot, matched by age
// ---------------------------------------------------------------------------

test('ages within 2 years can share a slot', () => {
  assert.equal(ageCompatible(7, 9), true);
  assert.equal(ageCompatible(7, 5), true);
  assert.equal(ageCompatible(7, 10), false);
  assert.equal(ageCompatible(12, 7), false);
});

test('age input is validated', () => {
  assert.equal(validAge(8), true);
  assert.equal(validAge(0), false);
  assert.equal(validAge('abc'), false);
});

/**
 * Find a date whose party board has a completely empty slot, so a test can build the exact
 * state it needs instead of inheriting whatever the seeder happened to place. Walks forward
 * from a start date; every 7th day keeps the same weekday.
 */
function emptySlotDate(fromISO, slotStart) {
  const d = parseISO(fromISO);
  for (let i = 0; i < 20; i++) {
    const iso = isoDate(d);
    const slot = partySlotsFor(iso).find((s) => s.start === slotStart);
    if (slot && slot.parties.length === 0 && slot.spotsLeft === ARENA.partiesPerSlot) return iso;
    d.setDate(d.getDate() + 7);
  }
  throw new Error('no empty party slot found to test against');
}

test('a second party joins if the ages match, and is refused if they do not', () => {
  const slot = 17 * 60;
  const D = emptySlotDate('2026-12-04', slot);          // a Friday with 5-7 free

  assert.equal(addParty({ dateISO: D, slotStart: slot, age: 7, guests: 10, name: "Ella's party", packageId: 'traveler' }).ok, true);

  const tooOld = addParty({ dateISO: D, slotStart: slot, age: 13, guests: 10, name: 'Mismatch' });
  assert.equal(tooOld.ok, false);
  assert.match(tooOld.error, /within 2 years/);

  const fits = addParty({ dateISO: D, slotStart: slot, age: 9, guests: 10, name: 'Good match' });
  assert.equal(fits.ok, true, fits.error);
});

test('staff can override the age rule', () => {
  const slot = 17 * 60;
  const D = emptySlotDate('2027-02-05', slot);

  assert.equal(addParty({ dateISO: D, slotStart: slot, age: 6, guests: 10, name: 'First' }).ok, true);

  const refused = addParty({ dateISO: D, slotStart: slot, age: 14, guests: 10, name: 'No' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /within 2 years/);

  const forced = addParty({ dateISO: D, slotStart: slot, age: 14, guests: 10, name: 'Yes', override: true });
  assert.equal(forced.ok, true, forced.error);
  assert.equal(forced.booking.ageOverride, true, 'the override is recorded on the booking');
});

test('an override still cannot oversell the building', () => {
  const slot = 17 * 60;
  const D = emptySlotDate('2027-03-05', slot);
  assert.equal(addParty({ dateISO: D, slotStart: slot, age: 8, guests: 10, name: 'A' }).ok, true);
  assert.equal(addParty({ dateISO: D, slotStart: slot, age: 8, guests: 10, name: 'B' }).ok, true);

  const third = addParty({ dateISO: D, slotStart: slot, age: 8, guests: 10, name: 'C', override: true });
  assert.equal(third.ok, false, 'override bypasses the age rule, never the capacity rule');
  assert.match(third.error, /fully booked|maximum number/);
});

test('filling 5-7 takes the overlapping 6-8 slot off the board', () => {
  const D = '2026-12-18';                       // Friday
  const FIVE = 17 * 60, SIX = 18 * 60;

  // Top 5–7 up to the building cap, matching whatever age the seeder may already have put
  // there so the age rule doesn't get in the way of testing the capacity rule.
  const seededAge = partySlotsFor(D).find((s) => s.start === FIVE).ages[0];
  const age = seededAge ?? 8;
  while (partySlotsFor(D).find((s) => s.start === FIVE).spotsLeft > 0) {
    const r = addParty({ dateISO: D, slotStart: FIVE, age, guests: 10, name: 'Filler' });
    assert.equal(r.ok, true, r.error);
  }

  const six = partySlotsFor(D).find((s) => s.start === SIX);
  assert.equal(six.spotsLeft, 0, '6-8 overlaps a full building, so it is unavailable');
  assert.equal(six.available, false);
  assert.match(six.reason, /maximum number of parties/);

  const rejected = addParty({ dateISO: D, slotStart: SIX, age, guests: 10, name: 'Overflow' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 409);
});

test('the party board reports spots, ages and the games each slot plays', () => {
  const D = '2026-12-25';
  const board = partySlotsFor(D);
  assert.ok(board.length > 0);
  for (const s of board) {
    assert.ok(s.spotsLeft <= ARENA.partiesPerSlot);
    assert.ok(Array.isArray(s.games));
    assert.equal(typeof s.available, 'boolean');
  }
});

test('an unknown slot time is refused', () => {
  const r = addParty({ dateISO: FRI, slotStart: 9 * 60, age: 8, guests: 10, name: 'Nope' });
  assert.equal(r.ok, false);
  assert.match(r.error, /isn't one we run/);
});

test('asking the board with an age marks mismatched slots unavailable', () => {
  const slot = 17 * 60;
  const D = emptySlotDate('2027-01-08', slot);
  assert.equal(addParty({ dateISO: D, slotStart: slot, age: 6, guests: 10, name: 'Six' }).ok, true);

  const forTeen = partySlotsFor(D, 15).find((s) => s.start === slot);
  assert.equal(forTeen.available, false);
  assert.match(forTeen.reason, /6-year-old/);

  const forEight = partySlotsFor(D, 8).find((s) => s.start === slot);
  assert.equal(forEight.ageFits, true);
  assert.equal(forEight.available, true);
});

// ---------------------------------------------------------------------------
// Stripe key handling
// ---------------------------------------------------------------------------

test('no keys means simulated checkout, not an error', () => {
  const s = stripeStatus({});
  assert.equal(s.enabled, false);
  assert.equal(s.problem, null, 'an unconfigured demo is a valid state');
});

test('LIVE keys are refused outright', () => {
  const s = stripeStatus({ STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_PUBLISHABLE_KEY: 'pk_live_abc' });
  assert.equal(s.enabled, false);
  assert.match(s.problem, /LIVE/);
  // A live secret with a test publishable is still refused.
  assert.equal(stripeStatus({ STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_PUBLISHABLE_KEY: 'pk_test_abc' }).enabled, false);
});

test('half-configured Stripe is refused with a clear reason', () => {
  const s = stripeStatus({ STRIPE_SECRET_KEY: 'sk_test_abc' });
  assert.equal(s.enabled, false);
  assert.match(s.problem, /both/i);
});

test('mixed-up keys are caught', () => {
  // Publishable pasted into the secret slot.
  assert.match(stripeStatus({ STRIPE_SECRET_KEY: 'pk_test_abc', STRIPE_PUBLISHABLE_KEY: 'pk_test_abc' }).problem, /STRIPE_SECRET_KEY/);
  // Secret pasted into the publishable slot.
  assert.match(stripeStatus({ STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_PUBLISHABLE_KEY: 'sk_test_abc' }).problem, /STRIPE_PUBLISHABLE_KEY/);
});

test('valid test keys enable cards, and only the publishable one is exposed', () => {
  const s = stripeStatus({ STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_PUBLISHABLE_KEY: 'pk_test_xyz' });
  assert.equal(s.enabled, true);
  assert.equal(s.publishableKey, 'pk_test_xyz');
  assert.equal(s.problem, null);
  // Restricted keys are fine too — they're the safer choice for a prototype.
  assert.equal(stripeStatus({ STRIPE_SECRET_KEY: 'rk_test_abc', STRIPE_PUBLISHABLE_KEY: 'pk_test_xyz' }).enabled, true);
});

test('the charge amount comes from the server, never the browser', () => {
  // Whatever a tampered request claims, the price is rebuilt from players and games.
  const priced = priceBooking({ players: 4, games: 2 });
  assert.equal(priced.totalCents, 6196);
  // There is no code path that accepts a client-supplied total: priceBooking takes only
  // players and games, so a forged "totalCents" has nothing to attach to.
  assert.equal(priceBooking({ players: 4, games: 2, totalCents: 1 }).totalCents, 6196);
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test('times and money format the way the pages display them', () => {
  assert.equal(fmtTime(12 * 60), '12:00pm');
  assert.equal(fmtTime(15 * 60 + 30), '3:30pm');
  assert.equal(fmtTime(21 * 60), '9:00pm');
  assert.equal(money(849), '$8.49');
  assert.equal(money(2149), '$21.49');
  // Revenue figures on the staff dashboard get into the thousands.
  assert.equal(money(751368), '$7,513.68');
  assert.equal(money(123456789), '$1,234,567.89');
  assert.equal(money(0), '$0.00');
});

test('isoDate uses local time, not UTC', () => {
  assert.equal(isoDate(new Date(2026, 6, 27)), '2026-07-27');
  assert.equal(isoDate(new Date(2026, 0, 1)), '2026-01-01');
});
