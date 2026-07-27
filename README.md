# Lasertopia — Booking Demo

A booking prototype for **Lasertopia Inc.** (Unit #5 – 1140 Waverley St, Winnipeg) covering both
sides of the system: customers booking a laser tag game, and the front desk watching those
bookings land on their game sheet.

Rates, hours, special hours and event packages are the **real ones** from lasertopia.ca.
Checkout is simulated — there's no Stripe and no database yet.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:4242**.

```bash
npm test        # 31 checks on the pricing, capacity and hours logic
```

## Pages

| Route | What it is |
|---|---|
| `/` | **Book a game** — date → game time → players → games → checkout |
| `/admin` | **Staff game sheet** — every 15-min game, who's in it, walk-ins, blocks |
| `/rates` | Rates & pricing, group rules, house rules |
| `/packages` | The three event packages, with a party-request flow |
| `/hours` | Weekly hours + July/August special hours, and an open/closed-now status |
| `/waiver` | Participant waiver, with the under-18 guardian path |
| `/manage` | Find or cancel a booking by its code |

## How the arena is modelled

This is not a "book a resource from X to Y" system — Lasertopia runs one arena on a fixed
timetable, so the model is different:

- **One arena.** Games launch **every 15 minutes**; the last game starts 30 minutes before close.
- **25 seats per game**, and a game needs **at least 2 players** to run.
- **Priced per person by game count**: 1 game $8.49 · 2 games $15.49 · 3 games $21.49 (taxes extra).
- **Multi-game bookings hold consecutive games.** Buying 3 games holds 3 back-to-back sessions, so
  the grid and the game sheet both stay honest. Flip `ARENA.consecutiveGames` in
  [lib/arena.js](lib/arena.js) to `false` if the desk would rather hold only the first game and let
  people redeem the rest any time that day.
- **Groups of 12+ need 24 hours notice.** Booking a big group inside that window is refused with
  the shop's phone number. Group bookings are badged for staff.
- **Today's earlier games stop being bookable** once their start time passes. Staff can still record
  a walk-in into the game that's currently running.

### The group rate is deliberately not invented

Lasertopia publishes that 12+ players get group rates, but not what the rate *is*. Rather than
making up a discount that could end up in front of the client looking official, standard rates
apply and `ARENA.groupDiscountPct` sits at `0`. Set it to the real number and everything
downstream — pricing, the checkout recap, the staff sheet — follows.

## Layout

```
lib/arena.js        Hours, sessions, capacity, pricing. The single source of truth —
                    the server imports it AND the browser loads the same file, so the
                    price a customer sees can't drift from the price the server records.
lib/demo-store.js   In-memory bookings, with each date seeded deterministically so the
                    arena looks realistically busy and looks the same on every visit.
lib/arena.test.js   Unit tests for all of the above.
server.js           Express: static pages + the demo JSON API.
demo/               The pages. Shared shell in demo/assets/.
```

Because everything is in one process, a booking made on `/` shows up on `/admin` immediately,
and a walk-in added on `/admin` takes seats away from `/`.

## What's not wired up yet

By design, for this stage:

- **Payments.** The checkout modal is a simulation — no Stripe, no charge.
- **Database.** Bookings live in memory and reset when the server restarts.
- **Staff sign-in.** `/admin` is open; anyone with the URL can see it.
- **Waiver storage.** Signing shows the confirmation but doesn't save anything.

## Deploying to Vercel

`vercel.json` maps the routes to the static pages. One thing to know before deploying:
Vercel runs each API call in its own short-lived process, so the in-memory store **won't share
state between requests** in production. That shared live state is exactly what Supabase will
take over — it's the next piece of work, not a surprise.
