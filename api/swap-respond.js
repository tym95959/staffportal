// POST /api/swap-respond  { id, decision: 'accept' | 'reject' }
// Only the colleague who was asked can respond. On accept the two duties are exchanged on the
// department's roster in a transaction, then the requester, the duty-change lists and admins are notified.
import { withAuth, httpError, db, FieldValue, getUsers, sendEmail, emailHtml, pushAndInbox, loadScope } from './_lib.js';

const fmt = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export default withAuth(async ({ me, body, base }) => {
  const { id, decision } = body;
  if (!id || !['accept', 'reject'].includes(decision)) throw httpError(400, 'Bad request');
  const ref = db().doc(`swaps/${id}`);
  let w; const applied = [];

  await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw httpError(404, 'Request not found');
    w = snap.data();
    if (w.targetUid !== me.uid) throw httpError(403, 'This request was not sent to you');
    if (w.orgId !== me.orgId || w.deptId !== me.deptId) throw httpError(403, 'You are no longer in this unit');
    if (w.status !== 'pending') throw httpError(409, `This request is already ${w.status}`);
    const update = { status: decision === 'accept' ? 'accepted' : 'rejected', respondedAt: FieldValue.serverTimestamp() };

    if (decision === 'accept') {
      const dates = [...new Set([w.requesterDate, w.targetDate])];
      const months = [...new Set(dates.map(d => d.slice(0, 7)))];
      const rRefs = months.map(m => db().doc(`rosters/${w.orgId}__${w.deptId}__${m}`));
      const rSnaps = await Promise.all(rRefs.map(r => tx.get(r))); // all reads before writes
      rSnaps.forEach((rs, i) => {
        if (!rs.exists) return;
        const data = rs.data(), n = data.days || 31;
        const a = Array.from({ length: n }, (_, k) => data.rows?.[w.requesterUid]?.[k] || '');
        const b = Array.from({ length: n }, (_, k) => data.rows?.[w.targetUid]?.[k] || '');
        dates.filter(d => d.startsWith(months[i])).forEach(d => { const k = Number(d.slice(8)) - 1; [a[k], b[k]] = [b[k], a[k]]; applied.push(d); });
        const order = data.order || [];
        tx.update(rRefs[i], {
          [`rows.${w.requesterUid}`]: a, [`rows.${w.targetUid}`]: b,
          order: [...order, ...[w.requesterUid, w.targetUid].filter(u => !order.includes(u))],
          [`names.${w.requesterUid}`]: data.names?.[w.requesterUid] || { name: w.requesterName, staffId: w.requesterStaffId || '' },
          [`names.${w.targetUid}`]: data.names?.[w.targetUid] || { name: w.targetName, staffId: w.targetStaffId || '' },
          updatedAt: FieldValue.serverTimestamp(), updatedBy: `Duty change: ${w.requesterName} ⇄ ${w.targetName}`
        });
      });
      update.rosterUpdated = applied.length > 0;
      update.appliedDates = applied;
    }
    tx.update(ref, update);
  });

  const accepted = decision === 'accept';
  const [sc, [requester]] = await Promise.all([loadScope(w.orgId, w.deptId), getUsers([w.requesterUid])]);
  const brand = sc.deptName ? `${sc.orgName} · ${sc.deptName}` : sc.orgName;
  const rows = [['Requested by', `${w.requesterName} (${w.requesterStaffId})`], ['Accepted by', accepted ? `${w.targetName} (${w.targetStaffId})` : ''],
    ['Declined by', accepted ? '' : `${w.targetName} (${w.targetStaffId})`], ['Unit', sc.deptName],
    ...(w.requesterDate === w.targetDate
      ? [['Date', fmt(w.requesterDate)], [`${w.requesterName} now works`, w.targetShift || '—'], [`${w.targetName} now works`, w.requesterShift || '—']]
      : [[`${w.targetName} works`, `${fmt(w.requesterDate)} — ${w.requesterShift || '—'}`], [`${w.requesterName} works`, `${fmt(w.targetDate)} — ${w.targetShift || '—'}`]]),
    ['Roster', accepted ? (applied.length ? 'Updated automatically' : 'No published roster for these dates — please update manually') : ''], ['Reason', w.reason]];
  const word = accepted ? 'accepted' : 'declined';
  const results = [
    await sendEmail({ to: [requester?.email], fromName: sc.orgName, subject: `${w.targetName} ${word} your duty change request`,
      html: emailHtml({ base, brand, heading: `Duty change ${word}`, intro: `${w.targetName} has ${word} your duty change request.`, rows: accepted ? rows : rows.slice(0, 4), button: { label: 'View roster', link: '/roster.html' } }) }),
    await pushAndInbox([requester], { base, title: `Duty change ${word}`, body: `${w.targetName} ${word} your request for ${fmt(w.requesterDate)}`, link: accepted ? '/roster.html' : '/swap.html' })
  ];
  if (accepted) {
    results.push(
      await sendEmail({ to: [...sc.recipients('swapEmails'), ...sc.managerEmails()], privateList: true, fromName: sc.orgName,
        subject: `[Duty change agreed] ${w.requesterName} ⇄ ${w.targetName} — ${fmt(w.requesterDate)}`,
        html: emailHtml({ base, brand, heading: 'Duty change agreed', intro: `${w.requesterName} and ${w.targetName} have agreed a duty change.`, rows, button: { label: 'Open in admin', link: '/admin.html#swaps' } }) }),
      await pushAndInbox(sc.managerPush().filter(a => a.uid !== w.requesterUid && a.uid !== w.targetUid), { base, title: 'Duty change agreed', body: `${w.requesterName} ⇄ ${w.targetName} on ${fmt(w.requesterDate)}`, link: '/admin.html#swaps' })
    );
  }
  return { status: accepted ? 'accepted' : 'rejected', rosterUpdated: applied.length > 0, emailed: results.reduce((a, r) => a + (r.sent || 0), 0) };
});
