// The booking store the app talks to.
//
// Picks Postgres when Supabase is configured, and the in-memory store otherwise. Every
// function is async either way, so callers never need to know which is in use — the
// in-memory one is synchronous inside, and its results are simply awaited.
//
// The fallback exists so local development and the tests work with no database. It is the
// wrong behaviour in production: a missing SUPABASE_URL would quietly serve an empty arena
// and accept bookings that vanish. Making that a hard startup failure is item 2 on the
// go-live checklist.

import { supabaseStatus } from './supabase.js';
import * as memory from './demo-store.js';
import * as postgres from './supabase-store.js';

const usingPostgres = () => supabaseStatus().enabled;

/** Which store is live, for logging and the health endpoint. */
export function storeStatus() {
  const s = supabaseStatus();
  return {
    backend: s.enabled ? 'postgres' : 'memory',
    durable: s.enabled,
    problem: s.problem,
  };
}

const pick = () => (usingPostgres() ? postgres : memory);

// Resolved at call time, not import time, so tests and tooling can change the environment
// after this module has loaded.
export const bookingsFor            = (...a) => Promise.resolve(pick().bookingsFor(...a));
export const availabilityFor        = (...a) => Promise.resolve(pick().availabilityFor(...a));
export const gameSheetFor           = (...a) => Promise.resolve(pick().gameSheetFor(...a));
export const partySlotsFor          = (...a) => Promise.resolve(pick().partySlotsFor(...a));
export const statsFor               = (...a) => Promise.resolve(pick().statsFor(...a));
export const analyticsFor           = (...a) => Promise.resolve(pick().analyticsFor(...a));
export const findByCode             = (...a) => Promise.resolve(pick().findByCode(...a));
export const findByCheckoutSession  = (...a) => Promise.resolve(pick().findByCheckoutSession(...a));
export const isHeld                 = (...a) => Promise.resolve(pick().isHeld(...a));

export const addBooking             = (...a) => Promise.resolve(pick().addBooking(...a));
export const addParty               = (...a) => Promise.resolve(pick().addParty(...a));
export const blockSession           = (...a) => Promise.resolve(pick().blockSession(...a));
export const cancelBooking          = (...a) => Promise.resolve(pick().cancelBooking(...a));
export const releaseHeldGame        = (...a) => Promise.resolve(pick().releaseHeldGame(...a));
export const holdGame               = (...a) => Promise.resolve(pick().holdGame(...a));

// ----- Manager portal -----
export const listBookings           = (...a) => Promise.resolve(pick().listBookings(...a));
export const listCustomers          = (...a) => Promise.resolve(pick().listCustomers(...a));
export const listNotes              = (...a) => Promise.resolve(pick().listNotes(...a));
export const addNote                = (...a) => Promise.resolve(pick().addNote(...a));
export const setNoteDone            = (...a) => Promise.resolve(pick().setNoteDone(...a));
export const deleteNote             = (...a) => Promise.resolve(pick().deleteNote(...a));
