// Shared page shell — header, footer, and the small helpers every page uses.
// Imported as an ES module so pages can also pull from /lib/arena.js directly.

import { ARENA, arenaToday, parseISO } from '/lib/arena.js';

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
const VOLTRIS_LOGO = '/assets/voltrisbooking-text-2x.png';
const VOLTRIS_URL = 'https://www.voltrisbooking.com';

const NAV = [
  { href: '/',         label: 'Book a game' },
  { href: '/rates',    label: 'Rates' },
  { href: '/packages', label: 'Parties' },
  { href: '/hours',    label: 'Hours' },
  { href: '/waiver',   label: 'Waiver', cta: true },
];

/**
 * Render the header and footer into the page.
 *
 * `banner` shows a notice strip across the top — closures, holiday hours, that sort of
 * thing. Off unless a page asks for it.
 *
 * @param {{active?: string, banner?: string, chrome?: 'customer'|'staff'}} opts
 */
export function mountShell({ active = '', banner = '', chrome = 'customer' } = {}) {

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

  // The staff page has no use for customer navigation — booking, rates and waivers are
  // the customer's journey, not the front desk's. It gets a role badge instead, and the
  // view switch is how staff get back to the customer side.
  const links = chrome === 'staff'
    ? '<span class="staff-badge">Admin</span>'
    : NAV.map((n) => {
        const cls = ['nav-link', n.cta ? 'cta' : '', n.href === active ? 'active' : ''].filter(Boolean).join(' ');
        return `<a class="${cls}" href="${n.href}">${n.label}</a>`;
      }).join('');

  document.body.insertAdjacentHTML('afterbegin', `
    ${banner ? `<div class="demo-banner">${esc(banner)}</div>` : ''}
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
      ${chrome === 'staff' ? '' : `<div style="margin-top:8px">
        <a href="/manage">Find my booking</a> ·
        <a href="/hours">Hours</a>
      </div>`}
      <a class="powered" href="${VOLTRIS_URL}" target="_blank" rel="noopener noreferrer"
         aria-label="Powered by Voltris Booking — opens voltrisbooking.com in a new tab">
        <span class="pb-label">Powered by</span>
        <span class="pb-plate"><img src="${VOLTRIS_LOGO}" alt="Voltris Booking" /></span>
      </a>
    </footer>`);

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

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad2 = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/**
 * Turn a container into a date field that opens a calendar pop-up.
 *
 * Built on the same `.cal-*` markup as the booking page's inline calendar, so closed days,
 * special-hours dots and the selected state all look identical wherever a date gets picked.
 *
 * @param {HTMLElement} host        empty element to build into
 * @param {object}      opts
 * @param {string}      opts.value      initially selected 'YYYY-MM-DD' (optional)
 * @param {(iso:string)=>({closed?:boolean, special?:boolean, title?:string})} opts.dayInfo
 *        per-day state, so the caller decides what's bookable
 * @param {(iso:string)=>void} opts.onPick  called when a date is chosen
 * @param {string}      opts.placeholder
 * @param {Array<{color:string,label:string}>} opts.legend
 * @returns {{ value:()=>string|null, set:(iso:string)=>void, close:()=>void }}
 */
export function mountDateField(host, opts = {}) {
  const { dayInfo = () => ({}), onPick = () => {}, placeholder = 'Pick a date', legend = [] } = opts;

  // Winnipeg's today, so past days grey out against the arena's clock not the visitor's.
  const today = parseISO(arenaToday());

  let value = opts.value || null;
  let month = new Date((value ? new Date(value + 'T00:00:00') : today).getFullYear(),
                       (value ? new Date(value + 'T00:00:00') : today).getMonth(), 1);

  host.classList.add('datefield');
  host.innerHTML = `
    <button type="button" class="datefield-btn">
      <span class="df-text"></span>
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
      </svg>
    </button>
    <div class="calpop-backdrop"></div>
    <div class="calpop" role="dialog" aria-label="Choose a date">
      <div class="cal-head">
        <div class="cal-title"></div>
        <div class="cal-nav">
          <button type="button" class="cal-btn df-prev" aria-label="Previous month">‹</button>
          <button type="button" class="cal-btn df-next" aria-label="Next month">›</button>
        </div>
      </div>
      <div class="cal-grid df-grid"></div>
      ${legend.length ? `<div class="cal-key">${legend
        .map((l) => `<span><i style="background:${l.color}"></i> ${esc(l.label)}</span>`).join('')}</div>` : ''}
    </div>`;

  const btn = host.querySelector('.datefield-btn');
  const pop = host.querySelector('.calpop');
  const backdrop = host.querySelector('.calpop-backdrop');
  const grid = host.querySelector('.df-grid');
  const title = host.querySelector('.cal-title');
  const label = host.querySelector('.df-text');

  function paintLabel() {
    if (value) { label.textContent = longDate(value); label.classList.remove('placeholder'); }
    else { label.textContent = placeholder; label.classList.add('placeholder'); }
  }

  function paintGrid() {
    title.textContent = `${MONTHS[month.getMonth()]} ${month.getFullYear()}`;
    host.querySelector('.df-prev').disabled =
      month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth();

    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();

    let html = DOW.map((d) => `<div class="cal-dow">${d}</div>`).join('');
    for (let i = 0; i < first.getDay(); i++) html += '<div class="cal-day empty"></div>';

    for (let day = 1; day <= days; day++) {
      const d = new Date(month.getFullYear(), month.getMonth(), day);
      const iso = toISO(d);
      const info = dayInfo(iso) || {};
      const past = d < today;

      const cls = ['cal-day'];
      if (past) cls.push('past');
      if (info.closed && !past) cls.push('closed');
      if (iso === toISO(today)) cls.push('today');
      if (iso === value) cls.push('sel');

      const mark = (!past && (info.closed || info.special)) ? '<span class="mark"></span>' : '';
      const pickable = !past && !info.closed;
      html += `<div class="${cls.join(' ')}"${pickable ? ` data-date="${iso}"` : ''}${info.title ? ` title="${esc(info.title)}"` : ''}>${day}${mark}</div>`;
    }
    grid.innerHTML = html;

    grid.querySelectorAll('[data-date]').forEach((el) => {
      el.onclick = () => {
        value = el.dataset.date;
        paintLabel();
        close();
        onPick(value);
      };
    });
  }

  /** Flip the popover above the field, or right-align it, when it would leave the screen. */
  function place() {
    pop.classList.remove('drop-up', 'align-right');
    if (window.innerWidth <= 560) return;          // centred sheet on phones
    const r = btn.getBoundingClientRect();
    const h = pop.offsetHeight || 340;
    if (r.bottom + h + 12 > window.innerHeight && r.top - h - 12 > 0) pop.classList.add('drop-up');
    if (r.left + pop.offsetWidth + 12 > window.innerWidth) pop.classList.add('align-right');
  }

  function open() {
    month = new Date((value ? new Date(value + 'T00:00:00') : today).getFullYear(),
                     (value ? new Date(value + 'T00:00:00') : today).getMonth(), 1);
    paintGrid();
    pop.classList.add('show');
    backdrop.classList.add('show');
    btn.classList.add('open');
    place();
  }
  function close() {
    pop.classList.remove('show');
    backdrop.classList.remove('show');
    btn.classList.remove('open');
  }

  btn.onclick = (e) => { e.stopPropagation(); pop.classList.contains('show') ? close() : open(); };
  backdrop.onclick = close;
  pop.onclick = (e) => e.stopPropagation();
  host.querySelector('.df-prev').onclick = (e) => {
    e.stopPropagation();
    month = new Date(month.getFullYear(), month.getMonth() - 1, 1);
    paintGrid();
  };
  host.querySelector('.df-next').onclick = (e) => {
    e.stopPropagation();
    month = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    paintGrid();
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop.classList.contains('show')) close(); });
  addEventListener('resize', () => { if (pop.classList.contains('show')) place(); });

  paintLabel();

  return {
    value: () => value,
    set: (iso) => { value = iso; paintLabel(); },
    close,
  };
}
