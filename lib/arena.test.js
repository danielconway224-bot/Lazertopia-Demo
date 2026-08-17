// Run with:  npm test   (node --test)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARENA, PACKAGES, hoursFor, sessionsFor, sessionSpan, priceBooking, groupNoticeOk,
  priceEventPackage, fmtTime, money, isoDate, parseISO, isPastSession,
  partyRoomSlotsFor, heldGamesFor, gamesInSlot, slotsOverlap, ageCompatible, validAge,
  arenaNow, arenaToday, TIMEZONE,
  roomFit, roomsFreeIn, maxGuestsIn, splitsForLaserTag, isBookableOnline,
  pizzasFor, addOnsFor,
} from './arena.js';

import {
  availabilityFor, addBooking, blockSession, gameSheetFor, statsFor,
  partySlotsFor, addParty, releaseHeldGame, holdGame, isHeld,
} from './demo-store.js';

import { stripeStatus } from './payments.js';
import { safeOrigin } from './api-app.js';
import {
  messagingStatus, toE164, bookingSmsBody, reminderSmsBody,
  sendBookingConfirmation, getOutbox, clearOutbox,
} from './messaging.js';

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

// ---------------------------------------------------------------------------
// Winnipeg time
//
// The bug these guard against: Vercel runs in UTC, five hours ahead of Winnipeg in
// summer. Judging "has this game started" on the server's clock greyed out every game
// before ~6pm while it was still lunchtime at the arena.
// ---------------------------------------------------------------------------

test('the arena clock is Winnipeg, whatever the machine is set to', () => {
  // 18:19 UTC on 4 Aug 2026 is 13:19 in Winnipeg (CDT, UTC-5).
  const utcEvening = new Date('2026-08-04T18:19:00Z');
  const n = arenaNow(utcEvening);
  assert.equal(n.dateISO, '2026-08-04');
  assert.equal(n.minutes, 13 * 60 + 19, 'should read 1:19pm, not 6:19pm');
});

test('a UTC server does not grey out the afternoon', () => {
  const utcEvening = new Date('2026-08-04T18:19:00Z');   // 1:19pm in Winnipeg
  // Games from 1:30pm onward are still to come.
  assert.equal(isPastSession('2026-08-04', 13 * 60 + 30, utcEvening), false, '1:30pm is still bookable');
  assert.equal(isPastSession('2026-08-04', 17 * 60, utcEvening), false, '5:00pm is still bookable');
  assert.equal(isPastSession('2026-08-04', 20 * 60, utcEvening), false, '8:00pm is still bookable');
  // And the ones that really have gone are still marked gone.
  assert.equal(isPastSession('2026-08-04', 12 * 60, utcEvening), true, 'noon has genuinely passed');
});

test('after midnight UTC it is still the same evening in Winnipeg', () => {
  // 02:30 UTC on 5 Aug is 21:30 on 4 Aug in Winnipeg — the arena is still open.
  const afterUtcMidnight = new Date('2026-08-05T02:30:00Z');
  const n = arenaNow(afterUtcMidnight);
  assert.equal(n.dateISO, '2026-08-04', "still yesterday's date at the arena");
  assert.equal(arenaToday(afterUtcMidnight), '2026-08-04');
  assert.equal(isPastSession('2026-08-04', 20 * 60, afterUtcMidnight), true, '8pm has passed by 9:30pm');
});

test('winter switches to CST without any code change', () => {
  // 18:19 UTC in January is 12:19 in Winnipeg (CST, UTC-6).
  const winter = new Date('2027-01-14T18:19:00Z');
  assert.equal(arenaNow(winter).minutes, 12 * 60 + 19);
});

test('the group notice rule is measured on the arena clock too', () => {
  const utcEvening = new Date('2026-08-04T18:19:00Z');   // 1:19pm Winnipeg, Tuesday
  // Wednesday 1pm is 23h41m away — inside the 24-hour window.
  assert.equal(groupNoticeOk({ dateISO: '2026-08-05', startMin: 13 * 60, players: 14 }, utcEvening).ok, false);
  // Wednesday 2pm is 24h41m away — fine.
  assert.equal(groupNoticeOk({ dateISO: '2026-08-05', startMin: 14 * 60, players: 14 }, utcEvening).ok, true);
});

test("today's earlier games are past, later ones are not", () => {
  const now = new Date('2026-07-27T23:05:00Z');              // Mon Jul 27, 6:05pm in Winnipeg
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
  const now = new Date('2026-07-27T23:00:00Z');              // Mon Jul 27, 6pm in Winnipeg
  // Tuesday 1pm is only 19 hours away — not enough notice for 14 players.
  const r = groupNoticeOk({ dateISO: '2026-07-28', startMin: 13 * 60, players: 14 }, now);
  assert.equal(r.ok, false);
  assert.match(r.error, /24 hours notice/);
  assert.match(r.error, /204-474-5900/);
});

test('the group notice boundary is exactly 24 hours', () => {
  const now = new Date('2026-07-27T18:00:00Z');              // Mon Jul 27, 1pm in Winnipeg
  // Tuesday 1pm is exactly 24 hours out — allowed.
  assert.equal(groupNoticeOk({ dateISO: '2026-07-28', startMin: 13 * 60, players: 14 }, now).ok, true);
  // One session earlier (12:45pm) is 23h45m — refused.
  assert.equal(groupNoticeOk({ dateISO: '2026-07-28', startMin: 12 * 60 + 45, players: 14 }, now).ok, false);
});

test('the same group books fine with more notice', () => {
  const now = new Date('2026-07-27T17:00:00Z');   // noon in Winnipeg
  assert.equal(groupNoticeOk({ dateISO: '2026-07-31', startMin: 18 * 60, players: 14 }, now).ok, true);
});

test('small parties are never subject to the group notice rule', () => {
  const now = new Date('2026-07-27T17:00:00Z');   // noon in Winnipeg
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

test('a party plays the games attached to its slot', () => {
  assert.deepEqual(gamesInSlot(FRI, 17 * 60).map(fmtTime), ['5:15pm', '5:30pm']);
  assert.deepEqual(gamesInSlot(FRI, 18 * 60).map(fmtTime), ['6:15pm', '6:45pm']);
  assert.deepEqual(gamesInSlot(SAT, 13 * 60).map(fmtTime), ['1:15pm', '1:45pm']);
  // The 11-1 slot is the one gap left in the schedule — empty rather than guessed.
  assert.deepEqual(gamesInSlot(SAT, 11 * 60), []);
});

test('weekend morning parties play before the doors open, so nothing is "held"', () => {
  assert.deepEqual(gamesInSlot(SAT, 10 * 60).map(fmtTime),
    ['10:15am', '10:30am', '10:45am', '11:00am']);
  assert.deepEqual(gamesInSlot(SUN, 10 * 60).map(fmtTime),
    ['10:15am', '10:30am', '10:45am', '11:00am']);

  // Public laser tag still starts at noon, so those four are not public sessions at all —
  // and therefore can't appear on the held list, which only withholds real sessions.
  assert.equal(sessionsFor(SAT)[0], 12 * 60);
  for (const m of [10 * 60 + 15, 10 * 60 + 30, 10 * 60 + 45, 11 * 60]) {
    assert.ok(!sessionsFor(SAT).includes(m), `${fmtTime(m)} is not a public session`);
    assert.ok(!heldGamesFor(SAT).includes(m), `${fmtTime(m)} should not be on the held list`);
  }
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
    if (slot && slot.parties.length === 0 && slot.spotsLeft === slot.capacity) return iso;
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
    assert.ok(s.spotsLeft <= s.capacity, 'never reports more free rooms than the slot has');
    assert.equal(s.capacity, s.rooms.length);
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
// Party rooms — capacity by guest count
// ---------------------------------------------------------------------------

test('a party takes the smallest room that holds it', () => {
  const [fiveToSeven] = partyRoomSlotsFor(FRI);            // rooms [14, 14]
  assert.deepEqual(fiveToSeven.rooms, [14, 14]);

  const small = roomFit(fiveToSeven, 10);
  assert.equal(small.positions, 1);
  assert.deepEqual(small.rooms, [14]);

  // 15 doesn't fit one 14-guest room, so it takes both and is capped at the slot's 20.
  const big = roomFit(fiveToSeven, 15);
  assert.equal(big.positions, 2);
  assert.equal(big.capacity, 20);

  assert.equal(roomFit(fiveToSeven, 21).ok, false, 'over the combined figure');
});

test('best fit leaves the larger room free for a larger party', () => {
  const sixToEight = partyRoomSlotsFor(FRI)[1];            // rooms [12, 14]
  assert.deepEqual(sixToEight.rooms, [12, 14]);
  // A party of 11 fits the 12, so the 14 stays open rather than being burned.
  assert.deepEqual(roomFit(sixToEight, 11).rooms, [12]);
  // A party of 13 needs the 14.
  assert.deepEqual(roomFit(sixToEight, 13).rooms, [14]);
  // 15 takes both, capped at this slot's 18 rather than the 20 the 5-7 slot allows.
  assert.equal(roomFit(sixToEight, 15).capacity, 18);
  assert.equal(roomFit(sixToEight, 19).ok, false);
});

test('booking a room removes it from what is left', () => {
  const slot = partyRoomSlotsFor(FRI)[0];
  const free = roomsFreeIn(slot, [{ rooms: [14], positions: 1 }]);
  assert.deepEqual(free, [14], 'one 14-guest room still open');
  assert.equal(maxGuestsIn(slot, free), 14, 'and no room for a 15-guest party any more');
  assert.equal(roomFit(slot, 15, free).ok, false);
});

test('the weekend morning slot has a third, larger room', () => {
  const morning = partyRoomSlotsFor(SAT)[0];
  assert.deepEqual(morning.rooms, [14, 14, 18]);
  assert.equal(morning.rooms.length, 3, 'three parties can run at once');
  // The 18-guest room takes a party the other two can't.
  assert.deepEqual(roomFit(morning, 16).rooms, [18]);
});

test('a party too big for the rooms left is refused with the real number', () => {
  const D = emptySlotDate('2027-04-02', 17 * 60);          // a Friday with 5-7 free
  assert.equal(addParty({ dateISO: D, slotStart: 17 * 60, age: 8, guests: 12, name: 'First' }).ok, true);

  const tooBig = addParty({ dateISO: D, slotStart: 17 * 60, age: 8, guests: 16, name: 'Too big' });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error, /hold up to 14 guests/);
});

test('parties over 20 are sent to the phone rather than booked online', () => {
  assert.equal(priceEventPackage('traveler', 20).ok, true);
  const big = priceEventPackage('traveler', 21);
  assert.equal(big.ok, false);
  assert.match(big.error, /booked by phone/);
  assert.match(big.error, /204-474-5900/);
});

test('a party above the arena capacity is flagged to split', () => {
  assert.equal(splitsForLaserTag(25), false);
  assert.equal(splitsForLaserTag(26), true, 'the arena only holds 25 at once');
});

// ---------------------------------------------------------------------------
// Package extras
// ---------------------------------------------------------------------------

test('pizza count follows the guest count, with no gaps', () => {
  assert.equal(pizzasFor(10), 2);
  assert.equal(pizzasFor(11), 2, 'the band that was previously unassigned');
  assert.equal(pizzasFor(12), 3);
  assert.equal(pizzasFor(15), 3);
  assert.equal(pizzasFor(16), 4);
  assert.equal(pizzasFor(20), 4, '20 resolves to one answer, not two');
  assert.equal(pizzasFor(21), 5);
  assert.equal(pizzasFor(25), 5, 'and so does 25');
  assert.equal(pizzasFor(28), 6);
});

test('Q-BIX is available on every package, the arcade cards are not', () => {
  const all = addOnsFor('around-the-world').map((a) => a.id);
  assert.deepEqual(all, ['qbix'], 'Around The World gets Q-BIX only');
  const traveler = addOnsFor('traveler').map((a) => a.id);
  assert.deepEqual(traveler, ['qbix', 'arcade-5up', 'arcade-time']);
});

test('add-ons are charged per person on top of the package', () => {
  const p = priceEventPackage('great-adventure', 12, { addOns: ['qbix'] });
  assert.equal(p.ok, true);
  assert.equal(p.packageCents, 25950 + 2 * 2595, '2 extra guests above the base 10');
  assert.equal(p.addOnCents, 12 * 395, 'Q-BIX is per person');
  assert.equal(p.totalCents, p.packageCents + p.addOnCents);
  assert.equal(p.pizzas, 3, '12 guests earns a third pizza');
});

test('the two arcade cards are alternatives, not extras', () => {
  const both = priceEventPackage('traveler', 10, { addOns: ['arcade-5up', 'arcade-time'] });
  assert.equal(both.ok, false);
  assert.match(both.error, /either the 5-Up|not both/);

  // The 5-Up card is paid at the counter, so it adds nothing to the quoted total.
  const fiveUp = priceEventPackage('traveler', 10, { addOns: ['arcade-5up'] });
  assert.equal(fiveUp.addOnCents, 0);
  assert.equal(fiveUp.addOns[0].payAtCounter, true);

  // Time Play is a flat $5 a guest and can be totalled up front.
  const timePlay = priceEventPackage('traveler', 10, { addOns: ['arcade-time'] });
  assert.equal(timePlay.addOnCents, 10 * 500);
});

test('extra food is totalled apart from the package, because its prices include tax', () => {
  const p = priceEventPackage('traveler', 10, {
    food: [{ id: 'one-topping', qty: 2 }, { id: 'wings-16', qty: 1 }],
  });
  assert.equal(p.foodCents, 2 * 2463 + 1903);
  assert.equal(money(p.foodCents), '$68.29');
  assert.equal(p.foodIncludesTax, true);
  assert.equal(p.totalCents, 22450, 'food stays out of the pre-tax total');
});

test('every party carries the same non-refundable deposit', () => {
  assert.equal(money(ARENA.partyDepositCents), '$50.00');
  for (const guests of [10, 14, 20]) {
    for (const id of ['traveler', 'great-adventure', 'around-the-world']) {
      const p = priceEventPackage(id, guests);
      assert.equal(p.ok, true, p.error);
      assert.equal(p.dueTodayCents, ARENA.partyDepositCents, `${id} @ ${guests}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The 90-minute online cutoff
// ---------------------------------------------------------------------------

test('online booking closes 90 minutes before a game starts', () => {
  const now = new Date('2026-07-27T23:00:00Z');            // Mon Jul 27, 6:00pm in Winnipeg
  assert.equal(isBookableOnline('2026-07-27', 19 * 60 + 30, now), true, '7:30pm is exactly 90 min away');
  assert.equal(isBookableOnline('2026-07-27', 19 * 60 + 15, now), false, '7:15pm is only 75 min away');
  assert.equal(isBookableOnline('2026-07-27', 20 * 60, now), true, '8:00pm is fine');
  assert.equal(isBookableOnline('2026-07-28', 12 * 60, now), true, "tomorrow's noon game is fine");
});

test('the cutoff refuses a public booking but not a walk-in', () => {
  // A game that has not started but is inside the window.
  const D = '2020-01-04';        // long past, so every game is inside the cutoff
  const pub = addBooking({ dateISO: D, startMin: 13 * 60, games: 1, players: 4, name: 'Nope' });
  assert.equal(pub.ok, false);

  const desk = addBooking({
    dateISO: D, startMin: 13 * 60, games: 1, players: 4,
    name: 'Walk-in', kind: 'walkin', allowPast: true,
  });
  assert.equal(desk.ok, true, 'the front desk is exempt');
});

test('a cut-off game is marked, not hidden', () => {
  const rows = availabilityFor('2026-07-27');
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(typeof r.cutoff, 'boolean');
    if (r.cutoff) assert.equal(r.past, false, 'cutoff and past are different states');
  }
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

test('Stripe is sent back to our own host, never a caller-supplied one', () => {
  const req = { protocol: 'https', headers: { host: 'lazertopia-voltris-demo.vercel.app' } };

  // An attacker-chosen return URL must be ignored — otherwise a paying customer could be
  // bounced to a lookalike site straight after entering their card.
  assert.equal(safeOrigin('https://evil.example.com', req), 'https://lazertopia-voltris-demo.vercel.app');
  assert.equal(safeOrigin('//evil.example.com', req), 'https://lazertopia-voltris-demo.vercel.app');
  assert.equal(safeOrigin('javascript:alert(1)', req), 'https://lazertopia-voltris-demo.vercel.app');
  assert.equal(safeOrigin(null, req), 'https://lazertopia-voltris-demo.vercel.app');

  // A matching origin is fine, trailing slash trimmed.
  assert.equal(safeOrigin('https://lazertopia-voltris-demo.vercel.app/', req), 'https://lazertopia-voltris-demo.vercel.app');

  // Behind Vercel's proxy the forwarded headers decide, not the internal protocol.
  const proxied = { protocol: 'http', headers: { host: 'internal', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'book.lasertopia.ca' } };
  assert.equal(safeOrigin('https://evil.example.com', proxied), 'https://book.lasertopia.ca');
  assert.equal(safeOrigin('https://book.lasertopia.ca', proxied), 'https://book.lasertopia.ca');
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
// SMS / email
// ---------------------------------------------------------------------------

test('nothing configured means simulated messaging, not an error', () => {
  const s = messagingStatus({});
  assert.equal(s.sms.enabled, false);
  assert.equal(s.email.enabled, false);
  assert.equal(s.sms.problem, null);
  assert.equal(s.email.problem, null);
});

test('half-configured Twilio and SendGrid say what is missing', () => {
  assert.match(messagingStatus({ TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok' }).sms.problem, /TWILIO_PHONE_NUMBER/);
  assert.match(messagingStatus({ TWILIO_ACCOUNT_SID: 'oops', TWILIO_AUTH_TOKEN: 't', TWILIO_PHONE_NUMBER: '+1' }).sms.problem, /start with AC/);
  assert.match(messagingStatus({ SENDGRID_API_KEY: 'nope', SENDGRID_FROM_EMAIL: 'a@b.c' }).email.problem, /SG\./);
  assert.match(messagingStatus({ SENDGRID_API_KEY: 'SG.abc' }).email.problem, /SENDGRID_FROM_EMAIL/);
});

test('a full set of credentials enables each channel', () => {
  const s = messagingStatus({
    TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_PHONE_NUMBER: '+12045550123',
    SENDGRID_API_KEY: 'SG.abc', SENDGRID_FROM_EMAIL: 'hello@lasertopia.ca',
  });
  assert.equal(s.sms.enabled, true);
  assert.equal(s.sms.from, '+12045550123');
  assert.equal(s.email.enabled, true);
});

test('phone numbers are normalised to E.164 for Twilio', () => {
  assert.equal(toE164('204-474-5900'), '+12044745900');     // as a customer would type it
  assert.equal(toE164('(204) 474 5900'), '+12044745900');
  assert.equal(toE164('12044745900'), '+12044745900');
  assert.equal(toE164('+44 7700 900123'), '+447700900123'); // already international
  assert.equal(toE164('12345'), null, 'too short to be real');
  assert.equal(toE164(''), null);
});

test('the confirmation text carries what a customer actually needs', () => {
  const b = {
    code: 'LT-ABC123', dateISO: '2026-11-06', startMin: 18 * 60, games: 2,
    players: 4, totalCents: 6196, phone: '204-555-0100',
  };
  const sms = bookingSmsBody(b);
  assert.match(sms, /LT-ABC123/, 'the code they quote at the desk');
  assert.match(sms, /6:00pm/, 'when to turn up');
  assert.match(sms, /4 players/);
  assert.match(sms, /waiver/i, 'the thing that slows down arrivals');
  assert.match(sms, /204-474-5900/, 'how to reach the arena');
});

test('the reminder says tomorrow, and stays short', () => {
  const b = { code: 'LT-XYZ789', dateISO: '2026-11-06', startMin: 19 * 60, games: 1, players: 6 };
  const sms = reminderSmsBody(b);
  assert.match(sms, /tomorrow/i);
  assert.match(sms, /7:00pm/);
  assert.match(sms, /LT-XYZ789/);
  // Two SMS segments is the practical ceiling before it reads as spam.
  assert.ok(sms.length <= 320, `reminder is ${sms.length} chars`);
});

test('messages are recorded whether or not they were really sent', async () => {
  clearOutbox();
  const b = {
    code: 'LT-OUT001', dateISO: '2026-11-06', startMin: 18 * 60, games: 1,
    players: 4, totalCents: 3396, phone: '204-555-0100', email: 'someone@example.com',
  };
  const out = await sendBookingConfirmation(b);

  assert.equal(out.sms.state, 'simulated', 'no Twilio configured in tests');
  assert.equal(out.email.state, 'simulated');

  const log = getOutbox();
  assert.equal(log.length, 2, 'one SMS and one email');
  assert.ok(log.every((m) => m.bookingCode === 'LT-OUT001'));
  assert.ok(log.some((m) => m.channel === 'sms' && m.to === '+12045550100'));
  assert.ok(log.some((m) => m.channel === 'email' && m.to === 'someone@example.com'));
});

test('a missing phone or email is skipped, not failed', async () => {
  clearOutbox();
  const b = { code: 'LT-OUT002', dateISO: '2026-11-06', startMin: 18 * 60, games: 1, players: 4, totalCents: 3396 };
  const out = await sendBookingConfirmation(b);
  assert.equal(out.sms.state, 'skipped');
  assert.equal(out.email.state, 'skipped');
  assert.match(out.email.detail, /No email/);
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
