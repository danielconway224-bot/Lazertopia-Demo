# Lasertopia — Booking System

The booking system for **Lasertopia Inc.** (Unit #5 – 1140 Waverley St, Winnipeg), covering both
sides: customers booking a laser tag game, and the front desk working the game sheet.

Rates, hours, special hours, party rooms and event packages are the real published ones.
Bookings persist in Postgres via Supabase.

> **Not launched yet.** Two things are deliberately held back until go-live: Stripe refuses
> live keys, and `/admin` has no sign-in. See the go-live checklist at the bottom before
> putting this in front of customers.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:4242**.

```bash
npm test        # 88 checks on pricing, capacity, hours, rooms, add-ons and party rules
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

(The weekend 10–12 games are absent from this table on purpose — they run before opening, so there
is no public session to withhold.)

The front desk releases them with one click on `/admin`, and can also **hold back extra times**
when a party needs them ("we sometimes have to book off other time slots as well"). A multi-game
run can't quietly swallow a held slot either — buying 3 games at 5:00pm is refused because it
would cover the held 5:15 and 5:30.

**Parties book a 2-hour room slot, not a game time.** Each slot holds a set of physical rooms of
different sizes, and the guest count decides how many of them a booking occupies. Parties sharing a
slot are matched within **2 years of age** so the kids play together — which is why the booking form
asks what age the birthday guest is turning.

| Day | Slot | Rooms | One party | Taking two |
|---|---|---|---|---|
| Mon–Fri | 5–7 | 14 · 14 | 14 | 20 |
| Mon–Fri | 6–8 | 12 · 14 | 14 | 18 |
| Sat · Sun | 10–12 | 14 · 14 · 18 | 14 (18 in the third) | 20 |
| Sat · Sun | 11–1 | 12 · 14 | 14 | 18 |
| Sat · Sun | 1–3 | 14 · 14 | 14 | 20 |
| Sat · Sun | 3–5 | 12 · 14 | 14 | 18 |
| Saturday | 5–7 | 14 · 14 | 14 | 20 |
| Sunday | 4–6 | 14 · 14 | 14 | 20 |

Counts include the guest of honour: a 14-guest room is 13 friends plus the birthday child, matching
how the packages are sold (10 guests = 9 friends + the guest of honour).

Rules that fall out of that:

- **A party takes the smallest room that fits it**, so the larger rooms stay free for larger
  parties. If none fits, it takes two and is capped at that slot's combined figure.
- **Overlapping slots share the rooms.** Filling 5–7 takes 6–8 off the board, because it's the same
  rooms an hour later.
- **Online booking caps at 20 guests.** Above that a party needs three rooms, which only the weekend
  10–12 slot has — so 21–28 is taken by phone and the desk arranges it.
- **Weekend parties start at 10am** even though public laser tag opens at noon. The arena opens
  early for a booked party, not for walk-ins.
- **Age matching is enforced online but overridable at the desk.** A mismatched party is refused
  with the reason; staff get a warning they can accept, and the override is recorded on the booking.

**A slot's laser tag games are explicit data on the slot**, not derived from the held list. The
weekend 10–12 games (10:15, 10:30, 10:45, 11:00) run *before* the arena opens to the public, so they
are not public sessions at all and could never be expressed as "held-back" ones. Parties sharing a
slot play those games together — two parties of ten is twenty players, inside the arena's 25.

### Add-ons, food and deposit

- **Q-BIX 5D Attraction** — $3.95 per person, on any package.
- **Arcade cards** — Traveler and Great Adventure only, and the two are *alternatives*: either the
  **5-Up Card** (guest loads $5, matched with $5 Bonus Cash, up to $20 — paid at the counter, so it
  carries no up-front price) or **45-minute Arcade Time Play** at $5 per guest.
- **Pizza scales with the guest count** — 2 up to 11 guests, then 3 / 4 / 5 / 6 through to 28.
- **Extra pizzas and wings** can be added. Their prices **include tax**, unlike everything else here,
  so they're totalled on a separate line rather than folded into the pre-tax subtotal.
- **A $50 non-refundable deposit** confirms a booking. 2 weeks notice to move a date; cancel more
  than 14 days out and the deposit becomes a gift card; inside 14 days it's forfeited or moved to a
  new date.

### Laser tag booking cutoff

Online booking closes **90 minutes before** a game starts, so seats are left for walk-ins at the
door. Cut-off games stay on the grid, dashed and tagged *Call us*, rather than disappearing — a
half-empty evening shouldn't read as sold out. The front desk is exempt. Set
`ARENA.onlineCutoffMin` to `0` to sell right up to the start time.

### Still to confirm with Lasertopia

Built to the brief as written; these are the gaps, and each is a one-line config edit:

1. **Saturday and Sunday 11–1 have no laser tag times.** Every other slot now has them. A party
   booked into 11–1 currently gets a room and no games, and the page says the times will be
   confirmed by phone.
2. **Sunday's held games are 3:00 and 3:15** — 15 minutes apart, where every other pair is 30.
   Possibly a typo for 3:00/3:30.
3. **The pizza bands had a gap and two overlaps** (11 guests unassigned; 20 and 25 listed twice).
   `PIZZA_TIERS` reads each band as "up to and including", which preserves every stated figure —
   confirm before it reaches a real till.
4. **The tax rate behind the food prices** is unknown, which is why those prices can't be folded
   into the pre-tax total.
5. **Combined capacity for the 11–1 and 3–5 slots** is assumed to be 18, matching Mon–Fri 6–8,
   which has the same two rooms.

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
lib/demo-store.js   In-memory store — starts empty, keeps only what is booked. The
                    fallback for local work and the unit tests.
lib/supabase.js     Database connection, and the guard rails on which key is which.
lib/api-app.js      The JSON API as an Express app, shared by both runtimes below.
lib/arena.test.js   Unit tests for all of the above.
server.js           Local dev: the API app + static pages.
api/index.js        Vercel: the same API app as a serverless function.
demo/               The pages. Shared shell in demo/assets/.
```

Because everything is in one process, a booking made on `/` shows up on `/admin` immediately,
and a walk-in added on `/admin` takes seats away from `/`.

## Card payments (Stripe test mode)

Without Stripe keys no card is taken: the customer reserves the game time and pays at the
desk. Nothing pretends to be a card payment.
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

## Automated texts and emails (Twilio + SendGrid)

Every booking triggers a confirmation **text and email**, staff can fire **day-before
reminders** from the game sheet, and an **Outbox** on `/admin` shows everything the system
has sent.

Like payments, it's fail-safe: with no credentials the messages are still composed and
listed in the Outbox marked **simulated**, so the whole flow demos on a laptop with no
account at all. Nothing silently pretends to have sent.

### Twilio (SMS)

1. Sign in at [console.twilio.com](https://console.twilio.com). The free trial is enough.
2. From the dashboard copy **Account SID** (starts `AC`) and **Auth Token**.
3. Get a number: **Phone Numbers → Manage → Buy a number** (trial credit covers it). Copy it
   in E.164 form, e.g. `+12045550123`.
4. **Verify the phone you'll demo to:** *Phone Numbers → Manage → Verified Caller IDs*.
5. Add to `.env`:

   ```
   TWILIO_ACCOUNT_SID=AC…
   TWILIO_AUTH_TOKEN=…
   TWILIO_PHONE_NUMBER=+1…
   ```

**Two trial limits that surprise people.** A trial account can *only* text verified numbers —
anything else fails, and the Outbox says so in plain words rather than a Twilio error code.
And trial texts arrive prefixed *"Sent from your Twilio trial account -"*. Both disappear
when the account is upgraded; neither is something the code can work around.

### SendGrid (email)

SendGrid is Twilio's email product but a separate signup.

1. Sign in at [app.sendgrid.com](https://app.sendgrid.com).
2. **Settings → Sender Authentication** — verify the address you'll send from. SendGrid
   rejects mail from unverified senders.
3. **Settings → API Keys → Create API Key**, with **Mail Send** permission. It starts `SG.`
   and is shown once.
4. Add to `.env`:

   ```
   SENDGRID_API_KEY=SG.…
   SENDGRID_FROM_EMAIL=you@yourdomain.com
   ```

### What gets sent

| Trigger | Goes out |
|---|---|
| Laser tag booking confirmed | SMS + email — code, date, time, players, waiver reminder |
| Party requested | SMS + email — pencilled in, desk will call for the deposit |
| Staff clicks *Send reminders* | Day-before SMS + email to every booking that day |
| Staff clicks *Resend confirmation* | Re-sends that booking's confirmation |

Reminders are a **button** rather than a schedule, so they can be demonstrated without
waiting a day. A production build would run the same call on a cron.

### On Vercel

Add the same five variables under **Settings → Environment Variables** and redeploy.
Note the Outbox lives in memory like the bookings do, so it's per-instance until Supabase
lands.

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

## Go-live checklist

Everything below is deliberate, and each one is a decision rather than an oversight. Work
through it before the first real customer books.

| # | What | Why it is not done yet |
|---|---|---|
| 1 | **Staff sign-in on `/admin`** | Anyone with the URL can read every customer's name, phone and email. Harmless while the database is empty; a breach the moment it is not. Supabase Auth is already connected. |
| 1b | **Remove the manager-portal shortcut** | `SHOW_MANAGER_SHORTCUT` in `demo/assets/shell.js` puts a Customer/Manager toggle in the corner of every page, which advertises `/admin` to customers. Set it to `false` — or leave it, once item 1 makes the link harmless. |
| 2 | **Stop falling back to the in-memory store** | If `SUPABASE_URL` goes missing in production the site quietly serves an empty arena and accepts bookings that vanish. Make missing database config a hard startup failure. |
| 2b | **Settings are editable, so guard them** | Prices, hours and the booking cutoff can now be changed from the portal and reach the customer site immediately. That is the point — and it is also why staff sign-in (item 1) matters more than it did. |
| 3 | **Allow live Stripe keys** | `lib/payments.js` refuses `sk_live_` on purpose so a real card cannot be charged mid-build. Relax it, and add a webhook for refunds, disputes and delayed payment methods. |
| 5 | **Auto-refund the paid-but-unseated case** | If the last seats go while a customer is on Stripe's page they are told to ring the desk. It should refund automatically. |
| 6 | **Schedule the reminders** | Day-before messages are a button on the game sheet so they can be demonstrated. Move to a cron. |
| 7 | **Supabase plan and backups** | Free projects pause after inactivity and back up thinly. Confirm the plan before launch. |
| 8 | **Answer the open questions** | The five items above under *Still to confirm with Lasertopia* still shape party bookings. |
