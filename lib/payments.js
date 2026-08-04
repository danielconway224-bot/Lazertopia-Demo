// Stripe wiring for the checkout.
//
// Two rules this module exists to enforce:
//
//  1. TEST KEYS ONLY. This is a prototype. A live key here would charge real cards for a
//     demo booking, so a live key is refused outright rather than warned about.
//  2. The BROWSER NEVER SETS THE PRICE. The amount charged is always recomputed on the
//     server from the players/games the customer picked, using the same priceBooking() the
//     rest of the app uses. A tampered request gets the correct price, not the sent one.
//
// With no keys configured the app runs in simulated mode — the demo works end to end and
// nothing here is used.

import Stripe from 'stripe';

const TEST_SECRET = /^(sk|rk)_test_/;
const TEST_PUBLISHABLE = /^pk_test_/;
const LIVE = /^(sk|rk|pk)_live_/;

/**
 * Read and validate the Stripe environment.
 * @returns {{enabled:boolean, publishableKey:string|null, problem:string|null}}
 */
export function stripeStatus(env = process.env) {
  const secret = (env.STRIPE_SECRET_KEY || '').trim();
  const publishable = (env.STRIPE_PUBLISHABLE_KEY || '').trim();

  if (!secret && !publishable) {
    return { enabled: false, publishableKey: null, problem: null };   // simulated mode
  }
  if (LIVE.test(secret) || LIVE.test(publishable)) {
    return {
      enabled: false,
      publishableKey: null,
      problem: 'LIVE Stripe keys detected. This is a prototype — use test keys (sk_test_ / rk_test_ / pk_test_) only.',
    };
  }
  if (!secret || !publishable) {
    return {
      enabled: false,
      publishableKey: null,
      problem: 'Stripe is half-configured — both STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY are needed.',
    };
  }
  if (!TEST_SECRET.test(secret)) {
    return { enabled: false, publishableKey: null, problem: 'STRIPE_SECRET_KEY should start with sk_test_ or rk_test_.' };
  }
  if (!TEST_PUBLISHABLE.test(publishable)) {
    return { enabled: false, publishableKey: null, problem: 'STRIPE_PUBLISHABLE_KEY should start with pk_test_.' };
  }
  return { enabled: true, publishableKey: publishable, problem: null };
}

let client = null;

/** The Stripe client, or null when running simulated. */
export function getStripe(env = process.env) {
  if (!stripeStatus(env).enabled) return null;
  if (!client) client = new Stripe((env.STRIPE_SECRET_KEY || '').trim());
  return client;
}

/** Reset between tests, since the client is cached per process. */
export function _resetStripeClient() { client = null; }
