// Run with:  npm test   (node --test)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARENA, PACKAGES, hoursFor, sessionsFor, sessionSpan, priceBooking, groupNoticeOk,
  priceEventPackage, fmtTime, money, isoDate, parseISO, isPastSession,
} from './arena.js';

import { availabilityFor, addBooking, blockSession, gameSheetFor, statsFor } from './demo-store.js';

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
// Formatting
// ---------------------------------------------------------------------------

test('times and money format the way the pages display them', () => {
  assert.equal(fmtTime(12 * 60), '12:00pm');
  assert.equal(fmtTime(15 * 60 + 30), '3:30pm');
  assert.equal(fmtTime(21 * 60), '9:00pm');
  assert.equal(money(849), '$8.49');
  assert.equal(money(2149), '$21.49');
});

test('isoDate uses local time, not UTC', () => {
  assert.equal(isoDate(new Date(2026, 6, 27)), '2026-07-27');
  assert.equal(isoDate(new Date(2026, 0, 1)), '2026-01-01');
});
