// Vercel serverless entry point for the JSON API.
//
// vercel.json rewrites every /api/* request here. An Express app is already a
// (req, res) handler, so it can be exported directly as the function.
//
// Heads up: each Vercel invocation may run in a fresh process, so the in-memory
// booking store in lib/demo-store.js is NOT reliably shared between requests in
// production. The in-memory fallback starts empty and keeps nothing between requests,
// but bookings made during a session can vanish on a cold start. Durable shared
// state is what Supabase will provide — see the README.

import { createApiApp } from '../lib/api-app.js';

export default createApiApp();
