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
