// Shared server helpers for the Vercel functions. Files starting with "_" are not exposed as routes.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import nodemailer from 'nodemailer';

export { FieldValue };

export function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function adminApp() {
  if (getApps().length) return getApps()[0];
  // Accepts FIREBASE_SERVICE_ACCOUNT1 (your Vercel name) or FIREBASE_SERVICE_ACCOUNT
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT1 || process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) throw httpError(500, 'FIREBASE_SERVICE_ACCOUNT1 is not set in Vercel environment variables');
  let sa;
  try { sa = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')); }
  catch { throw httpError(500, 'FIREBASE_SERVICE_ACCOUNT1 is not valid JSON — paste the whole service-account file, including the { }'); }
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return initializeApp({ credential: cert(sa) });
}
export const db = () => getFirestore(adminApp());
export const adminAuth = () => getAuth(adminApp());

/** Wraps a handler: POST only, verifies the Firebase ID token and loads the caller's profile. */
export function withAuth(fn, { allowPending = false } = {}) {
  return async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : '';
      if (!token) throw httpError(401, 'Not signed in');
      const decoded = await getAuth(adminApp()).verifyIdToken(token);
      const snap = await db().doc(`users/${decoded.uid}`).get();
      if (!snap.exists) throw httpError(403, 'No staff profile');
      const status = snap.data().status;
      if (status !== 'active' && !(allowPending && status === 'pending')) throw httpError(403, 'Account is not active');
      const me = { uid: decoded.uid, ...snap.data() };
      if (!me.name) me.name = me.email || decoded.email || 'Admin';
      const base = (process.env.APP_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/$/, '');
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const out = await fn({ me, body, base });
      res.status(200).json({ ok: true, ...out });
    } catch (e) {
      if (!e.status || e.status >= 500) console.error(e);
      res.status(e.status || 500).json({ error: e.status ? e.message : `Server error: ${e.message}` });
    }
  };
}
/* ---------- who may manage what ---------- */
export const isSuper = me => me.role === 'super' && me.status === 'active';
/** Company admin of orgId, or the platform owner */
export const isAdminOf = (me, orgId) => isSuper(me) || (me.status === 'active' && me.role === 'admin' && me.orgId === orgId);
/** Units a unit admin manages: their own unit plus any extra units the company admin gave them */
export const managedUnits = u => [...new Set([u.deptId, ...(Array.isArray(u.units) ? u.units : [])].filter(Boolean))];
/** Can manage unit deptId of orgId */
export const isMgrOf = (me, orgId, deptId) => isAdminOf(me, orgId)
  || (me.status === 'active' && me.role === 'deptadmin' && me.orgId === orgId && managedUnits(me).includes(deptId));
export function requireMgr(me, orgId, deptId) { if (!isMgrOf(me, orgId, deptId)) throw httpError(403, 'You do not manage this unit'); }
export const isManagerRole = r => ['admin', 'deptadmin', 'super'].includes(r);

/* ---------- data helpers ---------- */
const DEFAULT_SETTINGS = { emailAdmins: true, pushAdmins: true, slEmails: [], frlEmails: [], swapEmails: [], leaveEmails: [] };
const LIST_KEYS = ['slEmails', 'frlEmails', 'swapEmails', 'leaveEmails'];

/**
 * Everything needed to notify people about something in one department:
 *  - org / dept names (for email branding)
 *  - recipients(key): company list + department list for slEmails / frlEmails / leaveEmails / swapEmails
 *  - managers: active company admins + the unit admins who manage that unit
 *  - emailAdmins / pushAdmins: company options
 */
export async function loadScope(orgId, deptId) {
  if (!orgId) throw httpError(400, 'Missing company');
  const [org, orgSet, dept, deptSet, usersQ] = await Promise.all([
    db().doc(`orgs/${orgId}`).get(), db().doc(`orgSettings/${orgId}`).get(),
    deptId ? db().doc(`departments/${deptId}`).get() : null, deptId ? db().doc(`deptSettings/${deptId}`).get() : null,
    db().collection('users').where('orgId', '==', orgId).where('status', '==', 'active').get()
  ]);
  if (!org.exists) throw httpError(404, 'Company not found');
  const o = { ...DEFAULT_SETTINGS, ...(orgSet.exists ? orgSet.data() : {}) };
  const d = deptSet?.exists ? deptSet.data() : {};
  const managers = usersQ.docs.map(x => ({ uid: x.id, ...x.data() }))
    .filter(u => u.role === 'admin' || (u.role === 'deptadmin' && deptId && managedUnits(u).includes(deptId)));
  return {
    orgId, deptId,
    orgName: org.data().name || 'Company',
    deptName: dept?.exists ? dept.data().name : '',
    emailAdmins: o.emailAdmins !== false, pushAdmins: o.pushAdmins !== false,
    recipients: key => (LIST_KEYS.includes(key) ? uniqEmails([...(o[key] || []), ...(d[key] || [])]) : []),
    managers,
    managerEmails() { return this.emailAdmins ? uniqEmails(managers.map(m => m.email)) : []; },
    managerPush() { return this.pushAdmins ? managers : []; }
  };
}
export async function getUsers(uids) {
  const ids = [...new Set(uids.filter(Boolean))];
  if (!ids.length) return [];
  const snaps = await db().getAll(...ids.map(u => db().doc(`users/${u}`)));
  return snaps.filter(s => s.exists).map(s => ({ uid: s.id, ...s.data() }));
}

/* ---------- email ---------- */
let transport;
// Email login: EMAIL_USER / EMAIL_PASS (your Vercel names) or SMTP_USER / SMTP_PASS.
// Server: SMTP_HOST if set, otherwise worked out from the EMAIL_USER domain (Gmail by default).
const mailUser = () => (process.env.EMAIL_USER || process.env.SMTP_USER || '').trim();
function smtpHost(user) {
  if (process.env.SMTP_HOST || process.env.EMAIL_HOST) return { host: process.env.SMTP_HOST || process.env.EMAIL_HOST, port: Number(process.env.SMTP_PORT || process.env.EMAIL_PORT || 465) };
  const d = user.split('@')[1]?.toLowerCase() || '';
  if (/^(outlook|hotmail|live|msn)\./.test(d)) return { host: 'smtp-mail.outlook.com', port: 587 };
  if (/^(yahoo|ymail)\./.test(d)) return { host: 'smtp.mail.yahoo.com', port: 465 };
  if (/^(zoho)\./.test(d)) return { host: 'smtp.zoho.com', port: 465 };
  return { host: 'smtp.gmail.com', port: 465 }; // Gmail and Google Workspace
}
function mailer() {
  if (transport !== undefined) return transport;
  const user = mailUser();
  let pass = process.env.EMAIL_PASS || process.env.SMTP_PASS || '';
  if (!user || !pass) return (transport = null);
  const { host, port } = smtpHost(user);
  if (host === 'smtp.gmail.com') pass = pass.replace(/\s+/g, ''); // Gmail app passwords are shown with spaces
  transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  return transport;
}
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
export const uniqEmails = list => [...new Set((list || []).filter(Boolean).map(e => String(e).trim().toLowerCase()).filter(validEmail))];

export async function sendEmail({ to, subject, html, attachments, replyTo, privateList = false, fromName }) {
  const list = uniqEmails(to);
  if (!list.length) return { sent: 0 };
  const t = mailer();
  if (!t) return { sent: 0, error: 'Email not configured (EMAIL_USER / EMAIL_PASS missing in Vercel)' };
  const name = String(fromName || process.env.APP_NAME || 'Staff Portal').replace(/["<>\r\n]/g, '');
  const from = process.env.MAIL_FROM || `"${name}" <${mailUser()}>`;
  try {
    await t.sendMail({ from, ...(privateList ? { to: from, bcc: list } : { to: list }), subject, html, attachments, replyTo: replyTo && validEmail(replyTo) ? replyTo : undefined });
    return { sent: list.length };
  } catch (e) { console.error('email', e); return { sent: 0, error: `Email failed: ${e.message}` }; }
}

const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function emailHtml({ heading, intro, rows = [], button, base, brand, confidential = false }) {
  const appName = brand || process.env.APP_NAME || 'Staff Portal';
  return `<!doctype html><html><body style="margin:0;background:#f3f5f4;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#14232b">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #dfe5e3">
    <tr><td style="background:linear-gradient(120deg,#0e7c86,#2563eb,#7c3aed);background-color:#2563eb;color:#fff;padding:16px 22px;font-weight:700;font-size:15px">${escH(appName)}</td></tr>
    <tr><td style="padding:22px">
      ${confidential ? '<p style="margin:0 0 14px;padding:8px 12px;border-radius:8px;background:#ffe1e6;color:#be123c;font-size:12px;font-weight:700;letter-spacing:.04em">CONFIDENTIAL — for the designated recipients only. Do not forward.</p>' : ''}
      <h2 style="margin:0 0 8px;font-size:19px">${escH(heading)}</h2>
      <p style="margin:0 0 16px;color:#5f6f76;font-size:14px;line-height:1.5">${escH(intro)}</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border-collapse:collapse">
        ${rows.filter(r => r[1] !== undefined && r[1] !== '').map(([k, v]) => `<tr><td style="padding:8px 0;border-top:1px solid #eef1f0;color:#5f6f76;width:38%;vertical-align:top">${escH(k)}</td><td style="padding:8px 0;border-top:1px solid #eef1f0;font-weight:600">${escH(v)}</td></tr>`).join('')}
      </table>
      ${button ? `<p style="margin:22px 0 0"><a href="${escH(base + button.link)}" style="background:#2563eb;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:700;font-size:14px;display:inline-block">${escH(button.label)}</a></p>` : ''}
    </td></tr>
  </table>
  <p style="color:#8a979c;font-size:12px">Automatic message from ${escH(appName)} via ${escH(process.env.APP_NAME || 'Staff Portal')}.</p>
  </td></tr></table></body></html>`;
}

/**
 * Turns files sent with the request ({name, type, data: base64}) into email attachments.
 * Nothing is stored — the files only exist for the length of this request.
 */
export function parseUploads(files = []) {
  if (!Array.isArray(files)) return { files: [], rejected: [] };
  const out = [], rejected = []; let total = 0;
  for (const f of files.slice(0, 5)) {
    const type = String(f?.type || '');
    const name = String(f?.name || 'attachment').replace(/[\r\n"\\/]+/g, '_').slice(0, 120);
    if (!(type.startsWith('image/') || type === 'application/pdf') || typeof f.data !== 'string') { rejected.push(name); continue; }
    const content = Buffer.from(f.data, 'base64');
    if (!content.length || total + content.length > 3.5 * 1024 * 1024) { rejected.push(name); continue; }
    total += content.length;
    out.push({ filename: name, content, contentType: type });
  }
  return { files: out, rejected };
}

/* ---------- push + in-app inbox ---------- */
const DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
export async function pushAndInbox(users, { title, body, link, base }) {
  const unique = [...new Map((users || []).filter(Boolean).map(u => [u.uid, u])).values()];
  if (!unique.length) return { pushed: 0 };
  const batch = db().batch();
  unique.forEach(u => batch.set(db().collection('notifications').doc(), { uid: u.uid, title, body, link, read: false, createdAt: FieldValue.serverTimestamp() }));
  await batch.commit();

  const owner = new Map();
  unique.forEach(u => (u.fcmTokens || []).forEach(t => owner.set(t, u.uid)));
  const tokens = [...owner.keys()];
  if (!tokens.length) return { pushed: 0 };
  let pushed = 0; const dead = [];
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    try {
      const r = await getMessaging(adminApp()).sendEachForMulticast({
        tokens: chunk,
        notification: { title, body },
        data: { link: link || '/dashboard.html' },
        webpush: { notification: { icon: `${base}/icons/icon-192.png`, badge: `${base}/icons/icon-192.png` }, fcmOptions: { link: base + (link || '/dashboard.html') } }
      });
      pushed += r.successCount;
      r.responses.forEach((x, j) => { if (x.error && DEAD.has(x.error.code)) dead.push(chunk[j]); });
    } catch (e) { console.error('push', e); }
  }
  if (dead.length) {
    const byUser = {};
    dead.forEach(t => (byUser[owner.get(t)] ||= []).push(t));
    await Promise.all(Object.entries(byUser).map(([uid, ts]) => db().doc(`users/${uid}`).update({ fcmTokens: FieldValue.arrayRemove(...ts) }).catch(() => {})));
  }
  return { pushed };
}
