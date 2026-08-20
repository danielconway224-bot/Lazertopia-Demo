// Editable configuration, layered over the defaults in arena.js.
//
// arena.js stays the source of shape and the fallback: with no database, or no row, or a
// key a manager has never touched, the published values apply. This module holds only the
// difference.
//
// The values are applied by MUTATING the exported objects rather than by threading a
// config argument through every function. ES module exports are live bindings, so a page
// that imported ARENA sees the change — which is the point: a price edited in the portal
// has to reach the customer's screen without a deploy. The alternative was passing config
// into several hundred call sites.

import { ARENA, PACKAGES, EVENT_PACKAGES, WEEKLY_HOURS, SPECIAL_HOURS } from './arena.js';
import { supabaseStatus, getSupabase } from './supabase.js';

/** The defaults, captured before anything is applied, so a reset is possible. */
const DEFAULTS = {
  arena: { ...ARENA },
  packages: PACKAGES.map((p) => ({ ...p })),
  eventPackages: EVENT_PACKAGES.map((p) => ({ ...p })),
  weeklyHours: Object.fromEntries(Object.entries(WEEKLY_HOURS).map(([k, v]) => [k, [...v]])),
  specialHours: JSON.parse(JSON.stringify(SPECIAL_HOURS)),
};

export const settingDefaults = () => JSON.parse(JSON.stringify(DEFAULTS));

// Numbers a manager may change. Anything absent here is not editable from the portal —
// consecutiveGames, for instance, changes how bookings are held and is not a dial.
const EDITABLE_NUMBERS = [
  'capacity', 'minPlayers', 'sessionStepMin', 'lastGameBeforeCloseMin', 'onlineCutoffMin',
  'groupMinPlayers', 'groupNoticeHours', 'groupDiscountPct',
  'partyAgeSpreadYears', 'maxPartyGuestsOnline', 'maxPartyGuests', 'partySplitAbove',
  'partyDepositCents', 'partyChangeNoticeDays',
];

let cache = { at: 0, data: {} };
const TTL_MS = 15_000;

/** Put the live objects back to the published defaults. */
function reset() {
  Object.assign(ARENA, DEFAULTS.arena);
  PACKAGES.length = 0;
  PACKAGES.push(...DEFAULTS.packages.map((p) => ({ ...p })));
  EVENT_PACKAGES.length = 0;
  EVENT_PACKAGES.push(...DEFAULTS.eventPackages.map((p) => ({ ...p })));
  for (const k of Object.keys(WEEKLY_HOURS)) WEEKLY_HOURS[k] = [...DEFAULTS.weeklyHours[k]];
  for (const k of Object.keys(SPECIAL_HOURS)) delete SPECIAL_HOURS[k];
  Object.assign(SPECIAL_HOURS, JSON.parse(JSON.stringify(DEFAULTS.specialHours)));
}

/** Apply a saved patch on top of the defaults. */
export function applySettings(data = {}) {
  reset();

  for (const k of EDITABLE_NUMBERS) {
    const v = Number(data?.arena?.[k]);
    if (Number.isFinite(v) && v >= 0) ARENA[k] = v;
  }

  if (Array.isArray(data.packages)) {
    for (const p of data.packages) {
      const hit = PACKAGES.find((x) => x.games === Number(p.games));
      if (hit && Number.isFinite(Number(p.cents)) && Number(p.cents) >= 0) hit.cents = Number(p.cents);
    }
  }

  if (Array.isArray(data.eventPackages)) {
    for (const p of data.eventPackages) {
      const hit = EVENT_PACKAGES.find((x) => x.id === p.id);
      if (!hit) continue;
      if (Number.isFinite(Number(p.cents)) && Number(p.cents) >= 0) hit.cents = Number(p.cents);
      if (Number.isFinite(Number(p.extraGuestCents)) && Number(p.extraGuestCents) >= 0) {
        hit.extraGuestCents = Number(p.extraGuestCents);
      }
    }
  }

  if (data.weeklyHours && typeof data.weeklyHours === 'object') {
    for (const [day, pair] of Object.entries(data.weeklyHours)) {
      if (!(day in WEEKLY_HOURS) || !Array.isArray(pair) || pair.length !== 2) continue;
      const [open, close] = pair.map(Number);
      // A close before an open would generate no sessions at all and look like a bug.
      if (Number.isFinite(open) && Number.isFinite(close) && close > open) {
        WEEKLY_HOURS[day] = [open, close];
      }
    }
  }

  // Special hours REPLACE rather than merge: removing a dated exception has to be possible,
  // and a merge can only ever add.
  if (data.specialHours && typeof data.specialHours === 'object') {
    for (const k of Object.keys(SPECIAL_HOURS)) delete SPECIAL_HOURS[k];
    for (const [date, entry] of Object.entries(data.specialHours)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !entry) continue;
      SPECIAL_HOURS[date] = {
        hours: Array.isArray(entry.hours) ? entry.hours.map(Number) : null,
        note: String(entry.note || (entry.hours ? 'Special hours' : 'Closed')),
      };
    }
  }

  return data;
}

/**
 * Load and apply the saved settings.
 *
 * Cached briefly: config changes a few times a year and this runs on every request. With no
 * database configured the published defaults stand, which is exactly right.
 */
export async function loadSettings({ force = false } = {}) {
  if (!supabaseStatus().enabled) { applySettings({}); return {}; }
  if (!force && Date.now() - cache.at < TTL_MS) { applySettings(cache.data); return cache.data; }

  const { data, error } = await getSupabase()
    .from('settings').select('data').eq('id', 1).maybeSingle();

  if (error) {
    // Not installed is not a reason to serve nothing — fall back to the published values.
    if (!/schema cache|does not exist/i.test(error.message)) console.error('loadSettings:', error.message);
    applySettings(cache.data || {});
    return cache.data || {};
  }

  cache = { at: Date.now(), data: data?.data || {} };
  applySettings(cache.data);
  return cache.data;
}

export async function saveSettings(patch, who = '') {
  if (!supabaseStatus().enabled) {
    return { ok: false, status: 503, error: 'No database configured, so there is nowhere to save settings.' };
  }
  const { error } = await getSupabase()
    .from('settings')
    .upsert({ id: 1, data: patch, updated_at: new Date().toISOString(), updated_by: String(who || '') });

  if (error) {
    if (/schema cache|does not exist/i.test(error.message)) {
      return { ok: false, status: 503, error: 'Editable settings need supabase/migrations/0005_settings.sql run in the SQL Editor.' };
    }
    console.error('saveSettings:', error.message);
    return { ok: false, status: 502, error: "We couldn't save those settings." };
  }
  cache = { at: 0, data: patch };
  applySettings(patch);
  return { ok: true };
}
