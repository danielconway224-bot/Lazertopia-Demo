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
