#!/usr/bin/env node
//
// Verify the Supabase connection, schema and atomic booking functions.
//
//   npm run check-db
//
// Run this after pasting your keys into .env and running the migrations. It answers, in
// order: are the credentials right, is the schema there, do the functions work, and is
// the data actually protected. It writes one test row and deletes it again.

import 'dotenv/config';
import { supabaseStatus, getSupabase } from '../lib/supabase.js';

const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad  = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`  \x1b[2m·\x1b[0m ${m}`);

let failures = 0;
const fail = (m) => { bad(m); failures++; };

console.log('\nLasertopia — database check\n');

/* ---------- 1. Credentials ---------- */
console.log('Credentials');
const status = supabaseStatus();
if (status.problem) {
  fail(status.problem);
  console.log('\nFix .env and run again.\n');
  process.exit(1);
}
if (!status.enabled) {
  info('No Supabase configured — the app is running on the in-memory demo store.');
  info('Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env to use a real database.');
  console.log('');
  process.exit(0);
}
ok(`configured for ${status.url}`);

const db = getSupabase();

/* ---------- 2. Schema ---------- */
console.log('\nSchema');
// Probe a column the migration actually creates. `select('*')` is not enough — PostgREST
// answers it without complaint for a table that does not exist, which silently reported
// a schema that was never installed as present.
const TABLES = [
  ['bookings',       'id,code,date,start_min,games,players,kind,checkout_session_id'],
  ['party_details',  'booking_id,slot_start,rooms,positions,deposit_state'],
  ['hold_overrides', 'date,start_min,state'],
  ['messages',       'id,channel,state'],
];
for (const [table, columns] of TABLES) {
  const { error } = await db.from(table).select(columns).limit(1);
  if (error) {
    fail(`${table} — ${error.message}`);
  } else {
    ok(`${table}`);
  }
}

if (failures) {
  console.log('\nRun the migrations first: paste supabase/migrations/*.sql into the');
  console.log('Supabase SQL Editor, oldest first, and run each one.\n');
  process.exit(1);
}

/* ---------- 3. Atomic functions ---------- */
console.log('\nAtomic allocation');

// A date far enough out that it can never collide with real data.
const TEST_DATE = '2099-12-31';
const stamp = Date.now().toString(36).toUpperCase().slice(-6);
const code = `ZZ-${stamp}`;

const { data: booked, error: bookErr } = await db.rpc('book_session', {
  p_code: code,
  p_date: TEST_DATE,
  p_start_min: 12 * 60,
  p_games: 1,
  p_players: 2,
  p_kind: 'online',
  p_capacity: 25,
  p_name: 'Connection check',
});

if (bookErr) {
  fail(`book_session — ${bookErr.message}`);
} else {
  ok(`book_session created ${booked.code}`);

  // The whole point of the function: a booking that would exceed capacity is refused
  // rather than written.
  const { error: fullErr } = await db.rpc('book_session', {
    p_code: `${code}-X`,
    p_date: TEST_DATE,
    p_start_min: 12 * 60,
    p_games: 1,
    p_players: 24,          // 2 already taken, so 24 more will not fit in 25
    p_kind: 'online',
    p_capacity: 25,
    p_name: 'Should be refused',
  });

  if (fullErr && /session_full/.test(fullErr.message)) {
    ok('overselling is refused (session_full)');
  } else if (fullErr) {
    fail(`expected session_full, got: ${fullErr.message}`);
  } else {
    fail('a booking that should not fit was accepted — capacity is NOT being enforced');
  }

  // Clean up whatever survived.
  await db.from('bookings').delete().eq('date', TEST_DATE);
  ok('test rows removed');
}

/* ---------- 4. Row Level Security ---------- */
console.log('\nSecurity');
const anon = (process.env.SUPABASE_ANON_KEY || '').trim();
if (!anon) {
  info('SUPABASE_ANON_KEY not set — skipping the public-access check.');
  info('Worth setting: this is the check that proves customer data is not readable.');
} else {
  const { createClient } = await import('@supabase/supabase-js');
  const pub = createClient(process.env.SUPABASE_URL.trim(), anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await pub.from('bookings').select('id').limit(1);
  if (error || (Array.isArray(data) && data.length === 0)) {
    ok('bookings are not readable with the public anon key');
  } else {
    fail('bookings ARE readable with the anon key — row level security is not protecting them');
  }
}

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} problem${failures === 1 ? '' : 's'} found.\x1b[0m\n`);
  process.exit(1);
}
console.log('\x1b[32mDatabase is ready.\x1b[0m\n');
