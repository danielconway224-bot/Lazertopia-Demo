// Lasertopia booking demo — local development server.
//
// Serves the pages in /demo plus the same API app that runs on Vercel (lib/api-app.js).
// On Vercel, static files are served natively by the CDN and only /api/* hits a function;
// here one Express process does both.
//
// No Stripe, no database yet: checkout is simulated and bookings live in memory.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApiApp } from './lib/api-app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4242;

const app = express();

// The API — identical code path to production.
app.use(createApiApp());

// The browser imports lib/arena.js directly, so pricing and hours can't drift between
// what a customer is shown and what the server records. On Vercel these are served as
// plain static assets from the same /lib path.
app.use('/lib', express.static(path.join(__dirname, 'lib'), {
  setHeaders: (res) => res.setHeader('Content-Type', 'application/javascript; charset=utf-8'),
}));
app.use(express.static(path.join(__dirname, 'demo')));

// Pretty URLs. The same mapping lives in vercel.json for production.
const PAGES = {
  '/': 'index.html',
  '/rates': 'rates.html',
  '/packages': 'packages.html',
  '/hours': 'hours.html',
  '/waiver': 'waiver.html',
  '/manage': 'manage.html',
  '/admin': 'admin.html',
};
for (const [route, file] of Object.entries(PAGES)) {
  app.get(route, (_req, res) => res.sendFile(path.join(__dirname, 'demo', file)));
}

app.use((_req, res) => res.status(404).sendFile(path.join(__dirname, 'demo', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n🔫  Lasertopia booking demo — http://localhost:${PORT}`);
  console.log(`    Staff game sheet    — http://localhost:${PORT}/admin`);
  console.log('\n    Simulated checkout · in-memory bookings (reset on restart)\n');
});
