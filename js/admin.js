import {
  requireUser, db, $, $$, esc, fmtShort, fmtTs, pill, plural, ym, today, dateRange, daysInMonth, isWeekend, toast, busy, api,
  byNewest, calendarHTML, CAL_LEGEND, dayStatus, shiftClass, enablePush, pushEnabled, rosterId, calId, ROLE_LABEL, APP_NAME,
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, query, where, writeBatch, serverTimestamp, increment, deleteField
} from '/js/app.js';

document.title = `Admin · ${APP_NAME}`;
const { user, profile } = await requireUser({ admin: true });

/* ============ who am I, what can I see ============
   super      platform owner — picks any company, all tabs + Companies
   admin      company admin  — own company, any department, Departments + company settings
   deptadmin  department admin — own department only */
const ROLE = profile.role;
const SUPER = ROLE === 'super';
const ORGADMIN = SUPER || ROLE === 'admin';
const DEPTADMIN = ROLE === 'deptadmin';
const store = { get: k => { try { return localStorage.getItem('adm:' + k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem('adm:' + k, v ?? ''); } catch {} } };

const S = { orgId: SUPER ? store.get('org') : profile.orgId, deptId: DEPTADMIN ? profile.deptId : (store.get('dept') || ''), org: null, depts: [] };
const deptName = id => S.depts.find(d => d.id === id)?.name || '';
const linesToEmails = s => [...new Set(s.split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)))];
const notifySoft = async body => { try { return await api('/api/notify', body); } catch (e) { toast('Saved, but notification failed: ' + e.message, 'bad', 8000); } };
const parseLegend = txt => Object.fromEntries(String(txt || '').split('\n').map(l => l.split('=')).filter(p => p.length >= 2 && p[0].trim()).map(([k, ...v]) => [k.trim().toUpperCase(), v.join('=').trim()]));
/** query on a collection limited to the current company (+ department if one is chosen) */
const scopeQ = (col, ...extra) => query(collection(db, col), where('orgId', '==', S.orgId), ...(S.deptId ? [where('deptId', '==', S.deptId)] : []), ...extra);

$('#roleBadge').textContent = ROLE_LABEL[ROLE] || ROLE;
$$('[data-role="super"]').forEach(x => x.hidden = !SUPER);
$$('[data-role="orgadmin"]').forEach(x => x.hidden = !ORGADMIN);

if (!pushEnabled()) $('#pushBtn').hidden = false;
$('#pushBtn').onclick = async () => {
  try { await enablePush(user.uid); $('#pushBtn').hidden = true; toast('Notifications enabled.', 'ok'); } catch (e) { toast(e.message, 'bad', 8000); }
};

// keep my own colleague-directory entry up to date (not for the platform owner, who belongs to no company)
if (profile.orgId && profile.deptId) {
  setDoc(doc(db, 'directory', user.uid), {
    name: profile.name, staffId: profile.staffId || '', level: profile.level || '', orgId: profile.orgId, deptId: profile.deptId,
    designation: profile.designation || '', active: true
  }, { merge: true }).catch(() => {});
}

/* ============ company / department picker ============ */
let orgs = [];
async function loadOrgs() {
  const s = await getDocs(collection(db, 'orgs'));
  orgs = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  $('#orgSel').innerHTML = orgs.length ? orgs.map(o => `<option value="${o.id}">${esc(o.name)}${o.active === false ? ' (inactive)' : ''}</option>`).join('') : '<option value="">No companies yet</option>';
  return orgs;
}
async function setOrg(orgId) {
  S.orgId = orgId || null; S.org = null; S.depts = [];
  if (SUPER) store.set('org', S.orgId);
  if (S.orgId) {
    const [o, d] = await Promise.all([getDoc(doc(db, 'orgs', S.orgId)), getDocs(query(collection(db, 'departments'), where('orgId', '==', S.orgId)))]);
    S.org = o.exists() ? { id: o.id, ...o.data() } : null;
    S.depts = d.docs.map(x => ({ id: x.id, ...x.data() })).sort((a, b) => a.name.localeCompare(b.name));
    if (Array.isArray(S.org?.weekendDays)) self.WEEKEND_DAYS = S.org.weekendDays;
    if (S.org?.defaultAL != null) self.DEFAULT_AL_DAYS = S.org.defaultAL;
  }
  if (!DEPTADMIN && S.deptId && !S.depts.some(d => d.id === S.deptId)) S.deptId = '';
  drawDeptPicker();
}
function drawDeptPicker() {
  const sel = $('#deptSel');
  if (DEPTADMIN) { sel.innerHTML = `<option value="${S.deptId}">${esc(deptName(S.deptId) || profile.deptName || 'My department')}</option>`; sel.disabled = true; }
  else sel.innerHTML = '<option value="">All departments</option>' + S.depts.map(d => `<option value="${d.id}">${esc(d.name)}${d.active === false ? ' (inactive)' : ''}</option>`).join('');
  sel.value = S.deptId || '';
  const where = S.org ? `${S.org.name} · ${S.deptId ? deptName(S.deptId) : 'All departments'}` : 'No company selected';
  $('#scopeText').textContent = where;
  $$('.deptNameTxt').forEach(x => x.textContent = deptName(S.deptId) || '—');
  $('#needDeptBtns').innerHTML = S.depts.filter(d => d.active !== false).map(d => `<button class="btn ghost" data-pickdept="${d.id}">${esc(d.name)}</button>`).join('') || '<span class="muted">No departments yet — add one under Departments.</span>';
  $$('[data-pickdept]').forEach(b => b.onclick = () => changeScope({ deptId: b.dataset.pickdept }));
}
async function changeScope({ orgId, deptId }) {
  if (dirty() && !confirm('Discard unsaved roster changes?')) { drawDeptPicker(); if (SUPER) $('#orgSel').value = S.orgId || ''; return; }
  R = null;
  if (orgId !== undefined && orgId !== S.orgId) { S.deptId = ''; await setOrg(orgId); }
  if (deptId !== undefined) { S.deptId = deptId; if (!DEPTADMIN) store.set('dept', deptId); drawDeptPicker(); }
  loaded.clear(); calCache.clear(); users = []; leaves = [];
  refreshBadges();
  showTab(current);
}
$('#orgSel').onchange = e => changeScope({ orgId: e.target.value });
$('#deptSel').onchange = e => changeScope({ deptId: e.target.value });

/* ============ tabs ============ */
const loaders = {};
const loaded = new Set();
let current = 'staff';
function showTab(name) {
  const tab = $(`.tab[data-tab="${name}"]`);
  if (!tab || tab.hidden) name = S.orgId ? 'staff' : (SUPER ? 'companies' : 'staff');
  current = name;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  const panel = $(`[data-panel="${name}"]`);
  const needsDept = panel.hasAttribute('data-needs-dept') && !S.deptId;
  const noOrg = !S.orgId && name !== 'companies';
  $$('[data-panel]').forEach(p => p.hidden = p !== panel || needsDept || noOrg);
  $('#needDept').hidden = !needsDept || noOrg;
  history.replaceState(null, '', '#' + name);
  if (noOrg) { toast(SUPER ? 'Create or choose a company first.' : 'Your account is not linked to a company.', 'bad'); return; }
  if (!needsDept && !loaded.has(name)) { loaded.add(name); Promise.resolve(loaders[name]?.()).catch(e => toast(e.message, 'bad', 8000)); }
}
$$('.tab').forEach(t => t.onclick = () => showTab(t.dataset.tab));

/* ============ STAFF ============ */
let users = [];
async function loadUsers() {
  const s = await getDocs(scopeQ('users'));
  users = s.docs.map(d => ({ id: d.id, ...d.data() }));
  const pend = users.filter(u => u.status === 'pending').length;
  $('#bStaff').hidden = !pend; $('#bStaff').textContent = pend;
  $('#levels').innerHTML = [...new Set(users.map(u => u.level).filter(Boolean))].map(l => `<option value="${esc(l)}">`).join('');
  return users;
}
// which roles I can give, and whom I may edit
const assignable = SUPER || ROLE === 'admin' ? ['staff', 'deptadmin', 'admin'] : ['staff', 'deptadmin'];
const canEdit = u => SUPER || (ROLE === 'admin' && u.role !== 'super') || (DEPTADMIN && ['staff', 'deptadmin'].includes(u.role || 'staff'));
function drawStaff() {
  const f = $('#staffFilter').value, q = $('#staffSearch').value.trim().toLowerCase();
  const order = { pending: 0, active: 1, disabled: 2 };
  const list = users.filter(u => (!f || u.status === f) && (!q || `${u.name} ${u.staffId} ${u.email} ${deptName(u.deptId)}`.toLowerCase().includes(q)))
    .sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || (a.name || '').localeCompare(b.name || ''));
  $('#staffBody').innerHTML = list.length ? list.map(u => `<tr>
    <td><strong>${esc(u.name)}</strong><div class="small muted">${esc(u.email)}${u.phone ? ' · ' + esc(u.phone) : ''}</div></td>
    <td>${esc(u.staffId)}</td><td>${esc(deptName(u.deptId) || u.deptName || '—')}<div class="small muted">${esc(u.designation)}</div></td>
    <td>${u.level ? esc(u.level) : '<span class="muted">not set</span>'}</td>
    <td>${u.role && u.role !== 'staff' ? `<span class="pill admin">${esc(ROLE_LABEL[u.role] || u.role)}</span>` : 'Staff'}</td><td>${pill(u.status)}</td>
    <td>${u.alTaken || 0}/${u.alEntitlement ?? self.DEFAULT_AL_DAYS ?? 30}</td>
    <td>${(u.fcmTokens || []).length ? '✓' : '<span class="muted">—</span>'}</td>
    <td><div class="actions">${!canEdit(u) ? '' : u.status === 'pending' ? `<button class="btn ok sm" data-edit="${u.id}" data-approve="1">Approve…</button>` : `<button class="btn ghost sm" data-edit="${u.id}">Edit</button>`}</div></td></tr>`).join('')
    : `<tr><td colspan="9" class="empty">No staff yet. Share the company code from Settings → Invite staff.</td></tr>`;
  $$('[data-edit]').forEach(b => b.onclick = () => openStaff(b.dataset.edit, !!b.dataset.approve));
}
let editing = null;
function openStaff(id, approve) {
  const u = users.find(x => x.id === id); editing = u;
  $('#dlgTitle').textContent = approve ? `Approve ${u.name}` : `Edit ${u.name}`;
  const set = (k, v) => $('#' + k).value = v ?? '';
  $('#fDept').innerHTML = (DEPTADMIN ? S.depts.filter(d => d.id === S.deptId) : S.depts).map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  $('#fDept').disabled = DEPTADMIN;
  $('#fRole').innerHTML = assignable.map(r => `<option value="${r}">${ROLE_LABEL[r]}</option>`).join('');
  set('fName', u.name); set('fStaffId', u.staffId); set('fDept', u.deptId); set('fDesig', u.designation); set('fLevel', u.level);
  set('fPhone', u.phone); set('fRole', u.role || 'staff'); set('fStatus', approve ? 'active' : u.status);
  set('fEnt', u.alEntitlement ?? self.DEFAULT_AL_DAYS ?? 30); set('fTaken', u.alTaken || 0);
  $('#fRoleHint').textContent = 'Department admin: manages only their department. Company admin: manages the whole company, its departments and settings.';
  $('#fEmail').textContent = `Email: ${u.email} · Registered ${fmtTs(u.createdAt)}`;
  $('#staffDlg').showModal();
}
$('#dlgCancel').onclick = () => $('#staffDlg').close();
$('#staffForm').onsubmit = async e => {
  e.preventDefault();
  const u = editing; const v = id => $('#' + id).value.trim();
  if (u.id === user.uid && (v('fRole') !== ROLE || v('fStatus') !== 'active') && !confirm('You are changing your own access. You may lose admin rights. Continue?')) return;
  const deptId = v('fDept');
  const data = {
    name: v('fName'), staffId: v('fStaffId').toUpperCase(), deptId, deptName: deptName(deptId), designation: v('fDesig'), level: v('fLevel'),
    phone: v('fPhone'), role: v('fRole'), status: v('fStatus'), alEntitlement: Number(v('fEnt') || 0), alTaken: Number(v('fTaken') || 0), updatedAt: serverTimestamp()
  };
  const b = $('#dlgSave'); busy(b, true, 'Saving…');
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', u.id), data);
    batch.set(doc(db, 'directory', u.id), { name: data.name, staffId: data.staffId, level: data.level, orgId: u.orgId, deptId, designation: data.designation, active: data.status === 'active' }, { merge: true });
    await batch.commit();
    $('#staffDlg').close(); toast(u.deptId !== deptId ? `Saved and moved to ${deptName(deptId)}.` : 'Saved.', 'ok'); await loadUsers(); drawStaff();
  } catch (err) { toast(err.code === 'permission-denied' ? 'You do not have permission to make that change.' : err.message, 'bad'); }
  busy(b, false);
};
$('#staffFilter').onchange = drawStaff; $('#staffSearch').oninput = drawStaff;
loaders.staff = async () => { await loadUsers(); drawStaff(); };

/* ============ REPORTS ============ */
let reports = [];
loaders.reports = async () => {
  const s = await getDocs(scopeQ('reports'));
  reports = s.docs.map(d => ({ id: d.id, ...d.data() })).sort(byNewest); drawReports();
};
function drawReports() {
  const t = $('#repType').value, m = $('#repMonth').value, q = $('#repSearch').value.trim().toLowerCase();
  const list = reports.filter(r => (!t || r.type === t) && (!m || r.fromDate.startsWith(m) || r.toDate.startsWith(m)) && (!q || `${r.staffName} ${r.staffId}`.toLowerCase().includes(q)));
  $('#repBody').innerHTML = list.length ? list.map(r => `<tr>
    <td class="small">${fmtTs(r.createdAt)}</td><td><strong>${esc(r.staffName)}</strong><div class="small muted">${esc(r.staffId)} · ${esc(deptName(r.deptId) || r.deptName)}</div></td>
    <td>${r.type}</td><td>${fmtShort(r.fromDate)} – ${fmtShort(r.toDate)}</td><td>${r.days}</td><td class="small">${esc(r.reason)}</td>
    <td class="small">${(r.attachments || []).map(a => '📎 ' + esc(a.name)).join('<br>') || '<span class="muted">None</span>'}${(r.attachments || []).length ? '<div class="muted">emailed only</div>' : ''}</td>
    <td>${pill(r.status)}${r.notifiedAt ? '' : '<div class="small" style="color:var(--bad)">not emailed</div>'}</td>
    <td><div class="actions">${r.status !== 'acknowledged' ? `<button class="btn ghost sm" data-ack="${r.id}">Acknowledge</button>` : ''}
      ${r.notifiedAt ? '' : `<button class="btn ghost sm" data-resend="${r.id}" title="Sends the report details without attachments (only the staff member has the files)">Send email</button>`}</div></td></tr>`).join('')
    : '<tr><td colspan="9" class="empty">No reports.</td></tr>';
  $$('[data-ack]').forEach(b => b.onclick = async () => {
    await updateDoc(doc(db, 'reports', b.dataset.ack), { status: 'acknowledged', acknowledgedBy: profile.name, acknowledgedAt: serverTimestamp() });
    reports.find(r => r.id === b.dataset.ack).status = 'acknowledged'; drawReports();
  });
  $$('[data-resend]').forEach(b => b.onclick = async () => {
    busy(b, true, 'Sending…');
    try { await api('/api/notify', { event: 'report', id: b.dataset.resend }); toast('Sent.', 'ok'); loaders.reports(); } catch (e) { toast(e.message, 'bad'); busy(b, false); }
  });
}
$('#repType').onchange = drawReports; $('#repMonth').onchange = drawReports; $('#repSearch').oninput = drawReports;

/* ============ LEAVE REQUESTS ============ */
let leaves = [];
const calCache = new Map();
async function getCal(y, deptId = S.deptId, fresh = false) {
  const id = calId(y, S.orgId, deptId);
  if (fresh || !calCache.has(id)) { const s = await getDoc(doc(db, 'leaveCalendar', id)).catch(() => null); calCache.set(id, s?.exists() ? s.data() : {}); }
  return calCache.get(id);
}
async function loadLeaves() {
  const s = await getDocs(scopeQ('leaveRequests'));
  leaves = s.docs.map(d => ({ id: d.id, ...d.data() })).sort(byNewest);
  const p = leaves.filter(l => l.status === 'pending').length;
  $('#bLeave').hidden = !p; $('#bLeave').textContent = p;
}
async function drawLeaves() {
  if (!users.length) await loadUsers();
  const f = $('#leaveFilter').value;
  const list = leaves.filter(l => !f || l.status === f);
  const rows = await Promise.all(list.map(async l => {
    const u = users.find(x => x.id === l.uid) || {};
    const bal = (u.alEntitlement ?? self.DEFAULT_AL_DAYS ?? 30) - (u.alTaken || 0);
    let full = 0;
    for (const d of dateRange(l.fromDate, l.toDate)) { const st = dayStatus(await getCal(d.slice(0, 4), l.deptId), d).state; if (st === 'full' || st === 'closed') full++; }
    return `<tr><td class="small">${fmtTs(l.createdAt)}</td><td><strong>${esc(l.staffName)}</strong><div class="small muted">${esc(l.staffId)} · ${esc(deptName(l.deptId) || l.deptName)}</div></td>
      <td>${fmtShort(l.fromDate)} – ${fmtShort(l.toDate)}</td><td>${l.days}</td>
      <td>${bal < l.days && l.status === 'pending' ? `<span style="color:var(--bad);font-weight:700">${bal} left</span>` : `${bal} left`}</td>
      <td>${full ? `<span style="color:var(--bad);font-weight:700">${plural(full, 'day')} full</span>` : '<span style="color:var(--ok)">OK</span>'}</td>
      <td class="small">${esc(l.reason)}${l.adminComment ? `<div class="muted">Admin: ${esc(l.adminComment)}</div>` : ''}</td><td>${pill(l.status)}</td>
      <td><div class="actions">${l.status === 'pending' ? `<button class="btn ok sm" data-lv="${l.id}" data-d="approved">Approve</button><button class="btn ghost sm" data-lv="${l.id}" data-d="rejected">Reject</button>`
        : l.status === 'approved' ? `<button class="btn ghost sm" data-lv="${l.id}" data-d="revoked">Revoke</button>` : ''}</div></td></tr>`;
  }));
  $('#leaveBody').innerHTML = rows.join('') || '<tr><td colspan="9" class="empty">No requests.</td></tr>';
  $$('[data-lv]').forEach(b => b.onclick = () => decideLeave(b.dataset.lv, b.dataset.d, b));
}
async function decideLeave(id, decision, btn) {
  const l = leaves.find(x => x.id === id);
  const verb = { approved: 'Approve', rejected: 'Reject', revoked: 'Revoke' }[decision];
  const comment = prompt(`${verb} ${l.staffName}'s leave (${fmtShort(l.fromDate)} – ${fmtShort(l.toDate)}).\nComment for the staff member (optional):`, '');
  if (comment === null) return;
  busy(btn, true, '…');
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'leaveRequests', id), { status: decision, adminComment: comment.trim(), decidedBy: profile.name, decidedAt: serverTimestamp() });
    const sign = decision === 'approved' ? 1 : decision === 'revoked' ? -1 : 0;
    if (sign) {
      batch.update(doc(db, 'users', l.uid), { alTaken: increment(sign * l.days) });
      const byYear = {};
      dateRange(l.fromDate, l.toDate).forEach(d => (byYear[d.slice(0, 4)] ||= {})[d] = increment(sign));
      Object.entries(byYear).forEach(([y, booked]) => batch.set(doc(db, 'leaveCalendar', calId(y, l.orgId, l.deptId)), { orgId: l.orgId, deptId: l.deptId, booked }, { merge: true }));
    }
    await batch.commit();
    calCache.clear();
    await notifySoft({ event: 'leave_decision', id });
    toast(`Leave ${decision}.`, 'ok');
    await Promise.all([loadLeaves(), loadUsers()]); drawLeaves();
  } catch (e) { toast(e.message, 'bad'); busy(btn, false); }
}
$('#leaveFilter').onchange = drawLeaves;
loaders.leave = async () => { await loadLeaves(); drawLeaves(); };
function refreshBadges() { if (!S.orgId) return; loadLeaves().catch(() => {}); loadUsers().then(() => { if (current === 'staff') drawStaff(); }).catch(() => {}); }

/* ============ LEAVE CALENDAR (one department) ============ */
let calView = new Date(); calView.setDate(1);
let calPick = null;
$('#calLegend').innerHTML = CAL_LEGEND;
async function drawCal() {
  const y = calView.getFullYear(), m = calView.getMonth();
  $('#calTitle').textContent = calView.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('#defYear').textContent = y;
  const cal = await getCal(y);
  $('#defQ').value = cal.defaultQuota ?? '';
  $('#cal').innerHTML = calendarHTML(y, m, cal, new Set(dateRange($('#qFrom').value, $('#qTo').value)));
  $$('#cal .day[data-date]').forEach(b => b.onclick = () => {
    const d = b.dataset.date;
    if (!calPick || d < calPick) { calPick = d; $('#qFrom').value = $('#qTo').value = d; } else { $('#qTo').value = d; calPick = null; }
    showOnLeave(d); drawCal();
  });
}
async function showOnLeave(d) {
  if (!leaves.length) await loadLeaves();
  const on = leaves.filter(l => l.deptId === S.deptId && (l.status === 'approved' || l.status === 'pending') && l.fromDate <= d && l.toDate >= d);
  $('#onLeave').innerHTML = `<strong>${fmtShort(d)}:</strong> ` + (on.length ? on.map(l => `${esc(l.staffName)} ${l.status === 'pending' ? '<span class="muted">(pending)</span>' : ''}`).join(', ') : '<span class="muted">nobody on leave</span>');
}
$('#calPrev').onclick = () => { calView.setMonth(calView.getMonth() - 1); drawCal(); };
$('#calNext').onclick = () => { calView.setMonth(calView.getMonth() + 1); drawCal(); };
['qFrom', 'qTo'].forEach(id => $('#' + id).onchange = drawCal);
async function writeQuota(valueFn) {
  const days = dateRange($('#qFrom').value, $('#qTo').value).filter(d => !$('#qSkipWe').checked || !isWeekend(d));
  if (!days.length) return toast('Choose a valid date range.', 'bad');
  const byYear = {};
  days.forEach(d => (byYear[d.slice(0, 4)] ||= {})[d] = valueFn());
  const batch = writeBatch(db);
  Object.entries(byYear).forEach(([y, quota]) => batch.set(doc(db, 'leaveCalendar', calId(y)), { orgId: S.orgId, deptId: S.deptId, quota, updatedAt: serverTimestamp() }, { merge: true }));
  await batch.commit();
  calCache.clear();
  toast(`Updated ${plural(days.length, 'day')}.`, 'ok'); drawCal();
}
$('#quotaForm').onsubmit = e => { e.preventDefault(); const n = Number($('#qN').value); writeQuota(() => n).catch(err => toast(err.message, 'bad')); };
$('#qClear').onclick = () => writeQuota(() => deleteField()).catch(err => toast(err.message, 'bad'));
$('#defForm').onsubmit = async e => {
  e.preventDefault(); const y = String(calView.getFullYear()), v = $('#defQ').value;
  await setDoc(doc(db, 'leaveCalendar', calId(y)), { orgId: S.orgId, deptId: S.deptId, defaultQuota: v === '' ? deleteField() : Number(v) }, { merge: true });
  calCache.clear(); toast('Default saved.', 'ok'); drawCal();
};
loaders.calendar = () => { $('#qFrom').value = $('#qTo').value = today(); drawCal(); showOnLeave(today()); };

/* ============ ROSTER (one department) ============ */
let R = null; // { id, month, days, rows, order, names, existing, dirByStaffId }
async function getLegend() {
  const ds = await getDoc(doc(db, 'deptSettings', S.deptId)).catch(() => null);
  return { ...parseLegend(S.org?.legendText), ...parseLegend(ds?.exists() ? ds.data().legendText : '') };
}
$('#rMonth').value = ym(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1));
$('#rMonth').onchange = () => { if (dirty() && !confirm('Discard unsaved roster changes?')) return; loadRosterAdmin(); };
const dirty = () => R && $$('#rGrid input.changed').length > 0;
window.addEventListener('beforeunload', e => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

async function loadRosterAdmin() {
  const month = $('#rMonth').value; if (!month || !S.deptId) return;
  $('#rStatus').textContent = 'Loading…';
  const id = rosterId(month, S.orgId, S.deptId);
  const [dirSnap, rSnap] = await Promise.all([
    getDocs(query(collection(db, 'directory'), where('orgId', '==', S.orgId), where('deptId', '==', S.deptId), where('active', '==', true))),
    getDoc(doc(db, 'rosters', id))
  ]);
  const dir = dirSnap.docs.map(d => ({ uid: d.id, ...d.data() })).sort((a, b) => (a.level || '').localeCompare(b.level || '') || a.name.localeCompare(b.name));
  const existing = rSnap.exists() ? rSnap.data() : null;
  const days = daysInMonth(month);
  const names = { ...(existing?.names || {}) };
  dir.forEach(d => names[d.uid] = { name: d.name, staffId: d.staffId || '', level: d.level || '' });
  const order = [...(existing?.order || [])];
  dir.forEach(d => { if (!order.includes(d.uid)) order.push(d.uid); });
  const rows = {};
  order.forEach(uid => rows[uid] = Array.from({ length: days }, (_, i) => existing?.rows?.[uid]?.[i] || ''));
  R = { id, month, days, rows, order, names, existing, dirByStaffId: Object.fromEntries(dir.map(d => [String(d.staffId).toUpperCase(), d.uid])) };
  $('#rStatus').innerHTML = existing ? `Published · last saved ${fmtTs(existing.updatedAt)}${existing.updatedBy ? ' by ' + esc(existing.updatedBy) : ''}` : '<span style="color:var(--warn)">Not published yet</span>';
  $('#rMsg').textContent = dir.length ? '' : 'No active staff in this department yet.';
  drawRosterGrid();
}
function drawRosterGrid() {
  const { month, days, rows, order, names, existing } = R;
  const dateOf = i => `${month}-${String(i + 1).padStart(2, '0')}`;
  let h = '<thead><tr><th class="name">Staff</th>';
  for (let i = 0; i < days; i++) { const d = dateOf(i); h += `<th class="${isWeekend(d) ? 'we' : ''}">${new Date(d + 'T00:00').toLocaleDateString(undefined, { weekday: 'narrow' })}<span class="dn">${i + 1}</span></th>`; }
  h += '</tr></thead><tbody>';
  for (const uid of order) {
    const n = names[uid] || {};
    h += `<tr><td class="name">${esc(n.name || uid)}<div class="small muted">${esc(n.staffId || '')}${n.level ? ' · ' + esc(n.level) : ''}</div></td>`;
    for (let i = 0; i < days; i++) {
      const v = rows[uid][i] || '', was = existing?.rows?.[uid]?.[i] || '';
      h += `<td class="${isWeekend(dateOf(i)) ? 'we' : ''}"><input data-u="${uid}" data-i="${i}" value="${esc(v)}" maxlength="6" class="${shiftClass(v)} ${v !== was && existing ? 'changed' : ''}" aria-label="${esc(n.name)} day ${i + 1}"></td>`;
    }
    h += '</tr>';
  }
  $('#rGrid').innerHTML = h + '</tbody>';
  $$('#rGrid input').forEach(inp => inp.oninput = () => {
    const v = inp.value.toUpperCase().trim(); inp.value = v;
    R.rows[inp.dataset.u][+inp.dataset.i] = v;
    const was = R.existing?.rows?.[inp.dataset.u]?.[+inp.dataset.i] || '';
    inp.className = shiftClass(v);
    inp.classList.toggle('changed', !!R.existing && v !== was);
  });
}
$('#rTemplate').onclick = () => {
  if (!R) return;
  const head = ['Staff ID', 'Name', ...Array.from({ length: R.days }, (_, i) => i + 1)];
  const cell = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const lines = [head, ...R.order.map(uid => [R.names[uid]?.staffId || '', R.names[uid]?.name || '', ...R.rows[uid]])].map(r => r.map(cell).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `roster-${(deptName(S.deptId) || 'dept').replace(/[^\w-]+/g, '_')}-${R.month}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
async function loadSheetJS() {
  if (window.XLSX) return window.XLSX;
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load the spreadsheet reader')); document.head.append(s); });
  return window.XLSX;
}
$('#rFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || !R) return;
  try {
    const XLSX = await loadSheetJS();
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
    const hi = aoa.findIndex(r => r.some(c => /staff\s*id/i.test(String(c))));
    if (hi < 0) throw new Error('Could not find a "Staff ID" column in the first sheet.');
    const header = aoa[hi], idCol = header.findIndex(c => /staff\s*id/i.test(String(c)));
    const dayCols = {};
    header.forEach((c, j) => {
      let day = null;
      if (typeof c === 'number' && c >= 1 && c <= 31) day = c;
      else if (typeof c === 'number' && c > 31) day = new Date(Math.round((c - 25569) * 86400000)).getUTCDate(); // Excel date
      else if (/^\d{1,2}$/.test(String(c).trim())) day = Number(String(c).trim());
      else if (/^\d{4}-\d{2}-\d{2}/.test(String(c).trim())) day = Number(String(c).trim().slice(8, 10));
      if (day && day <= R.days) dayCols[j] = day - 1;
    });
    if (!Object.keys(dayCols).length) throw new Error('No day columns found. Use 1, 2, 3 … or dates as column headers.');
    let matched = 0; const unknown = [];
    for (const row of aoa.slice(hi + 1)) {
      const sid = String(row[idCol] ?? '').trim().toUpperCase(); if (!sid) continue;
      const uid = R.dirByStaffId[sid];
      if (!uid) { unknown.push(sid); continue; }
      if (!R.rows[uid]) { R.rows[uid] = Array(R.days).fill(''); R.order.push(uid); }
      Object.entries(dayCols).forEach(([j, i]) => R.rows[uid][i] = String(row[j] ?? '').trim().toUpperCase());
      matched++;
    }
    drawRosterGrid();
    $('#rMsg').innerHTML = `Loaded ${plural(matched, 'staff row')} from <strong>${esc(f.name)}</strong>. Review the grid, then press <strong>Save &amp; publish</strong>.`
      + (unknown.length ? `<div style="color:var(--bad)">Staff IDs not active in ${esc(deptName(S.deptId))}, skipped: ${unknown.map(esc).join(', ')}</div>` : '');
  } catch (err) { toast(err.message, 'bad', 8000); }
};
$('#rSave').onclick = async () => {
  if (!R) return;
  const b = $('#rSave'); busy(b, true, 'Saving…');
  try {
    const { id, month, days, rows, order, names, existing } = R;
    const changes = {};
    order.forEach(uid => {
      const ds = [];
      rows[uid].forEach((v, i) => { const was = existing?.rows?.[uid]?.[i] || ''; if (v !== was) ds.push(`${month}-${String(i + 1).padStart(2, '0')}`); });
      if (ds.length) changes[uid] = ds;
    });
    if (existing && !Object.keys(changes).length) { toast('No changes to save.'); busy(b, false); return; }
    const legend = await getLegend();
    const cleanOrder = order.filter(uid => rows[uid].some(Boolean) || existing?.rows?.[uid]);
    await setDoc(doc(db, 'rosters', id), {
      orgId: S.orgId, deptId: S.deptId, month, days, order: cleanOrder, names: Object.fromEntries(cleanOrder.map(u => [u, names[u] || {}])),
      rows: Object.fromEntries(cleanOrder.map(u => [u, rows[u]])), legend, updatedAt: serverTimestamp(), updatedBy: profile.name
    });
    const notifyUids = Object.keys(changes).filter(u => cleanOrder.includes(u));
    let msg = 'Roster saved.';
    if ($('#rNotify').checked && notifyUids.length) {
      const r = await notifySoft({ event: 'roster', rosterId: id, isNew: !existing, changes: Object.fromEntries(notifyUids.map(u => [u, changes[u]])) });
      if (r) msg += ` ${plural(notifyUids.length, 'staff member')} notified.`;
    }
    toast(msg, 'ok'); await loadRosterAdmin();
  } catch (err) { toast(err.message, 'bad'); }
  busy(b, false);
};
loaders.roster = loadRosterAdmin;

/* ============ SWAPS ============ */
let swaps = [];
loaders.swaps = async () => { const s = await getDocs(scopeQ('swaps')); swaps = s.docs.map(d => ({ id: d.id, ...d.data() })).sort(byNewest); drawSwaps(); };
function drawSwaps() {
  const f = $('#swFilter').value;
  const list = swaps.filter(s => !f || s.status === f);
  $('#swBody').innerHTML = list.length ? list.map(s => `<tr><td class="small">${fmtTs(s.createdAt)}</td>
    <td><strong>${esc(s.requesterName)}</strong><div class="small muted">${esc(s.requesterStaffId)}</div></td>
    <td><strong>${esc(s.targetName)}</strong><div class="small muted">${esc(s.targetStaffId)}</div></td>
    <td class="small">${esc(deptName(s.deptId))}</td>
    <td class="small">${fmtShort(s.requesterDate)} ${esc(s.requesterShift || '—')} ⇄ ${s.targetDate !== s.requesterDate ? fmtShort(s.targetDate) + ' ' : ''}${esc(s.targetShift || '—')}</td>
    <td class="small">${esc(s.reason)}</td><td>${pill(s.status)}</td>
    <td class="small">${s.status === 'accepted' ? (s.rosterUpdated ? 'Updated' : '<span style="color:var(--warn)">No roster to update</span>') : ''}</td>
    <td>${s.status === 'pending' ? `<button class="btn ghost sm" data-swc="${s.id}">Cancel</button>` : ''}</td></tr>`).join('')
    : '<tr><td colspan="9" class="empty">No requests.</td></tr>';
  $$('[data-swc]').forEach(b => b.onclick = async () => {
    if (!confirm('Cancel this duty change request?')) return;
    await updateDoc(doc(db, 'swaps', b.dataset.swc), { status: 'cancelled', updatedAt: serverTimestamp(), cancelledBy: profile.name });
    loaders.swaps();
  });
}
$('#swFilter').onchange = drawSwaps;

/* ============ DEPARTMENTS (company admin) ============ */
/** keeps the public company-code record (company name + department list for registration) in step */
async function syncJoinCode() {
  if (!S.org?.code) return;
  await setDoc(doc(db, 'joinCodes', S.org.code), {
    orgId: S.orgId, orgName: S.org.name, active: S.org.active !== false,
    departments: S.depts.map(d => ({ id: d.id, name: d.name, active: d.active !== false }))
  });
}
loaders.departments = async () => {
  const s = await getDocs(query(collection(db, 'users'), where('orgId', '==', S.orgId)));
  const count = {}; s.docs.forEach(d => { const k = d.data().deptId; count[k] = (count[k] || 0) + 1; });
  $('#deptBody').innerHTML = S.depts.length ? S.depts.map(d => `<tr><td><strong>${esc(d.name)}</strong></td><td>${count[d.id] || 0}</td>
    <td>${d.active === false ? pill('disabled') : pill('active')}</td>
    <td><div class="actions">
      <button class="btn ghost sm" data-dset="${d.id}">Settings</button>
      <button class="btn ghost sm" data-dren="${d.id}">Rename</button>
      <button class="btn ghost sm" data-dact="${d.id}">${d.active === false ? 'Activate' : 'Hide'}</button>
      ${count[d.id] ? '' : `<button class="btn ghost sm" data-ddel="${d.id}">Delete</button>`}
    </div></td></tr>`).join('') : '<tr><td colspan="4" class="empty">No departments yet.</td></tr>';
  const after = async msg => { await setOrg(S.orgId); await syncJoinCode(); toast(msg, 'ok'); loaders.departments(); };
  $$('[data-dset]').forEach(b => b.onclick = async () => { await changeScope({ deptId: b.dataset.dset }); showTab('settings'); });
  $$('[data-dren]').forEach(b => b.onclick = async () => {
    const d = S.depts.find(x => x.id === b.dataset.dren); const name = prompt('New name for ' + d.name, d.name);
    if (!name?.trim() || name.trim() === d.name) return;
    try { await updateDoc(doc(db, 'departments', d.id), { name: name.trim() }); await after('Renamed.'); } catch (e) { toast(e.message, 'bad'); }
  });
  $$('[data-dact]').forEach(b => b.onclick = async () => {
    const d = S.depts.find(x => x.id === b.dataset.dact);
    try { await updateDoc(doc(db, 'departments', d.id), { active: d.active === false }); await after(d.active === false ? 'Department active again.' : 'Hidden from the registration page.'); } catch (e) { toast(e.message, 'bad'); }
  });
  $$('[data-ddel]').forEach(b => b.onclick = async () => {
    const d = S.depts.find(x => x.id === b.dataset.ddel);
    if (!confirm(`Delete ${d.name}? Its settings are deleted too.`)) return;
    try { await deleteDoc(doc(db, 'deptSettings', d.id)).catch(() => {}); await deleteDoc(doc(db, 'departments', d.id)); if (S.deptId === d.id) S.deptId = ''; await after('Deleted.'); } catch (e) { toast(e.message, 'bad'); }
  });
};
$('#deptForm').onsubmit = async e => {
  e.preventDefault();
  const name = $('#newDept').value.trim(); if (!name) return;
  if (S.depts.some(d => d.name.toLowerCase() === name.toLowerCase())) return toast('That department already exists.', 'bad');
  try {
    await addDoc(collection(db, 'departments'), { orgId: S.orgId, name, active: true, createdAt: serverTimestamp() });
    $('#newDept').value = ''; await setOrg(S.orgId); await syncJoinCode(); toast(`${name} added.`, 'ok'); loaders.departments();
  } catch (err) { toast(err.message, 'bad'); }
};

/* ============ SETTINGS ============ */
const LISTS = ['slEmails', 'frlEmails', 'leaveEmails', 'swapEmails'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
$('#oWeekend').innerHTML = DAYS.map((d, i) => `<label class="check" style="margin:0 8px 0 0"><input type="checkbox" value="${i}"> ${d}</label>`).join('');
loaders.settings = async () => {
  $('#meEmail').textContent = profile.email;
  const code = S.org?.code || '';
  $('#inviteCode').textContent = code || '—';
  $('#inviteLink').value = code ? `${location.origin}/register.html?code=${encodeURIComponent(code)}` : '';
  if (ORGADMIN && S.org) {
    const o = S.org;
    $('#oName').value = o.name || ''; $('#oShort').value = o.shortName || ''; $('#oEmail').value = o.contactEmail || ''; $('#oPhone').value = o.contactPhone || '';
    $('#oAddr').value = o.address || ''; $('#oCode').value = o.code || ''; $('#oAL').value = o.defaultAL ?? 30; $('#oLegend').value = o.legendText || '';
    const we = o.weekendDays || [5, 6]; $$('#oWeekend input').forEach(c => c.checked = we.includes(Number(c.value)));
    const s = await getDoc(doc(db, 'orgSettings', S.orgId));
    const st = s.exists() ? s.data() : {};
    LISTS.forEach(k => $('#o_' + k).value = (st[k] || []).join('\n'));
    $('#emailAdmins').checked = st.emailAdmins !== false; $('#pushAdmins').checked = st.pushAdmins !== false;
  }
  $('#deptSetForm').hidden = !S.deptId; $('#deptSetPick').hidden = !!S.deptId;
  if (S.deptId) {
    const s = await getDoc(doc(db, 'deptSettings', S.deptId));
    const st = s.exists() ? s.data() : {};
    LISTS.forEach(k => $('#d_' + k).value = (st[k] || []).join('\n'));
    $('#d_legend').value = st.legendText || '';
  }
};
$('#copyLink').onclick = async () => { try { await navigator.clipboard.writeText($('#inviteLink').value); toast('Link copied.', 'ok'); } catch { $('#inviteLink').select(); } };
$('#orgForm').onsubmit = async e => {
  e.preventDefault(); const b = $('#orgSave'); busy(b, true, 'Saving…');
  try {
    const code = $('#oCode').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,16}$/.test(code)) throw new Error('Company code must be 4–16 letters or numbers.');
    const data = {
      name: $('#oName').value.trim(), shortName: $('#oShort').value.trim(), contactEmail: $('#oEmail').value.trim(), contactPhone: $('#oPhone').value.trim(),
      address: $('#oAddr').value.trim(), code, defaultAL: Number($('#oAL').value || 0), legendText: $('#oLegend').value.trim(),
      weekendDays: $$('#oWeekend input:checked').map(c => Number(c.value)), updatedAt: serverTimestamp()
    };
    const old = S.org.code;
    if (code !== old) {
      const taken = await getDoc(doc(db, 'joinCodes', code));
      if (taken.exists() && taken.data().orgId !== S.orgId) throw new Error('That company code is already used by another company.');
    }
    const batch = writeBatch(db);
    batch.update(doc(db, 'orgs', S.orgId), data);
    if (old && old !== code) batch.delete(doc(db, 'joinCodes', old));
    await batch.commit();
    await setOrg(S.orgId); await syncJoinCode();
    if (SUPER) await loadOrgs().then(() => $('#orgSel').value = S.orgId);
    toast('Company details saved.', 'ok'); loaders.settings();
  } catch (err) { toast(err.message, 'bad', 7000); }
  busy(b, false);
};
$('#orgMailForm').onsubmit = async e => {
  e.preventDefault(); const b = $('#orgMailSave'); busy(b, true, 'Saving…');
  try {
    const data = { emailAdmins: $('#emailAdmins').checked, pushAdmins: $('#pushAdmins').checked, updatedAt: serverTimestamp() };
    LISTS.forEach(k => { data[k] = linesToEmails($('#o_' + k).value); $('#o_' + k).value = data[k].join('\n'); });
    await setDoc(doc(db, 'orgSettings', S.orgId), data, { merge: true });
    toast('Company email lists saved.', 'ok');
  } catch (err) { toast(err.message, 'bad'); }
  busy(b, false);
};
$('#deptSetForm').onsubmit = async e => {
  e.preventDefault(); const b = $('#deptSetSave'); busy(b, true, 'Saving…');
  try {
    const data = { orgId: S.orgId, legendText: $('#d_legend').value.trim(), updatedAt: serverTimestamp() };
    LISTS.forEach(k => { data[k] = linesToEmails($('#d_' + k).value); $('#d_' + k).value = data[k].join('\n'); });
    await setDoc(doc(db, 'deptSettings', S.deptId), data, { merge: true });
    toast(`${deptName(S.deptId)} settings saved.`, 'ok');
  } catch (err) { toast(err.message, 'bad'); }
  busy(b, false);
};
$('#testBtn').onclick = async () => {
  const b = $('#testBtn'); busy(b, true, 'Sending…');
  try {
    const r = await api('/api/notify', { event: 'test', orgId: S.orgId, deptId: S.deptId || null });
    toast(`Test sent: ${r.emailed} email, ${r.pushed} push.${r.errors?.length ? ' Problems: ' + r.errors.join('; ') : ''}`, r.errors?.length ? 'bad' : 'ok', 9000);
  } catch (e) { toast(e.message, 'bad', 9000); }
  busy(b, false);
};

/* ============ COMPANIES (platform owner) ============ */
loaders.companies = async () => {
  await loadOrgs();
  $('#orgBody').innerHTML = orgs.length ? orgs.map(o => `<tr><td><strong>${esc(o.name)}</strong><div class="small muted">${esc(o.contactEmail || '')}</div></td>
    <td><code>${esc(o.code || '')}</code></td><td>${o.active === false ? pill('disabled') : pill('active')}</td>
    <td><div class="actions"><button class="btn ghost sm" data-open="${o.id}">Open</button>
      <button class="btn ghost sm" data-oact="${o.id}">${o.active === false ? 'Activate' : 'Deactivate'}</button></div></td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">No companies yet. Add the first one →</td></tr>';
  $$('[data-open]').forEach(b => b.onclick = async () => { $('#orgSel').value = b.dataset.open; await changeScope({ orgId: b.dataset.open }); showTab('staff'); });
  $$('[data-oact]').forEach(b => b.onclick = async () => {
    const o = orgs.find(x => x.id === b.dataset.oact); const active = o.active === false;
    if (!active && !confirm(`Deactivate ${o.name}? Its staff can no longer use the portal or register.`)) return;
    const batch = writeBatch(db);
    batch.update(doc(db, 'orgs', o.id), { active });
    if (o.code) batch.set(doc(db, 'joinCodes', o.code), { active }, { merge: true });
    await batch.commit(); toast(active ? 'Company activated.' : 'Company deactivated.', 'ok');
    if (o.id === S.orgId) await setOrg(o.id);
    loaders.companies();
  });
};
$('#nName').oninput = () => { if (!$('#nCode').dataset.touched) $('#nCode').value = $('#nName').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) + String(new Date().getFullYear()).slice(2); };
$('#nCode').oninput = () => $('#nCode').dataset.touched = '1';
$('#newOrgForm').onsubmit = async e => {
  e.preventDefault(); const b = $('#newOrgBtn'); busy(b, true, 'Creating…');
  try {
    const name = $('#nName').value.trim(), code = $('#nCode').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,16}$/.test(code)) throw new Error('Company code must be 4–16 letters or numbers.');
    if ((await getDoc(doc(db, 'joinCodes', code))).exists()) throw new Error('That company code is already used.');
    const deptNames = [...new Set($('#nDepts').value.split('\n').map(x => x.trim()).filter(Boolean))];
    if (!deptNames.length) deptNames.push('General');
    const orgRef = doc(collection(db, 'orgs'));
    const batch = writeBatch(db);
    batch.set(orgRef, { name, code, active: true, weekendDays: [5, 6], defaultAL: self.DEFAULT_AL_DAYS ?? 30, legendText: 'OFF = Day off', createdAt: serverTimestamp() });
    batch.set(doc(db, 'orgSettings', orgRef.id), { emailAdmins: true, pushAdmins: true, slEmails: [], frlEmails: [], leaveEmails: [], swapEmails: [] });
    const depts = deptNames.map(n => { const r = doc(collection(db, 'departments')); batch.set(r, { orgId: orgRef.id, name: n, active: true, createdAt: serverTimestamp() }); return { id: r.id, name: n, active: true }; });
    batch.set(doc(db, 'joinCodes', code), { orgId: orgRef.id, orgName: name, active: true, departments: depts });
    await batch.commit();
    e.target.reset(); $('#nDepts').value = 'General'; delete $('#nCode').dataset.touched;
    toast(`${name} created. Company code: ${code}`, 'ok', 8000);
    await loaders.companies(); $('#orgSel').value = orgRef.id; await changeScope({ orgId: orgRef.id }); showTab('settings');
  } catch (err) { toast(err.message, 'bad', 7000); }
  busy(b, false);
};

/* ============ start ============ */
if (SUPER) {
  $('#orgPick').hidden = false;
  await loadOrgs();
  if (!orgs.some(o => o.id === S.orgId)) S.orgId = orgs[0]?.id || null;
  $('#orgSel').value = S.orgId || '';
}
await setOrg(S.orgId);
refreshBadges();
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
showTab(location.hash.slice(1) || (S.orgId ? 'staff' : 'companies'));
