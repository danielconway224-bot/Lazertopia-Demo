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
