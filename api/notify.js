// POST /api/notify  { event, id | rosterId/changes, files }
// Sends emails + push for things staff/admins just saved. The server re-reads every record itself
// and works out recipients from that record's company + department, so a caller can't redirect mail.
import {
  withAuth, httpError, db, FieldValue, getUsers, sendEmail, emailHtml, parseUploads, pushAndInbox,
  loadScope, requireMgr, isMgrOf, uniqEmails
} from './_lib.js';

const fmt = d => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function merge(...results) {
  const out = { emailed: 0, pushed: 0, errors: [] };
  results.flat().forEach(r => { if (!r) return; out.emailed += r.sent || 0; out.pushed += r.pushed || 0; if (r.error) out.errors.push(r.error); });
  out.errors = [...new Set(out.errors)];
  return out;
}
async function load(col, id) {
  if (!id || typeof id !== 'string') throw httpError(400, 'Missing id');
  const ref = db().doc(`${col}/${id}`); const snap = await ref.get();
  if (!snap.exists) throw httpError(404, 'Record not found');
  return { ref, data: snap.data() };
}
const brandOf = sc => sc.deptName ? `${sc.orgName} · ${sc.deptName}` : sc.orgName;

/* ---------- SL / FRL report (confidential) ----------
   Full report + attachments  → only the designated SL or FRL recipients (company list + department list).
   Admins                     → a short notice without reason or attachments (if "email admins" is on).
   If no designated recipients are set yet, the full report goes to the company/unit admins instead,
   so the certificate is never lost. */
async function report(me, id, base, uploads) {
  const { ref, data: r } = await load('reports', id);
  if (r.uid !== me.uid && !isMgrOf(me, r.orgId, r.deptId)) throw httpError(403, 'Not your report');
  if (r.notifiedAt) return { emailed: 0, pushed: 0, skipped: 'already sent' };
  const sc = await loadScope(r.orgId, r.deptId);
  const label = r.type === 'SL' ? 'Sick Leave' : 'Family Responsibility Leave';
  const key = r.type === 'SL' ? 'slEmails' : 'frlEmails';
  const { files, rejected } = parseUploads(r.uid === me.uid ? uploads : []);
  const expected = (r.attachments || []).length;
  let designated = sc.recipients(key), fallback = false;
  if (!designated.length) { designated = uniqEmails(sc.managers.map(m => m.email)); fallback = true; }

  const period = `${fmt(r.fromDate)}${r.toDate !== r.fromDate ? ' to ' + fmt(r.toDate) : ''}`;
  const full = await sendEmail({
    to: designated, privateList: true, fromName: sc.orgName, replyTo: r.email, attachments: files,
    subject: `[${r.type}] ${r.staffName} — ${period}`,
    html: emailHtml({
      base, brand: brandOf(sc), confidential: true, heading: `${label} report`,
      intro: `${r.staffName} has reported ${label.toLowerCase()} through the staff portal.${fallback ? ` (No ${r.type} recipients are set for this company/unit yet, so this was sent to the admins. Set them under Admin → Settings.)` : ''}`,
      rows: [['Staff', `${r.staffName} (${r.staffId})`], ['Company', sc.orgName], ['Unit', sc.deptName || r.deptName], ['Type', `${label} (${r.type})`],
        ['From', fmt(r.fromDate)], ['To', fmt(r.toDate)], ['Days', String(r.days)], ['Reason', r.reason],
        ['Attachments', files.length ? files.map(f => f.filename).join(', ') : expected ? 'Not included — ask the staff member to send them' : 'None'],
        ['Not attached (too large / wrong type)', rejected.join(', ')], ['Staff email', r.email]]
    })
  });
  // short notice to admins who weren't already designated recipients
  const notice = fallback ? null : await sendEmail({
    to: sc.managerEmails().filter(e => !designated.includes(e)), privateList: true, fromName: sc.orgName,
    subject: `[${r.type} notice] ${r.staffName} — ${period}`,
    html: emailHtml({
      base, brand: brandOf(sc), heading: `${r.type} reported`,
      intro: `${r.staffName} reported ${label.toLowerCase()}. The full report and any certificate were sent only to the designated ${r.type} recipients.`,
      rows: [['Staff', `${r.staffName} (${r.staffId})`], ['Unit', sc.deptName || r.deptName], ['Period', period], ['Days', String(r.days)]],
      button: { label: 'Open in admin', link: '/admin.html#reports' }
    })
  });
  const pushed = await pushAndInbox(sc.managerPush(), { base, title: `${r.type} reported: ${r.staffName}`, body: `${period} (${plural(r.days, 'day')})`, link: '/admin.html#reports' });
  const result = merge(full, notice, pushed);
  if (full.sent) await ref.update({ notifiedAt: FieldValue.serverTimestamp() });
  else if (!full.error) result.errors.push('No one is set up to receive these reports yet. Ask your admin to add SL/FRL emails.');
  return result;
}

/* ---------- duty change requested ---------- */
async function swapRequest(me, id, base) {
  const { ref, data: w } = await load('swaps', id);
  if (w.requesterUid !== me.uid) throw httpError(403, 'Not your request');
  if (w.notifiedAt) return { skipped: 'already sent' };
  const [sc, [target]] = await Promise.all([loadScope(w.orgId, w.deptId), getUsers([w.targetUid])]);
  const duties = w.requesterDate === w.targetDate
    ? [['Date', fmt(w.requesterDate)], [`${w.requesterName}'s duty`, w.requesterShift || '—'], [`${w.targetName}'s duty`, w.targetShift || '—']]
    : [[`${w.requesterName} gives`, `${fmt(w.requesterDate)} — ${w.requesterShift || '—'}`], [`${w.targetName} gives`, `${fmt(w.targetDate)} — ${w.targetShift || '—'}`]];
  const rows = [['Requested by', `${w.requesterName} (${w.requesterStaffId})`], ['Requested with', `${w.targetName} (${w.targetStaffId})`],
    ['Unit', sc.deptName], ['Level', w.level], ...duties, ['Reason', w.reason]];
  const result = merge(
    await sendEmail({ to: [target?.email], fromName: sc.orgName, replyTo: me.email, subject: `Duty change request from ${w.requesterName}`,
      html: emailHtml({ base, brand: brandOf(sc), heading: 'Duty change request', intro: `${w.requesterName} has asked to change duty with you. Please accept or decline in the staff portal.`, rows, button: { label: 'Review request', link: '/swap.html' } }) }),
    await sendEmail({ to: [...sc.recipients('swapEmails'), ...sc.managerEmails()].filter(e => e !== target?.email), privateList: true, fromName: sc.orgName,
      subject: `[Duty change requested] ${w.requesterName} ⇄ ${w.targetName}`,
      html: emailHtml({ base, brand: brandOf(sc), heading: 'Duty change requested', intro: `For information: ${w.requesterName} has requested a duty change with ${w.targetName}. It is waiting for ${w.targetName} to accept.`, rows, button: { label: 'Open in admin', link: '/admin.html#swaps' } }) }),
    await pushAndInbox([target], { base, title: 'Duty change request', body: `${w.requesterName} wants to swap: ${fmt(w.requesterDate)}${w.targetDate !== w.requesterDate ? ' / ' + fmt(w.targetDate) : ''}`, link: '/swap.html' }),
    await pushAndInbox(sc.managerPush().filter(a => a.uid !== w.targetUid && a.uid !== w.requesterUid), { base, title: 'Duty change requested', body: `${w.requesterName} ⇄ ${w.targetName} on ${fmt(w.requesterDate)}`, link: '/admin.html#swaps' })
  );
  await ref.update({ notifiedAt: FieldValue.serverTimestamp() });
  return result;
}

/* ---------- annual leave ---------- */
async function leaveRequest(me, id, base) {
  const { ref, data: l } = await load('leaveRequests', id);
  if (l.uid !== me.uid) throw httpError(403, 'Not your request');
  if (l.notifiedAt) return { skipped: 'already sent' };
  const sc = await loadScope(l.orgId, l.deptId);
  const result = merge(
    await sendEmail({ to: [...sc.recipients('leaveEmails'), ...sc.managerEmails()], privateList: true, fromName: sc.orgName, replyTo: l.email,
      subject: `[Annual leave request] ${l.staffName} — ${fmt(l.fromDate)} to ${fmt(l.toDate)}`,
      html: emailHtml({ base, brand: brandOf(sc), heading: 'Annual leave request', intro: `${l.staffName} has requested annual leave. It is waiting for approval.`,
        rows: [['Staff', `${l.staffName} (${l.staffId})`], ['Unit', sc.deptName], ['From', fmt(l.fromDate)], ['To', fmt(l.toDate)], ['Days', String(l.days)], ['Note', l.reason]],
        button: { label: 'Approve or reject', link: '/admin.html#leave' } }) }),
    await pushAndInbox(sc.managerPush(), { base, title: `Leave request: ${l.staffName}`, body: `${fmt(l.fromDate)} → ${fmt(l.toDate)} (${plural(l.days, 'day')})`, link: '/admin.html#leave' })
  );
  await ref.update({ notifiedAt: FieldValue.serverTimestamp() });
  return result;
}
async function leaveDecision(me, id, base) {
  const { data: l } = await load('leaveRequests', id);
  requireMgr(me, l.orgId, l.deptId);
  const [sc, [staff]] = await Promise.all([loadScope(l.orgId, l.deptId), getUsers([l.uid])]);
  const word = { approved: 'approved', rejected: 'not approved', revoked: 'revoked' }[l.status] || l.status;
  return merge(
    await sendEmail({ to: [staff?.email || l.email], fromName: sc.orgName, subject: `Your annual leave (${fmt(l.fromDate)} – ${fmt(l.toDate)}) was ${word}`,
      html: emailHtml({ base, brand: brandOf(sc), heading: `Leave ${word}`, intro: `Your annual leave request has been ${word} by ${me.name}.`,
        rows: [['From', fmt(l.fromDate)], ['To', fmt(l.toDate)], ['Days', String(l.days)], ['Comment', l.adminComment]], button: { label: 'View my leave', link: '/leave.html' } }) }),
    await pushAndInbox([staff], { base, title: `Leave ${word}`, body: `${fmt(l.fromDate)} → ${fmt(l.toDate)}${l.adminComment ? ' · ' + l.adminComment : ''}`, link: '/leave.html' })
  );
}

/* ---------- roster published / changed ---------- */
async function roster(me, body, base) {
  const { rosterId, changes = {}, isNew } = body;
  const [orgId, deptId, month] = String(rosterId || '').split('__');
  if (!orgId || !deptId || !/^\d{4}-\d{2}$/.test(month || '')) throw httpError(400, 'Bad roster');
  requireMgr(me, orgId, deptId);
  const r = await db().doc(`rosters/${rosterId}`).get();
  if (!r.exists) throw httpError(404, 'Roster not found');
  const rows = r.data().rows || {}, legend = r.data().legend || {};
  const sc = await loadScope(orgId, deptId);
  const monthName = new Date(month + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  // only people who really are in this company + department
  const staff = (await getUsers(Object.keys(changes).slice(0, 500))).filter(u => u.orgId === orgId && u.deptId === deptId && u.status === 'active');
  const results = [];
  for (const u of staff) {
    const dates = (changes[u.uid] || []).filter(d => typeof d === 'string' && d.startsWith(month)).sort();
    const lines = dates.slice(0, 31).map(d => { const c = rows[u.uid]?.[Number(d.slice(8)) - 1] || ''; return [fmt(d), c ? `${c}${legend[c] ? ' — ' + legend[c] : ''}` : 'No duty']; });
    const title = isNew ? `Roster published: ${monthName}` : `Your duties changed: ${monthName}`;
    results.push(await sendEmail({ to: [u.email], fromName: sc.orgName, subject: title,
      html: emailHtml({ base, brand: brandOf(sc), heading: title, intro: isNew ? `The ${sc.deptName} duty roster for ${monthName} has been published.` : `Your duties were updated on ${plural(dates.length, 'day')}.`,
        rows: isNew ? [] : lines, button: { label: 'View roster', link: `/roster.html?m=${month}` } }) }));
  }
  results.push(await pushAndInbox(staff, { base, title: isNew ? `Roster published: ${monthName}` : `Roster updated: ${monthName}`, body: isNew ? 'Tap to view your duties.' : 'Your duties have changed. Tap to view.', link: `/roster.html?m=${month}` }));
  return merge(results);
}

/* ---------- new registration → tell that company/unit's admins ---------- */
/* ---------- staff chose their own password → stop asking ---------- */
async function passwordChanged(me) {
  if (me.mustChangePassword) await db().doc(`users/${me.uid}`).update({ mustChangePassword: false, passwordChangedAt: FieldValue.serverTimestamp() });
  return { ok: true };
}

async function registered(me, base) {
  if (me.status !== 'pending' || me.registrationNotified) return { skipped: true };
  const sc = await loadScope(me.orgId, me.deptId);
  const r = merge(await pushAndInbox(sc.managers, { base, title: 'New staff registration', body: `${me.name} (${me.staffId}) · ${sc.deptName} is waiting for approval`, link: '/admin.html#staff' }));
  await db().doc(`users/${me.uid}`).update({ registrationNotified: true });
  return r;
}

async function test(me, body, base) {
  if (!['admin', 'deptadmin', 'super'].includes(me.role)) throw httpError(403, 'Admins only');
  const orgId = me.role === 'super' ? body.orgId : me.orgId;
  const deptId = me.role === 'deptadmin' ? me.deptId : body.deptId || null;
  let sc = null;
  if (orgId) { requireMgr(me, orgId, deptId || me.deptId); sc = await loadScope(orgId, deptId); }
  const brand = sc ? brandOf(sc) : undefined;
  const lists = sc ? ['slEmails', 'frlEmails', 'leaveEmails', 'swapEmails'].map(k => [k.replace('Emails', '').toUpperCase(), sc.recipients(k).join(', ') || 'none set']) : [];
  return merge(
    await sendEmail({ to: [me.email], fromName: sc?.orgName, subject: 'Staff portal test email',
      html: emailHtml({ base, brand, heading: 'It works!', intro: 'Email notifications from the staff portal are set up correctly. These are the lists that will receive emails:', rows: lists, button: { label: 'Open portal', link: '/admin.html' } }) }),
    await pushAndInbox([me], { base, title: 'Test notification', body: 'Push notifications are working.', link: '/admin.html#settings' })
  );
}

const handler = withAuth(async ({ me, body, base }) => {
  if (me.status === 'pending' && body.event !== 'registered') throw httpError(403, 'Account is not active');
  switch (body.event) {
    case 'report': return report(me, body.id, base, body.files);
    case 'swap_request': return swapRequest(me, body.id, base);
    case 'leave_request': return leaveRequest(me, body.id, base);
    case 'leave_decision': return leaveDecision(me, body.id, base);
    case 'roster': return roster(me, body, base);
    case 'registered': return registered(me, base);
    case 'password_changed': return passwordChanged(me);
    case 'test': return test(me, body, base);
    default: throw httpError(400, 'Unknown event');
  }
}, { allowPending: true });
export default handler;
