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
