// Supabase connection.
//
// Follows the same fail-safe rule as payments and messaging: with nothing configured the
// app does not error, it falls back to the in-memory demo store. That keeps the deployed
// site working while the database is being built out.

import { createClient } from '@supabase/supabase-js';

let client = null;

/**
 * What's configured, and why not if not. Safe to expose — carries no secrets.
 * @returns {{enabled:boolean, url:string|null, problem:string|null}}
 */
export function supabaseStatus(env = process.env) {
  const url = (env.SUPABASE_URL || '').trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!url && !key) {
    return { enabled: false, url: null, problem: null };   // in-memory mode, a valid state
  }
  if (!url || !key) {
    return {
      enabled: false,
      url: null,
      problem: 'Supabase is half-configured — both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed.',
    };
  }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url)) {
    return {
      enabled: false,
      url: null,
      problem: `SUPABASE_URL should look like https://yourproject.supabase.co — got "${url}".`,
    };
  }
  // The public key is safe in a browser; the secret one is not. Pasting the public key
  // here leaves every write silently denied by RLS with no obvious cause, so it is worth
  // catching by name. Supabase is mid-migration between two key formats and both turn up
  // in the wild, so check for both:
  //   legacy  — a JWT carrying "role":"anon"
  //   current — an opaque key prefixed sb_publishable_
  const looksPublic = key.startsWith('sb_publishable_') || /"role":"anon"/.test(safeDecodeJwt(key));
  if (looksPublic) {
    return {
      enabled: false,
      url: null,
      problem: 'SUPABASE_SERVICE_ROLE_KEY holds the PUBLIC key. Use the secret one instead — '
             + 'Project Settings → API, the key marked secret (sb_secret_… or service_role).',
    };
  }

  // And the reverse: a secret key left in the anon slot would be handed to browsers the
  // moment staff sign-in ships. Cheap to catch now rather than after it leaks.
  const anon = (env.SUPABASE_ANON_KEY || '').trim();
  if (anon.startsWith('sb_secret_') || /"role":"service_role"/.test(safeDecodeJwt(anon))) {
    return {
      enabled: false,
      url: null,
      problem: 'SUPABASE_ANON_KEY holds a SECRET key. That key is meant to be public — '
             + 'use the publishable one (sb_publishable_… or anon).',
    };
  }

  return { enabled: true, url, problem: null };
}

/** Decode a JWT payload far enough to read its role claim. Never throws. */
function safeDecodeJwt(token) {
  try {
    const body = token.split('.')[1];
    return Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch (_) {
    return '';
  }
}

/** The Supabase client, or null when running in-memory. Cached per process. */
export function getSupabase(env = process.env) {
  if (!supabaseStatus(env).enabled) return null;
  if (!client) {
    client = createClient(env.SUPABASE_URL.trim(), env.SUPABASE_SERVICE_ROLE_KEY.trim(), {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'public' },
    });
  }
  return client;
}

/** Reset between tests, since the client is cached per process. */
export function _resetSupabaseClient() { client = null; }
