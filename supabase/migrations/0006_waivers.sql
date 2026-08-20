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
