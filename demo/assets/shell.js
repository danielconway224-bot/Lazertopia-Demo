// Shared page shell — header, footer, and the small helpers every page uses.
// Imported as an ES module so pages can also pull from /lib/arena.js directly.

import { ARENA } from '/lib/arena.js';

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Escape anything that came from a user or the API before putting it in innerHTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Both logos are served from /assets rather than hotlinked, so the pages don't depend on
// anyone else's CDN staying up and render instantly.
const LOGO = '/assets/lasertopia-logo.png';
const VOLTRIS_LOGO = '/assets/voltris-booking.png';
const VOLTRIS_URL = 'https://www.voltrisbooking.com';

const NAV = [
  { href: '/',         label: 'Book a game' },
  { href: '/rates',    label: 'Rates' },
  { href: '/packages', label: 'Parties' },
  { href: '/hours',    label: 'Hours' },
  { href: '/waiver',   label: 'Waiver', cta: true },
];

/**
 * Render the demo banner, header and footer into the page.
 * @param {{active?: string, banner?: string}} opts
 */
export function mountShell({ active = '', banner = '' } = {}) {
  const bannerText = banner
    || 'Booking demo for Lasertopia · real rates, hours &amp; packages · checkout is simulated (no real charge)';

  // Inline favicon — a laser-burst dot in the brand colours. Saves a request and a 404.
  const favicon = 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
       <rect width="32" height="32" rx="7" fill="#07070C"/>
       <circle cx="16" cy="16" r="5" fill="#FFE000"/>
       <g stroke="#29ABE2" stroke-width="2" stroke-linecap="round">
         <path d="M16 2v6M16 24v6M2 16h6M24 16h6"/>
       </g>
       <g stroke="#F9A11B" stroke-width="1.6" stroke-linecap="round">
         <path d="M6 6l4 4M26 6l-4 4M6 26l4-4M26 26l-4-4"/>
       </g>
     </svg>`);
  document.head.insertAdjacentHTML('beforeend', `<link rel="icon" href="${favicon}" />`);

  const links = NAV.map((n) => {
    const cls = ['nav-link', n.cta ? 'cta' : '', n.href === active ? 'active' : ''].filter(Boolean).join(' ');
    return `<a class="${cls}" href="${n.href}">${n.label}</a>`;
  }).join('');

  document.body.insertAdjacentHTML('afterbegin', `
    <div class="demo-banner"><b>PROTOTYPE</b> — ${bannerText}</div>
    <header>
      <div class="wrap nav">
        <a class="brand" href="/">
          <img src="${LOGO}" alt="Lasertopia"
               onerror="this.style.display='none';this.nextElementSibling.style.display='block'" />
          <span class="brand-fallback" style="display:none"><span class="a">LASER</span><span class="b">TOPIA</span></span>
        </a>
        <nav class="nav-links">${links}</nav>
      </div>
    </header>`);

  document.body.insertAdjacentHTML('beforeend', `
    <footer>
      <div class="ft-brand">Lasertopia Inc.</div>
      <div>${esc(ARENA.address)} · <a href="tel:${ARENA.phone.replace(/\D/g, '')}">${esc(ARENA.phone)}</a></div>
      <div style="margin-top:8px">
        <a href="/manage">Find my booking</a> ·
        <a href="/hours">Hours</a> ·
        <a href="/admin">Staff game sheet</a>
      </div>
      <div style="margin-top:10px;font-size:12px;opacity:.7">Booking prototype</div>
      <a class="powered" href="${VOLTRIS_URL}" target="_blank" rel="noopener noreferrer"
         aria-label="Powered by Voltris Booking — opens voltrisbooking.com in a new tab">
        <span class="pb-label">Powered by</span>
        <span class="pb-mark">
          <img src="${VOLTRIS_LOGO}" alt="Voltris" />
          <span class="pb-booking">Booking</span>
        </span>
      </a>
    </footer>`);

  mountViewSwitch();
}

/**
 * Bottom-right switch between what a customer sees and what the front desk sees.
 *
 * Returning to the customer side goes to `/` rather than the previous page, because the
 * staff view has no customer-side counterpart to go "back" to.
 */
function mountViewSwitch() {
  const onStaff = location.pathname.startsWith('/admin');

  const eyeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
    stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const deskIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
    stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 10h18M8 18v2M16 18v2"/></svg>`;

  document.body.insertAdjacentHTML('beforeend', `
    <div class="view-switch" role="navigation" aria-label="Switch between customer and staff view">
      <span class="vs-label">View</span>
      <a class="vs-btn${onStaff ? '' : ' active'}" href="/"
         ${onStaff ? '' : 'aria-current="page"'}>${eyeIcon}Customer</a>
      <a class="vs-btn staff${onStaff ? ' active' : ''}" href="/admin"
         ${onStaff ? 'aria-current="page"' : ''}>${deskIcon}Staff</a>
    </div>`);
}

/** Brief message at the bottom of the screen. */
export function toast(msg) {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._hide);
  t._hide = setTimeout(() => t.classList.remove('show'), 4200);
}

/**
 * fetch + JSON with the server's error message preserved.
 * Every API error in this app is written to be shown to a human as-is.
 */
export async function api(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (e) {
    throw new Error('Could not reach the booking server. Check your connection and try again.');
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Something went wrong (${res.status}). Please try again.`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const jsonPost = (url, body) => api(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** 'YYYY-MM-DD' -> 'Monday, Jul 27'. */
export function longDate(dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}
