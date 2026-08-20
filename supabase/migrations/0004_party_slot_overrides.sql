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
