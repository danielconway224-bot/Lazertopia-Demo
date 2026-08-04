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
npm test        # 51 checks on pricing, capacity, hours, held slots and party rules
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

## Parties and held game times

From Shannon's email — this is how Lasertopia actually schedules, and the demo enforces it.

**Certain game times are held back for birthday parties** and don't appear as bookable to the
public. They show on the grid as dashed "Held for parties" rather than being hidden, because they
genuinely do open up when no party takes them.

| Day | Held game times |
|---|---|
| Mon–Fri | 5:15, 5:30, 6:15, 6:45 |
| Saturday | 1:15, 1:45, 3:15, 3:45, 5:15, 5:45 |
| Sunday | 1:15, 1:45, 3:00, 3:15, 4:15, 4:45 |

The front desk releases them with one click on `/admin`, and can also **hold back extra times**
when a party needs them ("we sometimes have to book off other time slots as well"). A multi-game
run can't quietly swallow a held slot either — buying 3 games at 5:00pm is refused because it
would cover the held 5:15 and 5:30.

**Parties book a 2-hour room slot, not a game time.** Two parties share each slot, matched within
**2 years of age** so the kids play together — which is why the booking form asks what age the
birthday guest is turning.

| Day | Party room slots |
|---|---|
| Mon–Fri | 5–7, 6–8 |
| Saturday | 10–12, 11–1, 1–3, 3–5, 5–7 |
| Sunday | 10–12, 11–1, 1–3, 3–5, 4–6 |

Two more rules fall out of that:

- **The building holds 2 parties at once.** The slots overlap (5–7 and 6–8), so they're staggered
  alternatives, not extra rooms — filling 5–7 takes 6–8 off the board.
- **Weekend parties start at 10am** even though public laser tag opens at noon. The arena opens
  early for a booked party, not for walk-ins.
- **Age matching is enforced online but overridable at the desk.** A mismatched party is refused
  with the reason; staff get a warning they can accept, and the override is recorded on the booking.

A party's laser tag games are derived, not hard-coded: each held game belongs to the latest slot
that has already started when it runs. That lands on exactly two games per slot, matching the two
games every party package includes.

### Three things to confirm with Shannon

Built to the email as written; these are the gaps, and each is a one-line config edit:

1. **Saturday 10–12 and 11–1 have no held game times listed.** Every other slot has two. Do
   morning parties play laser tag, and if so when?
2. **Sunday's held games are 3:00 and 3:15** — 15 minutes apart, where every other day spaces them
   15–30 minutes. Possibly a typo for 3:00/3:30.

### The group rate is deliberately not invented

Lasertopia publishes that 12+ players get group rates, but not what the rate *is*. Rather than
making up a discount that could end up in front of the client looking official, standard rates
apply and `ARENA.groupDiscountPct` sits at `0`. Set it to the real number and everything
downstream — pricing, the checkout recap, the staff sheet — follows.

## Layout

```
lib/arena.js        Hours, sessions, capacity, pricing, party slots and held game times.
                    The single source of truth — the server imports it AND the browser
                    loads the same file, so the price and the rules a customer sees
                    can't drift from what the server enforces.
lib/demo-store.js   In-memory bookings and parties, with each date seeded deterministically
                    so the arena looks realistically busy and identical on every visit.
lib/api-app.js      The JSON API as an Express app, shared by both runtimes below.
lib/arena.test.js   Unit tests for all of the above.
server.js           Local dev: the API app + static pages.
api/index.js        Vercel: the same API app as a serverless function.
demo/               The pages. Shared shell in demo/assets/.
```

Because everything is in one process, a booking made on `/` shows up on `/admin` immediately,
and a walk-in added on `/admin` takes seats away from `/`.

## Card payments (Stripe test mode)

Out of the box the checkout is **simulated** — no keys needed, the demo works end to end.
Add Stripe test keys and the same checkout takes real test cards instead.

The flow is **Stripe Checkout**: clicking Pay sends the customer to Stripe's own hosted
payment page, and Stripe sends them back here to their confirmation. The booking is only
created on the way back, once Stripe confirms the money arrived — so an abandoned payment
leaves the game time free rather than holding a phantom booking.

### Getting your test keys

1. Sign in at [dashboard.stripe.com](https://dashboard.stripe.com) (a free account is enough —
   no business details required to use test mode).
2. Make sure the **Test mode** toggle, top right, is **ON**. Everything below must be done
   in test mode.
3. Go to **Developers → API keys**, or straight to
   [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys).
4. Copy the two keys:
   - **Publishable key** — starts `pk_test_`. Safe to expose; it can only start payments.
   - **Secret key** — starts `sk_test_`. Click *Reveal*. Treat it like a password.
5. Put them in `.env` (copy `.env.example` first):

   ```
   STRIPE_SECRET_KEY=sk_test_…
   STRIPE_PUBLISHABLE_KEY=pk_test_…
   ```

6. Restart with `npm start`. The banner should read **Stripe TEST mode**.

**Safer option:** instead of the raw secret key, create a **restricted key** under
*Developers → API keys → Create restricted key*, granting **write** on *PaymentIntents* and
nothing else. It starts `rk_test_` and works here unchanged. If it ever leaks, it can't read
customers or move money.

### Paying in test mode

Card **4242 4242 4242 4242**, any future expiry, any CVC, any postcode. Useful others:

| Card | What happens |
|---|---|
| 4242 4242 4242 4242 | Succeeds |
| 4000 0000 0000 0002 | Declined |
| 4000 0025 0000 3155 | Requires 3-D Secure authentication |

Every payment shows up under **Payments** in the Stripe dashboard. No real money moves.

### On Vercel

`.env` is not deployed. Add the same two variables under
**Project → Settings → Environment Variables**, then redeploy. Until you do, the live site
keeps using the simulated checkout.

### How it's kept safe

- **Live keys are refused.** A `sk_live_` / `pk_live_` key doesn't enable payments; the
  server logs why and stays simulated. A prototype must never charge a real card.
- **The browser never sets the price.** The amount is recomputed on the server from the
  players and games chosen, using the same `priceBooking()` as everywhere else. A tampered
  request gets the correct price, not the one it sent.
- **A booking is only saved once Stripe confirms the money arrived.** The returning page
  hands over nothing but the session id; the booking is rebuilt from *Stripe's* copy of it,
  so a tampered return URL can't conjure a free booking. Posting straight to `/api/book`
  without paying returns `402`.
- **Refreshing the confirmation page can't book twice** — the Stripe session id is stored on
  the booking and re-confirming returns the original.
- **Stripe can only send customers back to this site.** The return URL is built from the
  request's own host, never from a value the browser supplied, so nobody can redirect a
  paying customer to a lookalike site.
- **Paid-but-unseated is surfaced, not swallowed.** If the last seats go while someone is on
  Stripe's page, they get told to call for a rebook or refund, and it's logged. A production
  build would auto-refund here.
- The secret key never leaves the server; only the publishable key reaches the browser.

Parties are deliberately left as a **request** rather than a payment — the front desk calls
to confirm and take a deposit, which is how Lasertopia actually runs them.

## What's not wired up yet

By design, for this stage:

- **Payments beyond test mode.** Test keys only; going live needs a real Stripe account
  review and a webhook for out-of-band events (refunds, disputes, delayed methods).
- **Database.** Bookings live in memory and reset when the server restarts.
- **Staff sign-in.** `/admin` is open; anyone with the URL can see it.
- **Waiver storage.** Signing shows the confirmation but doesn't save anything.

## Deploying to Vercel

`vercel.json` maps the routes to the static pages. One thing to know before deploying:
Vercel runs each API call in its own short-lived process, so the in-memory store **won't share
state between requests** in production. That shared live state is exactly what Supabase will
take over — it's the next piece of work, not a surprise.
