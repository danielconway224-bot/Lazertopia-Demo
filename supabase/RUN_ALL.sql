-- ============================================================
-- Lasertopia booking — full schema bootstrap
--
-- THIS FILE IS FOR SETTING UP A NEW, EMPTY DATABASE.
--
-- On a database that is already running, do NOT paste this. Run only the new
-- numbered file in supabase/migrations/ — `npm run check-db` lists exactly which
-- ones are outstanding, and there is usually just one.
--
-- Re-running this whole file is harmless today (every statement is guarded with
-- `if not exists`, `or replace` or `on conflict do nothing`) but it hides which
-- migration actually applied, and the first migration that carries a data change
-- rather than a schema change will not be safe to repeat.
--
-- Generated from supabase/migrations/. Do not edit here; edit the numbered file.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 0001_init.sql
-- ─────────────────────────────────────────────────────────────

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

-- ─────────────────────────────────────────────────────────────
-- 0002_atomic_booking.sql
-- ─────────────────────────────────────────────────────────────

-- Atomic seat and room allocation.
--
-- WHY THIS EXISTS
--
-- The prototype checks capacity and then inserts, as two separate steps. That is only safe
-- because it runs in one process with one in-memory Map. The moment there is a real
-- database and more than one serverless function, two customers can both read "3 seats
-- left", both decide they fit, and both write — overselling the arena.
--
-- These functions do the check and the write inside one transaction, behind a lock, so the
-- second caller sees the first one's booking and is refused.
--
-- The lock is a transaction-scoped advisory lock keyed on the DATE. That serialises all
-- bookings for a single day, which sounds heavy and is not: one arena, a few dozen
-- bookings a day, each transaction lasting under a millisecond. Correctness beats
-- cleverness here, and a per-session lock would not protect a multi-game booking that
-- spans several sessions anyway.
--
-- The application still does the richer validation (hours, held slots, group notice,
-- best-fit room allocation). These functions are the backstop that makes overselling
-- impossible rather than unlikely.

-- ---------------------------------------------------------------------------
-- Laser tag
-- ---------------------------------------------------------------------------

create or replace function book_session(
  p_code                text,
  p_date                date,
  p_start_min           integer,
  p_games               integer,
  p_players             integer,
  p_kind                text,
  p_capacity            integer,
  p_step_min            integer default 15,
  p_name                text    default '',
  p_email               text    default '',
  p_phone               text    default '',
  p_total_cents         integer default 0,
  p_is_group            boolean default false,
  p_note                text    default '',
  p_payment_intent_id   text    default null,
  p_checkout_session_id text    default null
)
returns bookings
language plpgsql
as $$
declare
  v_minute  integer;
  v_taken   integer;
  v_blocked boolean;
  v_row     bookings;
begin
  -- Serialise every booking for this date. Released automatically at commit or rollback.
  perform pg_advisory_xact_lock(hashtext(p_date::text));

  -- A multi-game booking must clear EVERY session it occupies, not just the first.
  v_minute := p_start_min;
  while v_minute < p_start_min + p_step_min * p_games loop

    select exists (
      select 1 from bookings b
      where b.date = p_date
        and b.cancelled = false
        and b.kind = 'block'
        and b.start_min = v_minute
    ) into v_blocked;

    if v_blocked then
      raise exception 'session_blocked'
        using detail = 'A game in this run is closed to bookings.';
    end if;

    -- Seats taken = every live, non-block booking whose run covers this minute.
    select coalesce(sum(b.players), 0)
      into v_taken
      from bookings b
     where b.date = p_date
       and b.cancelled = false
       and b.kind <> 'block'
       and v_minute >= b.start_min
       and v_minute <  b.start_min + p_step_min * b.games;

    if p_capacity - v_taken < p_players then
      raise exception 'session_full'
        using detail = format('Only %s seats left at minute %s.', p_capacity - v_taken, v_minute);
    end if;

    v_minute := v_minute + p_step_min;
  end loop;

  insert into bookings (
    code, date, start_min, games, players, kind,
    name, email, phone, total_cents, is_group, note,
    payment_intent_id, checkout_session_id
  ) values (
    p_code, p_date, p_start_min, p_games, p_players, p_kind,
    p_name, p_email, p_phone, p_total_cents, p_is_group, p_note,
    p_payment_intent_id, p_checkout_session_id
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Parties
--
-- Room capacity, unlike seats, is about how many ROOMS are occupied in a window. Slots
-- overlap and share the same physical rooms, so a party booked 5–7 is still using its
-- room at 6:00 and must count against the 6–8 slot.
--
-- The application works out precisely which rooms a party takes (best fit, smallest room
-- that holds them). This function re-checks the simpler question — do the positions still
-- fit — under lock, so a race cannot oversell even if the application's view was stale.
-- ---------------------------------------------------------------------------

create or replace function book_party(
  p_code           text,
  p_date           date,
  p_slot_start     integer,
  p_slot_end       integer,
  p_slot_capacity  integer,          -- how many rooms this slot has
  p_positions      integer,          -- how many of them this party takes
  p_rooms          integer[],        -- their capacities, for the record
  p_start_min      integer,          -- first laser tag game, for the game sheet
  p_games          integer,
  p_guests         integer,
  p_age            integer,
  p_age_override   boolean,
  p_split_groups   integer,
  p_name           text    default '',
  p_email          text    default '',
  p_phone          text    default '',
  p_package_id     text    default null,
  p_package_name   text    default null,
  p_pizzas         integer default null,
  p_add_ons        text[]  default '{}',
  p_total_cents    integer default 0,
  p_deposit_cents  integer default 0,
  p_note           text    default ''
)
returns bookings
language plpgsql
as $$
declare
  v_used integer;
  v_row  bookings;
begin
  perform pg_advisory_xact_lock(hashtext(p_date::text));

  -- Positions already taken by any live party whose slot overlaps this window.
  select coalesce(sum(pd.positions), 0)
    into v_used
    from party_details pd
    join bookings b on b.id = pd.booking_id
   where b.date = p_date
     and b.cancelled = false
     and pd.slot_start < p_slot_end
     and p_slot_start < pd.slot_end;

  if v_used + p_positions > p_slot_capacity then
    raise exception 'slot_full'
      using detail = format('%s of %s rooms already taken in this window.', v_used, p_slot_capacity);
  end if;

  insert into bookings (
    code, date, start_min, games, players, kind,
    name, email, phone, total_cents, note
  ) values (
    p_code, p_date, p_start_min, p_games, p_guests, 'party',
    p_name, p_email, p_phone, p_total_cents, p_note
  )
  returning * into v_row;

  insert into party_details (
    booking_id, slot_start, slot_end, age, age_override,
    rooms, positions, split_groups,
    package_id, package_name, pizzas, add_ons, deposit_cents
  ) values (
    v_row.id, p_slot_start, p_slot_end, p_age, p_age_override,
    p_rooms, p_positions, p_split_groups,
    p_package_id, p_package_name, p_pizzas, p_add_ons, p_deposit_cents
  );

  return v_row;
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- 0003_portal.sql
-- ─────────────────────────────────────────────────────────────

-- Manager portal: developer notes, and a customer view derived from bookings.

-- ---------------------------------------------------------------------------
-- Notes
--
-- Shared reminders for the team and for whoever is building this. Deliberately plain:
-- a body, who wrote it, and whether it is still open. No threading, no mentions — the
-- moment those are wanted, this is the wrong tool and it should be a real tracker.
-- ---------------------------------------------------------------------------

create table if not exists notes (
  id         bigint      generated always as identity primary key,
  body       text        not null check (length(trim(body)) > 0),
  author     text        not null default '',
  -- 'dev' notes are for whoever is building; 'ops' are for the front desk.
  kind       text        not null default 'dev' check (kind in ('dev', 'ops')),
  done       boolean     not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notes_recent_idx on notes (created_at desc);

alter table notes enable row level security;

-- ---------------------------------------------------------------------------
-- Customers
--
-- Lasertopia has no customer accounts — people book with a name and a phone number. So a
-- "customer" is an aggregate over bookings rather than a table of its own, which means it
-- can never drift out of sync with what was actually booked.
--
-- Identity is the phone number, digits only, because that is the one field every booking
-- must have and the one people give consistently. Email is carried along but not used to
-- group: the same family books under three different addresses.
--
-- A view rather than JS so the grouping happens in the database. Summing 40,000 bookings
-- in Node to render one page is how a portal gets slow.
-- ---------------------------------------------------------------------------

create or replace view customers as
select
  regexp_replace(coalesce(phone, ''), '\D', '', 'g') as phone_key,
  -- The most recent spelling of their name and address wins; people correct typos.
  (array_agg(name  order by created_at desc nulls last))[1]  as name,
  (array_agg(phone order by created_at desc nulls last))[1]  as phone,
  (array_agg(nullif(email, '') order by created_at desc nulls last)
     filter (where nullif(email, '') is not null))[1]        as email,
  count(*)                                                   as bookings,
  sum(players)                                               as guests_brought,
  sum(total_cents)                                           as paid_cents,
  min(date)                                                  as first_visit,
  max(date)                                                  as last_visit
from bookings
where cancelled = false
  and kind <> 'block'
  and coalesce(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), '') <> ''
group by 1;

-- The view inherits RLS from bookings, but be explicit: PostgREST must not serve it to
-- anyone holding the public key.
alter view customers set (security_invoker = on);

-- ─────────────────────────────────────────────────────────────
-- 0004_party_slot_overrides.sql
-- ─────────────────────────────────────────────────────────────

-- Manager edits to the party schedule, for one date.
--
-- The weekly schedule in lib/arena.js is the default and loads every day. A row here
-- changes, adds or removes one slot for ONE date. Stored per date rather than as a new
-- default on purpose: "we moved the 5pm party to 5:30 that Saturday" must not silently
-- rewrite every Saturday from then on.
--
-- A row with removed = true takes a standing slot off that day. A row whose slot_start
-- matches no standing slot adds a new one.

create table if not exists party_slot_overrides (
  date       date        not null,
  slot_start integer     not null check (slot_start between 0 and 1439),
  slot_end   integer     not null check (slot_end between 0 and 1440),

  -- Capacity of each room in the slot, e.g. {14,14} or {12,14,18}.
  rooms      integer[]   not null default '{}',
  -- Capacity when a party takes more than one room.
  combined   integer     not null default 0,
  -- Laser tag start times this slot plays. Empty is legal — it means "to be confirmed".
  games      integer[]   not null default '{}',

  removed    boolean     not null default false,
  updated_at timestamptz not null default now(),

  primary key (date, slot_start),
  check (slot_end > slot_start)
);

create index if not exists party_slot_overrides_date_idx on party_slot_overrides (date);

alter table party_slot_overrides enable row level security;

-- ─────────────────────────────────────────────────────────────
-- 0005_settings.sql
-- ─────────────────────────────────────────────────────────────

-- Editable configuration.
--
-- The values in lib/arena.js remain the DEFAULTS and the shape of truth: a fresh install
-- with no row here behaves exactly as it does today. This table holds only what a manager
-- has actually changed, as a patch on top.
--
-- One row, JSONB. A key/value table would be tidier in the abstract and worse in practice:
-- prices are a list, weekly hours are a map of seven pairs, and special hours are keyed by
-- date. Flattening those into rows buys nothing and makes reading them a join.

create table if not exists settings (
  id         integer     primary key default 1 check (id = 1),
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text        not null default ''
);

insert into settings (id, data) values (1, '{}'::jsonb) on conflict (id) do nothing;

alter table settings enable row level security;

-- ─────────────────────────────────────────────────────────────
-- 0006_waivers.sql
-- ─────────────────────────────────────────────────────────────

-- Signed participant waivers.
--
-- A waiver is a legal record, so this table is append-only in spirit: rows are never edited
-- after signing. The exact terms the person agreed to are stored ON the row rather than
-- referenced, because the wording will change and a waiver has to say what was actually
-- accepted on the day, not what the current version happens to say.
--
-- Lasertopia's waiver is valid for ONE YEAR from signing, so expiry is derived from
-- signed_at rather than stored — a stored date could disagree with the timestamp beside it.

create table if not exists waivers (
  id                bigint      generated always as identity primary key,

  -- Participant
  first_name        text        not null check (length(trim(first_name)) > 0),
  last_name         text        not null check (length(trim(last_name)) > 0),
  email             text        not null check (position('@' in email) > 1),
  date_of_birth     date        not null,

  -- Required when the participant is under 18 on the day they sign.
  guardian_first    text        not null default '',
  guardian_last     text        not null default '',

  -- Address
  country           text        not null default 'Canada',
  address1          text        not null default '',
  address2          text        not null default '',
  city              text        not null default '',
  province          text        not null default '',
  postal_code       text        not null default '',

  heard_about       text[]      not null default '{}',
  comments          text        not null default '',

  -- The agreement itself.
  agreed            boolean     not null default false check (agreed),
  terms_version     text        not null default '',
  signed_at         timestamptz not null default now(),

  -- Kept for a dispute: who signed, from where.
  signed_ip         text        not null default '',
  user_agent        text        not null default ''
);

-- The desk looks a waiver up by name at the counter, and by email when someone says
-- "I signed online". Both need to be fast on a busy Saturday.
create index if not exists waivers_name_idx  on waivers (lower(last_name), lower(first_name));
create index if not exists waivers_email_idx on waivers (lower(email));
create index if not exists waivers_signed_idx on waivers (signed_at desc);

alter table waivers enable row level security;

-- ─────────────────────────────────────────────────────────────
-- 0007_party_deposit.sql
-- ─────────────────────────────────────────────────────────────

-- Card deposits on party bookings.
--
-- book_party gains the two Stripe references and the deposit state. Dropping and recreating
-- rather than "create or replace": Postgres treats a changed parameter list as a separate
-- overload, so a replace would leave the old signature in place and callers could silently
-- bind to it.
--
-- checkout_session_id is UNIQUE on bookings, which is what makes this safe to retry: a
-- customer refreshing the confirmation page cannot book — or be charged for — a second
-- party, because the second insert loses to the constraint.

-- Extra food ordered on top of a package. It was priced and shown to the customer but
-- never stored, so the desk could not see the pizzas and wings someone had actually
-- ordered. Stored as the priced lines rather than ids, because these prices INCLUDE tax
-- and a line has to say what was charged on the day, not what the menu says today.
alter table party_details add column if not exists food       jsonb   not null default '[]'::jsonb;
alter table party_details add column if not exists food_cents integer not null default 0;

drop function if exists book_party(
  text, date, integer, integer, integer, integer, integer[], integer, integer, integer,
  integer, boolean, integer, text, text, text, text, text, integer, text[], integer,
  integer, text);

create or replace function book_party(
  p_code           text,
  p_date           date,
  p_slot_start     integer,
  p_slot_end       integer,
  p_slot_capacity  integer,          -- how many rooms this slot has
  p_positions      integer,          -- how many of them this party takes
  p_rooms          integer[],        -- their capacities, for the record
  p_start_min      integer,          -- first laser tag game, for the game sheet
  p_games          integer,
  p_guests         integer,
  p_age            integer,
  p_age_override   boolean,
  p_split_groups   integer,
  p_name           text    default '',
  p_email          text    default '',
  p_phone          text    default '',
  p_package_id     text    default null,
  p_package_name   text    default null,
  p_pizzas         integer default null,
  p_add_ons        text[]  default '{}',
  p_total_cents    integer default 0,
  p_deposit_cents  integer default 0,
  p_note           text    default '',
  -- New: the deposit.
  p_deposit_state       text default 'due',
  p_payment_intent_id   text default null,
  p_checkout_session_id text default null,
  -- Extra food, as priced lines.
  p_food                jsonb   default '[]'::jsonb,
  p_food_cents          integer default 0
)
returns bookings
language plpgsql
as $$
declare
  v_used integer;
  v_row  bookings;
begin
  perform pg_advisory_xact_lock(hashtext(p_date::text));

  -- Positions already taken by any live party whose slot overlaps this window.
  select coalesce(sum(pd.positions), 0)
    into v_used
    from party_details pd
    join bookings b on b.id = pd.booking_id
   where b.date = p_date
     and b.cancelled = false
     and pd.slot_start < p_slot_end
     and p_slot_start < pd.slot_end;

  if v_used + p_positions > p_slot_capacity then
    raise exception 'slot_full'
      using detail = format('%s of %s rooms already taken in this window.', v_used, p_slot_capacity);
  end if;

  insert into bookings (
    code, date, start_min, games, players, kind,
    name, email, phone, total_cents, note,
    payment_intent_id, checkout_session_id
  ) values (
    p_code, p_date, p_start_min, p_games, p_guests, 'party',
    p_name, p_email, p_phone, p_total_cents, p_note,
    p_payment_intent_id, p_checkout_session_id
  )
  returning * into v_row;

  insert into party_details (
    booking_id, slot_start, slot_end, age, age_override,
    rooms, positions, split_groups,
    package_id, package_name, pizzas, add_ons, deposit_cents, deposit_state,
    food, food_cents
  ) values (
    v_row.id, p_slot_start, p_slot_end, p_age, p_age_override,
    p_rooms, p_positions, p_split_groups,
    p_package_id, p_package_name, p_pizzas, p_add_ons, p_deposit_cents, p_deposit_state,
    p_food, p_food_cents
  );

  return v_row;
end;
$$;

