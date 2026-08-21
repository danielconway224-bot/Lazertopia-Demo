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

/* ---------- 2. Migrations ----------
 *
 * Each migration is identified by something it CREATES, probed directly, rather than by a
 * version table. That means it works on a database that has been migrated by hand, in any
 * order, with no bookkeeping to get out of step with reality — and it tells you the one
 * thing you actually want to know: which file to run next.
 *
 * Probe a real column, never select('*'): PostgREST answers a star select without complaint
 * for a table that does not exist, which once reported a schema that was never installed as
 * fully present.
 */
console.log('\nMigrations');

const MIGRATIONS = [
  { file: '0001_init.sql',                 what: 'bookings, parties, holds, messages',
    probe: () => db.from('bookings').select('id,code,date,start_min,checkout_session_id').limit(1) },
  { file: '0002_atomic_booking.sql',       what: 'no-oversell booking functions',
    rpc: 'book_session' },
  { file: '0003_portal.sql',               what: 'notes and the customers view',
    probe: () => db.from('notes').select('id,body,kind,done').limit(1) },
  { file: '0004_party_slot_overrides.sql', what: 'editable party schedule',
    probe: () => db.from('party_slot_overrides').select('date,slot_start,rooms,games').limit(1) },
  { file: '0005_settings.sql',             what: 'editable prices and hours',
    probe: () => db.from('settings').select('id,data').limit(1) },
  { file: '0006_waivers.sql',              what: 'signed waivers',
    probe: () => db.from('waivers').select('id,first_name,email,terms_version').limit(1) },
  { file: '0007_party_deposit.sql',        what: 'party deposits and extra food',
    probe: () => db.from('party_details').select('booking_id,food,food_cents').limit(1) },
];

const pending = [];
for (const m of MIGRATIONS) {
  let missing;
  if (m.rpc) {
    // A function cannot be probed by selecting from it, and calling it with NO arguments
    // reports the zero-argument overload missing whether or not the real one exists — which
    // is how this first reported an applied migration as pending.
    //
    // So call it properly, with a capacity of zero: it raises session_full before reaching
    // the insert, which proves the function is there and changes nothing.
    const { error } = await db.rpc(m.rpc, {
      p_code: 'ZZ-PROBE', p_date: '2099-12-31', p_start_min: 720,
      p_games: 1, p_players: 1, p_kind: 'online', p_capacity: 0,
    });
    missing = /could not find the function/i.test(String(error?.message || ''));
  } else {
    const { error } = await m.probe();
    missing = !!error;
  }
  if (missing) { pending.push(m); bad(`${m.file.padEnd(30)} not run — ${m.what}`); }
  else ok(`${m.file.padEnd(30)} ${m.what}`);
}

if (pending.length) {
  failures += pending.length;
  console.log('');
  console.log(`  \x1b[33mRun ${pending.length === 1 ? 'this file' : 'these files'}, oldest first:\x1b[0m`);
  for (const m of pending) console.log(`    supabase/migrations/${m.file}`);
  console.log('');
  console.log('  Only the ones listed — the rest are already applied. supabase/RUN_ALL.sql');
  console.log('  is every migration at once and is for setting up a NEW database.');
  console.log('');
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
