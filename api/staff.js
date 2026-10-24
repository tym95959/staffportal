// POST /api/staff  { action: 'create', orgId, deptId, name, staffId, email, phone, designation, level, role, units, alEntitlement, sendEmail }
//                  { action: 'remove', uid }
//                  { action: 'allocate_leave', uid, from, to, note, countsAgainst, notify }
// Lets the App admin, a company admin or a unit admin add a staff member directly (no registration needed).
// Creates the sign-in account with a temporary password, the staff profile (already approved) and the
// colleague-directory entry. The person must choose their own password the first time they sign in.
import crypto from 'node:crypto';
import { withAuth, httpError, db, adminAuth, FieldValue, requireMgr, isAdminOf, isSuper, sendEmail, emailHtml, pushAndInbox } from './_lib.js';

const ROLES_FOR = me => isSuper(me) || me.role === 'admin' ? ['staff', 'deptadmin', 'admin'] : ['staff', 'deptadmin'];
const clean = (v, n = 120) => String(v ?? '').trim().slice(0, n);
function tempPassword() {
  const words = 'Sun Sea Reef Palm Wave Coral Moon Star Leaf Sand Blue Gold'.split(' ');
  const w = () => words[crypto.randomInt(words.length)];
  return `${w()}${w()}-${crypto.randomInt(1000, 9999)}`; // e.g. ReefPalm-4821
}

/* Remove a staff member for good: their sign-in, profile and directory entry are deleted.
   Past SL/FRL reports, leave requests, duty changes and published rosters are kept as records.
   Their pending leave requests and duty changes are cancelled. */
async function remove(me, uid) {
  uid = clean(uid, 128);
  if (!uid) throw httpError(400, 'Missing staff member');
  if (uid === me.uid) throw httpError(400, 'You cannot remove yourself.');
  const ref = db().doc(`users/${uid}`); const snap = await ref.get();
  if (!snap.exists) throw httpError(404, 'Staff member not found');
  const u = snap.data();
  if (u.role === 'super') throw httpError(403, 'The App admin cannot be removed here.');
  requireMgr(me, u.orgId, u.deptId);
  if (!ROLES_FOR(me).includes(u.role || 'staff')) throw httpError(403, 'You cannot remove someone with that role.');

  const [lv, sw1, sw2] = await Promise.all([
    db().collection('leaveRequests').where('uid', '==', uid).where('status', '==', 'pending').get(),
    db().collection('swaps').where('requesterUid', '==', uid).where('status', '==', 'pending').get(),
    db().collection('swaps').where('targetUid', '==', uid).where('status', '==', 'pending').get()
  ]);
  const batch = db().batch();
  const note = { status: 'cancelled', cancelledBy: `${me.name || me.email} (staff removed)`, updatedAt: FieldValue.serverTimestamp() };
  [...lv.docs, ...sw1.docs, ...sw2.docs].forEach(d => batch.update(d.ref, note));
  batch.delete(ref);
  batch.delete(db().doc(`directory/${uid}`));
  await batch.commit();
  try { await adminAuth().deleteUser(uid); } catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
  return { removed: true, name: u.name, cancelled: lv.docs.length + sw1.docs.length + sw2.docs.length };
}

/* An admin puts annual leave on the calendar for a staff member. It is saved as approved leave
   (marked "allocated"), takes leave slots, appears on the unit leave plan staff can see, shows as AL in
   the roster editor, and (optionally) counts against the person's entitlement. The person is notified. */
const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
function daysBetween(from, to) {
  const out = []; const d = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z');
  while (d <= end && out.length < 367) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const fmtD = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
async function allocateLeave(me, body, base) {
  const uid = clean(body.uid, 128), from = clean(body.from, 10), to = clean(body.to, 10);
  if (!uid || !ymdRe.test(from) || !ymdRe.test(to) || to < from) throw httpError(400, 'Choose a staff member and valid dates');
  const days = daysBetween(from, to);
  if (days.length > 366) throw httpError(400, 'That is more than a year');
  const uref = db().doc(`users/${uid}`); const us = await uref.get();
  if (!us.exists) throw httpError(404, 'Staff member not found');
  const u = us.data();
  requireMgr(me, u.orgId, u.deptId);
  // no double booking with leave they already have or asked for
  const mine = await db().collection('leaveRequests').where('uid', '==', uid).get();
  const clash = mine.docs.map(d => d.data()).find(l => ['approved', 'pending'].includes(l.status) && l.fromDate <= to && l.toDate >= from);
  if (clash) throw httpError(409, `${u.name} already has ${clash.status === 'pending' ? 'a pending request' : 'leave'} from ${clash.fromDate} to ${clash.toDate}. Approve, reject or revoke that first.`);

  const countsAgainst = body.countsAgainst !== false;
  const shortName = String(u.name || '').split(/\s+/).slice(0, 2).join(' ');
  const ref = db().collection('leaveRequests').doc();
  const batch = db().batch();
  batch.set(ref, {
    uid, staffName: u.name, staffId: u.staffId || '', orgId: u.orgId, deptId: u.deptId, deptName: u.deptName || '', email: u.email,
    fromDate: from, toDate: to, days: days.length, reason: clean(body.note, 300), status: 'approved', allocated: true, countsAgainst,
    adminComment: clean(body.note, 300), decidedBy: me.name || me.email, decidedAt: FieldValue.serverTimestamp(), createdAt: FieldValue.serverTimestamp(), notifiedAt: FieldValue.serverTimestamp()
  });
  if (countsAgainst) batch.update(uref, { alTaken: FieldValue.increment(days.length) });
  const byYear = {};
  days.forEach(d => { const y = d.slice(0, 4); (byYear[y] ||= { booked: {}, onLeave: {} }); byYear[y].booked[d] = FieldValue.increment(1); byYear[y].onLeave[d] = { [uid]: shortName }; });
  for (const [y, v] of Object.entries(byYear)) batch.set(db().doc(`leaveCalendar/${u.orgId}__${u.deptId}__${y}`), { orgId: u.orgId, deptId: u.deptId, ...v }, { merge: true });
  await batch.commit();

  let emailed = 0;
  if (body.notify !== false) {
    const org = (await db().doc(`orgs/${u.orgId}`).get()).data() || {};
    const r = await sendEmail({ to: [u.email], fromName: org.name, subject: `Annual leave allocated: ${fmtD(from)} – ${fmtD(to)}`,
      html: emailHtml({ base, brand: `${org.name || ''}${u.deptName ? ' · ' + u.deptName : ''}`, heading: 'Annual leave allocated',
        intro: `${me.name || 'Your admin'} has put annual leave on the calendar for you.`,
        rows: [['From', fmtD(from)], ['To', fmtD(to)], ['Days', String(days.length)], ['Counts against your entitlement', countsAgainst ? 'Yes' : 'No'], ['Note', clean(body.note, 300)]],
        button: { label: 'View my leave', link: '/leave.html' } }) });
    emailed = r.sent || 0;
    await pushAndInbox([{ uid, ...u }], { base, title: 'Annual leave allocated', body: `${fmtD(from)} → ${fmtD(to)} (${days.length} day${days.length === 1 ? '' : 's'})`, link: '/leave.html' });
  }
  return { id: ref.id, days: days.length, emailed };
}

export default withAuth(async ({ me, body, base }) => {
  if (body.action === 'remove') return remove(me, body.uid);
  if (body.action === 'allocate_leave') return allocateLeave(me, body, base);
  if (body.action !== 'create') throw httpError(400, 'Unknown action');
  const orgId = clean(body.orgId, 64), deptId = clean(body.deptId, 64);
  if (!orgId || !deptId) throw httpError(400, 'Choose a unit');
  requireMgr(me, orgId, deptId);

  const role = body.role || 'staff';
  if (!ROLES_FOR(me).includes(role)) throw httpError(403, 'You cannot give that role');
  const email = clean(body.email, 200).toLowerCase();
  const name = clean(body.name), staffId = clean(body.staffId, 40).toUpperCase();
  if (!name || !staffId) throw httpError(400, 'Name and Staff ID are required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Enter a valid email address');

  const [org, dept, sameId] = await Promise.all([
    db().doc(`orgs/${orgId}`).get(), db().doc(`departments/${deptId}`).get(),
    db().collection('users').where('orgId', '==', orgId).where('staffId', '==', staffId).get()
  ]);
  if (!org.exists || !dept.exists || dept.data().orgId !== orgId) throw httpError(400, 'Unknown company or unit');
  if (sameId.docs.length) throw httpError(409, `Staff ID ${staffId} is already used by ${sameId.docs[0].data().name} in this company.`);

  // extra units (unit admins only, decided by a company admin)
  let units = [];
  if (role === 'deptadmin' && isAdminOf(me, orgId) && Array.isArray(body.units)) {
    const ids = [...new Set(body.units.map(x => clean(x, 64)).filter(x => x && x !== deptId))].slice(0, 50);
    const snaps = ids.length ? await db().getAll(...ids.map(id => db().doc(`departments/${id}`))) : [];
    units = snaps.filter(s => s.exists && s.data().orgId === orgId).map(s => s.id);
  }

  const password = tempPassword();
  let user;
  try { user = await adminAuth().createUser({ email, password, displayName: name }); }
  catch (e) {
    if (e.code === 'auth/email-already-exists') throw httpError(409, 'That email already has a portal account. Ask them to sign in, or use a different email.');
    if (e.code === 'auth/invalid-email') throw httpError(400, 'That email address is not valid.');
    throw e;
  }

  const ent = Number(body.alEntitlement);
  const profile = {
    name, staffId, email, phone: clean(body.phone, 40), designation: clean(body.designation), level: clean(body.level, 40),
    orgId, deptId, deptName: dept.data().name || '', role, units, status: 'active',
    alEntitlement: Number.isFinite(ent) && ent >= 0 ? ent : (org.data().defaultAL ?? 30), alTaken: 0,
    mustChangePassword: true, addedBy: me.name || me.email, createdAt: FieldValue.serverTimestamp()
  };
  const batch = db().batch();
  batch.set(db().doc(`users/${user.uid}`), profile);
  batch.set(db().doc(`directory/${user.uid}`), { name, staffId, level: profile.level, orgId, deptId, designation: profile.designation, active: true });
  await batch.commit();

  let emailed = false, emailError = null;
  if (body.sendEmail !== false) {
    const r = await sendEmail({
      to: [email], fromName: org.data().name, subject: `Your ${org.data().name} staff portal account`,
      html: emailHtml({
        base, brand: `${org.data().name} · ${dept.data().name}`, heading: `Welcome, ${name.split(' ')[0]}`,
        intro: `${me.name || 'Your admin'} has created your staff portal account. Sign in with the details below — you will be asked to choose your own password the first time.`,
        rows: [['Email', email], ['Temporary password', password], ['Unit', dept.data().name], ['Staff ID', staffId]],
        button: { label: 'Sign in', link: '/index.html' }
      })
    });
    emailed = !!r.sent; emailError = r.error || null;
  }
  return { uid: user.uid, tempPassword: password, emailed, emailError };
});
