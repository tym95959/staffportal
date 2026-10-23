// Shared code for every page: Firebase init, auth guard, nav, notifications, helpers.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, updateDoc, collection, query, where, orderBy, limit,
  onSnapshot, writeBatch, arrayUnion, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

export {
  doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, collection, query, where, orderBy, limit,
  onSnapshot, serverTimestamp, increment, arrayUnion, arrayRemove, writeBatch, deleteField
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

if (!self.FIREBASE_CONFIG || !self.FIREBASE_CONFIG.apiKey) {
  document.body.innerHTML = `<div class="wrap"><div class="card"><h2>Setup needed</h2>
    <p>Add your Firebase web app config to <code>js/config.js</code>. Follow README.md, step 2.</p></div></div>`;
  throw new Error('Firebase config missing in js/config.js');
}

export const app = initializeApp(self.FIREBASE_CONFIG);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const APP_NAME = self.APP_NAME || 'Staff Portal';

/* ---------------- small helpers ---------------- */
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const ym = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export const parseYmd = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d || 1); };
export const today = () => ymd(new Date());
export const daysInMonth = month => { const [y, m] = month.split('-').map(Number); return new Date(y, m, 0).getDate(); };
export function dateRange(from, to) {
  const out = []; if (!from || !to) return out;
  const d = parseYmd(from), end = parseYmd(to);
  while (d <= end && out.length < 400) { out.push(ymd(d)); d.setDate(d.getDate() + 1); }
  return out;
}
export const fmtDate = s => s ? parseYmd(s).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—';
export const fmtShort = s => s ? parseYmd(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—';
export const fmtTs = ts => ts?.toDate ? ts.toDate().toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export const tsMillis = ts => ts?.toMillis?.() ?? 0;
export const byNewest = (a, b) => tsMillis(b.createdAt) - tsMillis(a.createdAt);
export const pill = s => `<span class="pill ${esc(s)}">${esc(s)}</span>`;
export const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
export const isWeekend = d => (self.WEEKEND_DAYS || [5, 6]).includes(parseYmd(d).getDay());

/* ---------------- company / department context ----------------
   Filled in by requireUser(). Rosters and leave calendars are stored per department:
   rosters/{orgId}__{deptId}__{YYYY-MM}   leaveCalendar/{orgId}__{deptId}__{YYYY} */
export const ctx = { orgId: null, deptId: null, org: null, dept: null };
export const rosterId = (month, orgId = ctx.orgId, deptId = ctx.deptId) => `${orgId}__${deptId}__${month}`;
export const calId = (year, orgId = ctx.orgId, deptId = ctx.deptId) => `${orgId}__${deptId}__${year}`;
export const ROLE_LABEL = { staff: 'Staff', deptadmin: 'Department admin', admin: 'Company admin', super: 'Platform owner' };
export const isManager = p => ['admin', 'deptadmin', 'super'].includes(p?.role);

export function toast(msg, type = '', ms = 4200) {
  let host = $('.toast-host');
  if (!host) { host = document.createElement('div'); host.className = 'toast-host'; document.body.append(host); }
  const t = document.createElement('div'); t.className = `toast ${type}`; t.textContent = msg; host.append(t);
  setTimeout(() => t.remove(), ms);
}
export function busy(btn, on, label = 'Please wait…') {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}

/** Call a Vercel serverless function with the signed-in user's ID token. */
export async function api(path, body) {
  const token = await auth.currentUser.getIdToken();
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

/* ---------------- roster helpers ---------------- */
const rosterCache = new Map();
export async function loadRoster(month, fresh = false) {
  const id = rosterId(month);
  if (!fresh && rosterCache.has(id)) return rosterCache.get(id);
  const s = await getDoc(doc(db, 'rosters', id)).catch(() => null);
  const r = s?.exists() ? s.data() : null;
  rosterCache.set(id, r); return r;
}
export async function shiftOn(uid, date) {
  const r = await loadRoster(date.slice(0, 7));
  return r?.rows?.[uid]?.[Number(date.slice(8)) - 1] || '';
}
export const shiftLabel = (code, legend = {}) => code ? (legend[code] ? `${code} – ${legend[code]}` : code) : 'Not rostered';
export const OFF_CODES = ['OFF', 'O', 'X', '-', 'AL', 'SL', 'FRL', 'PH'];
/** Colour class for a shift code (used on roster cells and duty cards). */
const SHIFT_COLORS = { M: 'amber', AM: 'amber', D: 'amber', MOR: 'amber', E: 'violet', PM: 'violet', A: 'violet', EVE: 'violet',
  N: 'indigo', NT: 'indigo', NIGHT: 'indigo', OFF: 'grey', O: 'grey', X: 'grey', '-': 'grey', R: 'grey',
  AL: 'green', SL: 'rose', FRL: 'rose', ML: 'rose', PH: 'teal', H: 'teal' };
const HASH_COLORS = ['sky', 'teal', 'amber', 'violet', 'indigo', 'green'];
export function shiftClass(code) {
  code = String(code || '').toUpperCase(); if (!code) return '';
  if (SHIFT_COLORS[code]) return 'sc-' + SHIFT_COLORS[code];
  let h = 0; for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 'sc-' + HASH_COLORS[h % HASH_COLORS.length];
}

/* ---------------- leave calendar ---------------- */
/** cal = {quota:{date:n}, booked:{date:n}, defaultQuota} */
export function dayStatus(cal, d) {
  const q = cal?.quota?.[d] ?? cal?.defaultQuota ?? null;
  const b = cal?.booked?.[d] || 0;
  const state = q === null || q === undefined ? 'unset' : q === 0 ? 'closed' : b >= q ? 'full' : 'open';
  return { q, b, state, left: q ? Math.max(q - b, 0) : null };
}
export function calendarHTML(year, month, cal, sel = new Set()) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Monday first
  const n = new Date(year, month + 1, 0).getDate();
  const t = today();
  let h = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => `<div class="dow">${x}</div>`).join('');
  for (let i = 0; i < lead; i++) h += '<div class="day blank"></div>';
  for (let i = 1; i <= n; i++) {
    const d = `${year}-${pad(month + 1)}-${pad(i)}`;
    const s = dayStatus(cal, d);
    const txt = s.state === 'unset' ? (s.b ? `${s.b} on leave` : '') : s.state === 'closed' ? 'No leave' : `${s.b}/${s.q} taken`;
    h += `<button type="button" class="day ${s.state === 'unset' ? '' : s.state} ${sel.has(d) ? 'sel' : ''} ${d === t ? 'today' : ''}" data-date="${d}">
      <div class="n">${i}</div><div class="q">${txt}</div></button>`;
  }
  return h;
}
export const CAL_LEGEND = `<div class="legend"><span><i style="background:var(--ok-soft)"></i>Slots available</span>
  <span><i style="background:var(--bad-soft)"></i>Fully booked</span><span><i style="background:#eceeee"></i>No leave allowed</span>
  <span><i style="background:#fff"></i>Not set by admin</span></div>`;

/* ---------------- push notifications ---------------- */
let messagingMod = null;
async function messagingSetup() {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) throw new Error('This browser does not support push. On iPhone, open the portal in Safari, tap Share → "Add to Home Screen", then enable notifications from the home-screen app.');
  if (!self.FCM_VAPID_KEY) throw new Error('Push is not configured yet (FCM_VAPID_KEY missing in js/config.js).');
  messagingMod = messagingMod || await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js');
  if (!(await messagingMod.isSupported())) throw new Error('Push notifications are not supported on this browser.');
  const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
  const messaging = messagingMod.getMessaging(app);
  return { reg, messaging };
}
export async function enablePush(uid) {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were blocked. Allow them in your browser/phone settings for this site.');
  const { reg, messaging } = await messagingSetup();
  const token = await messagingMod.getToken(messaging, { vapidKey: self.FCM_VAPID_KEY, serviceWorkerRegistration: reg });
  if (!token) throw new Error('Could not get a push token.');
  await updateDoc(doc(db, 'users', uid), { fcmTokens: arrayUnion(token), updatedAt: serverTimestamp() });
  listenForeground(messaging);
  return token;
}
let fgBound = false;
function listenForeground(messaging) {
  if (fgBound) return; fgBound = true;
  messagingMod.onMessage(messaging, p => toast(`🔔 ${p.notification?.title || ''} — ${p.notification?.body || ''}`, '', 7000));
}
async function refreshPushSilently(uid) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const { reg, messaging } = await messagingSetup();
    const token = await messagingMod.getToken(messaging, { vapidKey: self.FCM_VAPID_KEY, serviceWorkerRegistration: reg });
    if (token && localStorage.getItem('fcm:' + uid) !== token) {
      await updateDoc(doc(db, 'users', uid), { fcmTokens: arrayUnion(token), updatedAt: serverTimestamp() });
      try { localStorage.setItem('fcm:' + uid, token); } catch {}
    }
    listenForeground(messaging);
  } catch (e) { console.warn('push refresh', e); }
}
export const pushEnabled = () => 'Notification' in window && Notification.permission === 'granted';

/* ---------------- nav + notifications bell ---------------- */
const ICON = {
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>'
};
const initials = n => String(n || 'SP').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'SP';
const NAV = [
  ['dashboard.html', 'Dashboard'], ['report.html', 'SL / FRL Report'], ['leave.html', 'Annual Leave'],
  ['roster.html', 'Duty Roster'], ['swap.html', 'Duty Change'], ['password.html', 'Password']
];
function renderNav(profile) {
  const here = location.pathname.split('/').pop() || 'dashboard.html';
  const links = profile?.role === 'super' ? [['admin.html', 'Admin'], ['password.html', 'Password']]
    : [...NAV, ...(isManager(profile) ? [['admin.html', 'Admin']] : [])];
  const brandName = ctx.org?.shortName || ctx.org?.name || APP_NAME;
  const header = $('#topbar'); header.className = 'topbar';
  header.innerHTML = `<div class="inner">
    <a class="brand" href="${profile?.role === 'super' ? '/admin.html' : '/dashboard.html'}"><span class="mark">${esc(initials(brandName))}</span><span>${esc(brandName)}</span></a>
    <nav class="nav" id="nav">${profile ? links.map(([h, t]) => `<a href="/${h}" class="${here === h || here === h.replace('.html', '') ? 'active' : ''}">${t}</a>`).join('') : ''}</nav>
    <div class="top-actions">
      ${profile ? `<div class="bell"><button class="icon-btn" id="bellBtn" aria-label="Notifications">${ICON.bell}<span class="badge" id="bellBadge" hidden>0</span></button>
      <div class="notif-panel" id="notifPanel"><div class="notif-head">Notifications</div><div id="notifList"><div class="empty">No notifications yet</div></div></div></div>` : ''}
      <button class="icon-btn" id="signOutBtn" title="Sign out" aria-label="Sign out">${ICON.out}</button>
      ${profile ? `<button class="icon-btn menu-toggle" id="menuBtn" aria-label="Menu">${ICON.menu}</button>` : ''}
    </div></div>`;
  $('#signOutBtn').onclick = async () => { await signOut(auth); location.href = '/index.html'; };
  if (!profile) return;
  $('#menuBtn').onclick = () => $('#nav').classList.toggle('open');
  $('#bellBtn').onclick = e => { e.stopPropagation(); $('#notifPanel').classList.toggle('open'); };
  document.addEventListener('click', e => { if (!e.target.closest('.bell')) $('#notifPanel')?.classList.remove('open'); });
}
function watchNotifications(uid) {
  const q = query(collection(db, 'notifications'), where('uid', '==', uid), orderBy('createdAt', 'desc'), limit(25));
  onSnapshot(q, snap => {
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const unread = items.filter(i => !i.read);
    const badge = $('#bellBadge'); badge.hidden = !unread.length; badge.textContent = unread.length;
    $('#notifList').innerHTML = items.length ? items.map(i => `<a class="notif-item ${i.read ? '' : 'unread'}" data-id="${i.id}" data-link="${esc(i.link || '')}">
      <div class="t">${esc(i.title)}</div><div class="b">${esc(i.body)}</div><div class="w">${fmtTs(i.createdAt)}</div></a>`).join('')
      : '<div class="empty">No notifications yet</div>';
    $$('#notifList .notif-item').forEach(a => a.onclick = async () => {
      const batch = writeBatch(db); batch.update(doc(db, 'notifications', a.dataset.id), { read: true });
      await batch.commit().catch(() => {});
      if (a.dataset.link) location.href = a.dataset.link;
    });
  }, err => console.warn('notifications', err));
}

/* ---------------- auth guard ---------------- */
/**
 * Waits for sign-in, loads the user's profile and renders the nav.
 * Redirects to login when signed out; shows a waiting screen when not yet approved.
 */
export function requireUser({ admin = false } = {}) {
  return new Promise(resolve => {
    const stop = onAuthStateChanged(auth, async user => {
      stop();
      if (!user) { location.href = '/index.html'; return; }
      const snap = await getDoc(doc(db, 'users', user.uid)).catch(() => null);
      const profile = snap?.exists() ? { id: user.uid, ...snap.data() } : null;
      if (!profile || profile.status !== 'active') {
        renderNav(null);
        const main = $('#main'); main.hidden = false; $('#loading')?.remove();
        main.innerHTML = `<div class="card" style="max-width:560px;margin:40px auto;text-align:center">
          <h1 style="font-size:22px">${!profile ? 'No staff profile' : profile.status === 'disabled' ? 'Account disabled' : 'Waiting for approval'}</h1>
          <p class="muted">${!profile ? 'This sign-in has no staff profile. Please register with your company code.'
            : profile.status === 'disabled' ? 'Your account has been disabled. Please contact your admin.'
            : `Your registration${profile.deptName ? ` for <strong>${esc(profile.deptName)}</strong>` : ''} was received. Your company or department admin needs to approve it before you can use the portal.`}</p>
          ${!profile ? '<a class="btn" href="/register.html">Register</a>' : ''}
          <p class="small muted">Signed in as ${esc(user.email)}</p></div>`;
        return;
      }
      // the platform owner works only in the admin area
      if (profile.role === 'super' && !admin && !location.pathname.endsWith('password.html')) { location.href = '/admin.html'; return; }
      if (admin && !isManager(profile)) { location.href = '/dashboard.html'; return; }
      // company + department context
      ctx.orgId = profile.orgId || null; ctx.deptId = profile.deptId || null;
      if (ctx.orgId) {
        const [o, d] = await Promise.all([
          getDoc(doc(db, 'orgs', ctx.orgId)).catch(() => null),
          ctx.deptId ? getDoc(doc(db, 'departments', ctx.deptId)).catch(() => null) : null
        ]);
        ctx.org = o?.exists() ? { id: o.id, ...o.data() } : null;
        ctx.dept = d?.exists() ? { id: d.id, ...d.data() } : null;
        if (ctx.org?.active === false && profile.role !== 'super') {
          renderNav(null); const main = $('#main'); main.hidden = false; $('#loading')?.remove();
          main.innerHTML = `<div class="card" style="max-width:560px;margin:40px auto;text-align:center"><h1 style="font-size:22px">Company not active</h1>
            <p class="muted">${esc(ctx.org.name)} is currently switched off in the portal. Please contact your admin.</p></div>`;
          return;
        }
        if (Array.isArray(ctx.org?.weekendDays)) self.WEEKEND_DAYS = ctx.org.weekendDays;
        if (ctx.org?.defaultAL != null) self.DEFAULT_AL_DAYS = ctx.org.defaultAL;
      }
      renderNav(profile);
      watchNotifications(user.uid);
      refreshPushSilently(user.uid);
      $('#main').hidden = false;
      $('#loading')?.remove();
      resolve({ user, profile, org: ctx.org, dept: ctx.dept });
    });
  });
}
