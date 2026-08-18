-- Lasertopia booking — initial schema
--
-- Run this once against a fresh Supabase project:
--   Supabase dashboard → SQL Editor → New query → paste → Run
--
-- Design notes worth knowing before changing anything here:
--
--   • Times are integer minutes past midnight, matching lib/arena.js. They are NOT
--     timestamps: a game at 5:15pm is 1035, and the date it belongs to is a separate
--     `date` column. This is deliberate — the arena runs on a wall-clock timetable in
--     Winnipeg, and storing "1035 on 2026-08-22" survives daylight saving in a way that
--     a timestamp does not.
--   • Real instants (created_at, message timestamps) ARE timestamptz, stored UTC.
--   • Money is integer cents. Never a float.
--   • Every table has RLS enabled and NO policies. Supabase exposes tables over PostgREST
--     to anyone holding the anon key, so a table without RLS is a public table. The server
--     talks to Postgres with the service_role key, which bypasses RLS by design; the
--     browser never talks to Supabase directly. If that ever changes, add policies
--     deliberately rather than disabling RLS.

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------

create table if not exists bookings (
  id                  bigint generated always as identity primary key,

  -- Customer-facing code, e.g. LT-9SEDK8. Blocks use BLK-<n> and never reach a customer.
  code                text        not null unique,

  date                date        not null,
  start_min           integer     not null check (start_min between 0 and 1439),
  games               integer     not null default 1 check (games >= 1),
  players             integer     not null default 0 check (players >= 0),

  kind                text        not null check (kind in ('online', 'walkin', 'party', 'block')),

  name                text        not null default '',
  email               text        not null default '',
  phone               text        not null default '',

  total_cents         integer     not null default 0 check (total_cents >= 0),
  is_group            boolean     not null default false,
  note                text        not null default '',

  -- Set once Stripe confirms the money arrived. The unique constraint on the checkout
  -- session is what stops a refreshed confirmation page booking (and charging) twice.
  payment_intent_id   text,
  checkout_session_id text unique,

  cancelled           boolean     not null default false,
  created_at          timestamptz not null default now()
);

-- Every read is "what is happening on this date", so this is the index that matters.
-- Partial on cancelled = false because cancelled rows are filtered out of every query.
create index if not exists bookings_date_live_idx
  on bookings (date, start_min)
  where cancelled = false;

create index if not exists bookings_code_idx on bookings (code);

-- ---------------------------------------------------------------------------
-- Party detail
--
-- Kept in its own table rather than as nullable columns on bookings: a party carries a
-- dozen extra fields that are meaningless for a walk-in, and the party board queries
-- only these. One row per booking where kind = 'party'.
-- ---------------------------------------------------------------------------

create table if not exists party_details (
  booking_id     bigint      primary key references bookings (id) on delete cascade,

  -- The 2-hour room slot, in minutes past midnight.
  slot_start     integer     not null check (slot_start between 0 and 1439),
  slot_end       integer     not null check (slot_end between 0 and 1440),

  -- Guest of honour. Parties sharing a slot are matched within ARENA.partyAgeSpreadYears.
  age            integer     check (age between 1 and 99),
  age_override   boolean     not null default false,

  -- Which physical rooms this party occupies, by capacity, e.g. {14} or {12,14}.
  -- Stored rather than derived so the board can tell what is genuinely left even if the
  -- room configuration is later changed.
  rooms          integer[]   not null default '{}',
  positions      integer     not null default 1 check (positions between 1 and 3),

  -- 2 when the group is larger than the arena holds at once and the desk splits them.
  split_groups   integer     not null default 1 check (split_groups between 1 and 2),

  package_id     text,
  package_name   text,
  pizzas         integer     check (pizzas >= 0),
  add_ons        text[]      not null default '{}',

  deposit_cents  integer     not null default 0 check (deposit_cents >= 0),
  deposit_state  text        not null default 'due'
                             check (deposit_state in ('due', 'paid', 'gifted', 'forfeited', 'carried'))
);

create index if not exists party_details_slot_idx on party_details (slot_start);

-- ---------------------------------------------------------------------------
-- Staff overrides to the standing held-game pattern
--
-- 'released' opens a normally-held game to the public; 'held' takes a normally-public
-- game off the grid. One row per (date, game time) — the two states are mutually
-- exclusive, which the primary key enforces for free.
-- ---------------------------------------------------------------------------

create table if not exists hold_overrides (
  date       date        not null,
  start_min  integer     not null check (start_min between 0 and 1439),
  state      text        not null check (state in ('released', 'held')),
  created_at timestamptz not null default now(),
  primary key (date, start_min)
);

-- ---------------------------------------------------------------------------
-- Outbox
--
-- Every SMS and email the system composes, whether or not it was really sent. Rows
-- marked 'simulated' are messages that would have gone out with credentials configured —
-- the point is that nothing ever silently pretends to have sent.
-- ---------------------------------------------------------------------------

create table if not exists messages (
  id           bigint      generated always as identity primary key,
  sent_at      timestamptz not null default now(),
  channel      text        not null check (channel in ('sms', 'email')),
  kind         text        not null,
  booking_code text,
  recipient    text        not null default '',
  subject      text,
  body         text        not null default '',
  state        text        not null check (state in ('sent', 'simulated', 'skipped', 'failed')),
  detail       text
);

create index if not exists messages_recent_idx on messages (sent_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Enabled with no policies: deny everything. The server uses the service_role key, which
-- bypasses RLS; the browser never connects to Supabase. Without this, anyone with the
-- anon key — which is public by design — could read every customer's name and phone
-- number straight out of PostgREST.
-- ---------------------------------------------------------------------------

alter table bookings       enable row level security;
alter table party_details  enable row level security;
alter table hold_overrides enable row level security;
alter table messages       enable row level security;
