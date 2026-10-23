import {
  requireUser, db, $, $$, esc, fmtShort, fmtTs, pill, plural, today, dateRange, isWeekend, toast, busy, api,
  byNewest, calendarHTML, CAL_LEGEND, dayStatus, enablePush, pushEnabled, calId, ROLE_LABEL, APP_NAME, mergeShifts,
  cachedDoc, cachedDocs, freshly, invalidate, clearDeviceData,
  collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, query, where, writeBatch, serverTimestamp, increment, deleteField
} from '/js/app.js';
import { initRosterEditor, shiftEditor, DEFAULT_SHIFTS } from '/js/roster-editor.js';

document.title = `Admin · ${APP_NAME}`;
const { user, profile } = await requireUser({ admin: true });

/* ============ who am I, what can I see ============
   super      App admin      — any company, all tabs + Companies
   admin      Company admin  — own company, every unit, Units tab + company settings
   deptadmin  Unit admin     — only the units they manage (their own + any extra the company admin ticked) */
const ROLE = profile.role;
const SUPER = ROLE === 'super';
const ORGADMIN = SUPER || ROLE === 'admin';
const UNITADMIN = ROLE === 'deptadmin';
const MY_UNITS = [...new Set([profile.deptId, ...(profile.units || [])].filter(Boolean))];
const store = { get: k => { try { return localStorage.getItem('adm:' + k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem('adm:' + k, v ?? ''); } catch {} } };

const S = {
  orgId: SUPER ? store.get('org') : profile.orgId,
  deptId: UNITADMIN ? (MY_UNITS.includes(store.get('dept')) ? store.get('dept') : profile.deptId) : (store.get('dept') || ''),
  org: null, depts: []
};
const deptName = id => S.depts.find(d => d.id === id)?.name || '';
const key = name => `${name}:${S.orgId}:${S.deptId || 'all'}`;
const linesToEmails = s => [...new Set(s.split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)))];
const notifySoft = async body => { try { return await api('/api/notify', body); } catch (e) { toast('Saved, but notification failed: ' + e.message, 'bad', 8000); } };
/** query limited to the current company (+ unit if one is chosen) */
const scopeQ = (col, ...extra) => query(collection(db, col), where('orgId', '==', S.orgId), ...(S.deptId ? [where('deptId', '==', S.deptId)] : []), ...extra);

$('#roleBadge').textContent = ROLE_LABEL[ROLE] || ROLE;
$$('[data-role="super"]').forEach(x => x.hidden = !SUPER);
$$('[data-role="orgadmin"]').forEach(x => x.hidden = !ORGADMIN);

if (!pushEnabled()) $('#pushBtn').hidden = false;
$('#pushBtn').onclick = async () => {
  try { await enablePush(user.uid); $('#pushBtn').hidden = true; toast('Notifications enabled.', 'ok'); } catch (e) { toast(e.message, 'bad', 8000); }
};

// keep my own colleague-directory entry up to date (not for the App admin, who belongs to no company)
if (profile.orgId && profile.deptId) {
  setDoc(doc(db, 'directory', user.uid), {
    name: profile.name, staffId: profile.staffId || '', level: profile.level || '', orgId: profile.orgId, deptId: profile.deptId,
    designation: profile.designation || '', active: true
  }, { merge: true }).catch(() => {});
}

const editor = initRosterEditor({ S, profile, deptName, notifySoft, openShiftRules: () => openShiftRules() });

/* ============ company / unit picker ============ */
let orgs = [];
async function loadOrgs() {
  orgs = (await cachedDocs('orgs', collection(db, 'orgs'))).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  $('#orgSel').innerHTML = orgs.length ? orgs.map(o => `<option value="${o.id}">${esc(o.name)}${o.active === false ? ' (inactive)' : ''}</option>`).join('') : '<option value="">No companies yet</option>';
  return orgs;
}
async function setOrg(orgId) {
  S.orgId = orgId || null; S.org = null; S.depts = [];
  if (SUPER) store.set('org', S.orgId);
  if (S.orgId) {
    const [o, d] = await Promise.all([cachedDoc(doc(db, 'orgs', S.orgId)), cachedDocs(`units:${S.orgId}`, query(collection(db, 'departments'), where('orgId', '==', S.orgId)))]);
    S.org = o;
    S.depts = d.sort((a, b) => a.name.localeCompare(b.name));
    if (Array.isArray(S.org?.weekendDays)) self.WEEKEND_DAYS = S.org.weekendDays;
    if (S.org?.defaultAL != null) self.DEFAULT_AL_DAYS = S.org.defaultAL;
  }
  if (!UNITADMIN && S.deptId && !S.depts.some(d => d.id === S.deptId)) S.deptId = '';
  editor.setAiVisible(!!S.org?.aiEnabled);
  drawDeptPicker();
}
function drawDeptPicker() {
  const sel = $('#deptSel');
  if (UNITADMIN) {
    sel.innerHTML = MY_UNITS.map(id => `<option value="${id}">${esc(deptName(id) || (id === profile.deptId ? profile.deptName : '') || 'Unit')}</option>`).join('');
    sel.disabled = MY_UNITS.length < 2;
  } else sel.innerHTML = '<option value="">All units</option>' + S.depts.map(d => `<option value="${d.id}">${esc(d.name)}${d.active === false ? ' (inactive)' : ''}</option>`).join('');
  sel.value = S.deptId || '';
  $('#scopeText').textContent = S.org ? `${S.org.name} · ${S.deptId ? deptName(S.deptId) : 'All units'}` : 'No company selected';
  $$('.deptNameTxt').forEach(x => x.textContent = deptName(S.deptId) || '—');
  const pickable = UNITADMIN ? S.depts.filter(d => MY_UNITS.includes(d.id)) : S.depts.filter(d => d.active !== false);
  $('#needDeptBtns').innerHTML = pickable.map(d => `<button class="btn ghost" data-pickdept="${d.id}">${esc(d.name)}</button>`).join('') || '<span class="muted">No units yet — add one under Units.</span>';
  $$('[data-pickdept]').forEach(b => b.onclick = () => changeScope({ deptId: b.dataset.pickdept }));
}
async function changeScope({ orgId, deptId }) {
  editor.beforeLeave(); // unpublished roster edits stay as a draft on this device
  if (orgId !== undefined && orgId !== S.orgId) { S.deptId = ''; await setOrg(orgId); }
  if (deptId !== undefined) { S.deptId = deptId; store.set('dept', deptId); drawDeptPicker(); }
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
  if (current === 'roster' && name !== 'roster') editor.beforeLeave();
  current = name;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  const panel = $(`[data-panel="${name}"]`);
  const needsDept = panel.hasAttribute('data-needs-dept') && !S.deptId;
  const noOrg = !S.orgId && name !== 'companies';
  $$('[data-panel]').forEach(p => p.hidden = p !== panel || needsDept || noOrg);
  $('#needDept').hidden = !needsDept || noOrg;
  $('main').classList.toggle('wide', name === 'roster');
  history.replaceState(null, '', '#' + name);
  if (noOrg) { toast(SUPER ? 'Create or choose a company first.' : 'Your account is not linked to a company.', 'bad'); return; }
  if (!needsDept && !loaded.has(name)) { loaded.add(name); Promise.resolve(loaders[name]?.()).catch(e => toast(e.message, 'bad', 8000)); }
}
$$('.tab').forEach(t => t.onclick = () => showTab(t.dataset.tab));
window.addEventListener('beforeunload', () => editor.beforeLeave());

/* ============ STAFF ============ */
let users = [];
async function loadUsers() {
  users = await cachedDocs(key('users'), scopeQ('users'));
  const pend = users.filter(u => u.status === 'pending').length;
  $('#bStaff').hidden = !pend; $('#bStaff').textContent = pend;
  $('#levels').innerHTML = [...new Set(users.map(u => u.level).filter(Boolean))].map(l => `<option value="${esc(l)}">`).join('');
  return users;
}
const assignable = ORGADMIN ? ['staff', 'deptadmin', 'admin'] : ['staff', 'deptadmin'];
const canEdit = u => SUPER || (ROLE === 'admin' && u.role !== 'super') || (UNITADMIN && ['staff', 'deptadmin'].includes(u.role || 'staff'));
const unitsOf = u => [u.deptId, ...(u.units || [])].filter(Boolean);
function drawStaff() {
  const f = $('#staffFilter').value, q = $('#staffSearch').value.trim().toLowerCase();
  const order = { pending: 0, active: 1, disabled: 2 };
  const list = users.filter(u => (!f || u.status === f) && (!q || `${u.name} ${u.staffId} ${u.email} ${deptName(u.deptId)}`.toLowerCase().includes(q)))
    .sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || (a.name || '').localeCompare(b.name || ''));
  $('#staffBody').innerHTML = list.length ? list.map(u => `<tr>
    <td><strong>${esc(u.name)}</strong><div class="small muted">${esc(u.email)}${u.phone ? ' · ' + esc(u.phone) : ''}</div></td>
    <td>${esc(u.staffId)}</td><td>${esc(deptName(u.deptId) || u.deptName || '—')}<div class="small muted">${esc(u.designation)}</div></td>
    <td>${u.level ? esc(u.level) : '<span class="muted">not set</span>'}</td>
    <td>${u.role && u.role !== 'staff' ? `<span class="pill admin">${esc(ROLE_LABEL[u.role] || u.role)}</span>${u.role === 'deptadmin' && (u.units || []).length ? `<div class="small muted">+ ${esc(u.units.map(deptName).filter(Boolean).join(', '))}</div>` : ''}` : 'Staff'}</td>
    <td>${pill(u.status)}</td>
    <td>${u.alTaken || 0}/${u.alEntitlement ?? self.DEFAULT_AL_DAYS ?? 30}</td>
    <td>${(u.fcmTokens || []).length ? '✓' : '<span class="muted">—</span>'}</td>
    <td><div class="actions">${!canEdit(u) ? '' : u.status === 'pending' ? `<button class="btn ok sm" data-edit="${u.id}" data-approve="1">Approve…</button>` : `<button class="btn ghost sm" data-edit="${u.id}">Edit</button>`}</div></td></tr>`).join('')
    : `<tr><td colspan="9" class="empty">No staff yet. Share the company code from Settings → Invite staff.</td></tr>`;
  $$('[data-edit]').forEach(b => b.onclick = () => openStaff(b.dataset.edit, !!b.dataset.approve));
}
let editing = null;
function drawUnitsPick() {
  const show = ORGADMIN && $('#fRole').value === 'deptadmin';
  $('#fUnitsWrap').hidden = !show;
  if (!show) return;
  const own = $('#fDept').value, have = new Set(editing.units || []);
  $('#fUnits').innerHTML = S.depts.filter(d => d.id !== own).map(d => `<label class="check" style="margin:0 10px 0 0"><input type="checkbox" value="${d.id}" ${have.has(d.id) ? 'checked' : ''}> ${esc(d.name)}</label>`).join('') || '<span class="muted small">No other units.</span>';
}
function openStaff(id, approve) {
  const u = users.find(x => x.id === id); editing = u;
  $('#dlgTitle').textContent = approve ? `Approve ${u.name}` : `Edit ${u.name}`;
  const set = (k, v) => $('#' + k).value = v ?? '';
  $('#fDept').innerHTML = (UNITADMIN ? S.depts.filter(d => MY_UNITS.includes(d.id)) : S.depts).map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  $('#fRole').innerHTML = assignable.map(r => `<option value="${r}">${ROLE_LABEL[r]}</option>`).join('');
  set('fName', u.name); set('fStaffId', u.staffId); set('fDept', u.deptId); set('fDesig', u.designation); set('fLevel', u.level);
  set('fPhone', u.phone); set('fRole', u.role || 'staff'); set('fStatus', approve ? 'active' : u.status);
  set('fEnt', u.alEntitlement ?? self.DEFAULT_AL_DAYS ?? 30); set('fTaken', u.alTaken || 0);
  $('#fRoleHint').textContent = 'Unit admin: manages their unit(s) — staff, roster, rules, shifts and email lists. Company admin: manages the whole company.';
  $('#fEmail').textContent = `Email: ${u.email} · Registered ${fmtTs(u.createdAt)}`;
  drawUnitsPick();
  $('#staffDlg').showModal();
}
$('#fRole').onchange = drawUnitsPick; $('#fDept').onchange = drawUnitsPick;
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
  if (ORGADMIN) data.units = data.role === 'deptadmin' ? $$('#fUnits input:checked').map(c => c.value).filter(x => x !== deptId) : [];
  const b = $('#dlgSave'); busy(b, true, 'Saving…');
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', u.id), data);
    batch.set(doc(db, 'directory', u.id), { name: data.name, staffId: data.staffId, level: data.level, orgId: u.orgId, deptId, designation: data.designation, active: data.status === 'active' }, { merge: true });
    await batch.commit();
    await invalidate('dir:', 'users');
    $('#staffDlg').close(); toast(u.deptId !== deptId ? `Saved and moved to ${deptName(deptId)}.` : 'Saved.', 'ok');
    await freshly(loadUsers); drawStaff();
  } catch (err) { toast(err.code === 'permission-denied' ? 'You do not have permission to make that change.' : err.message, 'bad'); }
  busy(b, false);
};
$('#staffFilter').onchange = drawStaff; $('#staffSearch').oninput = drawStaff;
loaders.staff = async () => { await loadUsers(); drawStaff(); };

/* ============ REPORTS ============ */
let reports = [];
loaders.reports = async () => { reports = (await cachedDocs(key('reports'), scopeQ('reports'))).sort(byNewest); drawReports(); };
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
    await updateDoc(doc(db, 'reports', b.dataset.ack), { status: 'acknowledged', acknowledgedBy: profile.name || profile.email, acknowledgedAt: serverTimestamp() });
    freshly(loaders.reports);
  });
  $$('[data-resend]').forEach(b => b.onclick = async () => {
    busy(b, true, 'Sending…');
    try { await api('/api/notify', { event: 'report', id: b.dataset.resend }); toast('Sent.', 'ok'); freshly(loaders.reports); } catch (e) { toast(e.message, 'bad'); busy(b, false); }
  });
}
$('#repType').onchange = drawReports; $('#repMonth').onchange = drawReports; $('#repSearch').oninput = drawReports;

/* ============ LEAVE REQUESTS ============ */
let leaves = [];
const calCache = new Map();
async function getCal(y, deptId = S.deptId) {
  const id = calId(y, S.orgId, deptId);
  if (!calCache.has(id)) calCache.set(id, (await cachedDoc(doc(db, 'leaveCalendar', id)).catch(() => null)) || {});
  return calCache.get(id);
}
async function loadLeaves() {
  leaves = (await cachedDocs(key('leaves'), scopeQ('leaveRequests'))).sort(byNewest);
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
    batch.update(doc(db, 'leaveRequests', id), { status: decision, adminComment: comment.trim(), decidedBy: profile.name || profile.email, decidedAt: serverTimestamp() });
    const sign = decision === 'approved' ? 1 : decision === 'revoked' ? -1 : 0;
    if (sign) {
      batch.update(doc(db, 'users', l.uid), { alTaken: increment(sign * l.days) });
      const byYear = {};
      dateRange(l.fromDate, l.toDate).forEach(d => (byYear[d.slice(0, 4)] ||= {})[d] = increment(sign));
      Object.entries(byYear).forEach(([y, booked]) => batch.set(doc(db, 'leaveCalendar', calId(y, l.orgId, l.deptId)), { orgId: l.orgId, deptId: l.deptId, booked }, { merge: true }));
    }
    await batch.commit();
    calCache.clear(); await invalidate('leaveCalendar/', 'leave:', 'leaves:', 'users');
    await notifySoft({ event: 'leave_decision', id });
    toast(`Leave ${decision}.`, 'ok');
    await freshly(() => Promise.all([loadLeaves(), loadUsers()])); drawLeaves();
  } catch (e) { toast(e.message, 'bad'); busy(btn, false); }
}
$('#leaveFilter').onchange = drawLeaves;
loaders.leave = async () => { await loadLeaves(); drawLeaves(); };
function refreshBadges() { if (!S.orgId) return; loadLeaves().catch(() => {}); loadUsers().then(() => { if (current === 'staff') drawStaff(); }).catch(() => {}); }

/* ============ LEAVE CALENDAR (one unit) ============ */
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
  calCache.clear(); await invalidate('leaveCalendar/');
  toast(`Updated ${plural(days.length, 'day')}.`, 'ok'); drawCal();
}
$('#quotaForm').onsubmit = e => { e.preventDefault(); const n = Number($('#qN').value); writeQuota(() => n).catch(err => toast(err.message, 'bad')); };
$('#qClear').onclick = () => writeQuota(() => deleteField()).catch(err => toast(err.message, 'bad'));
$('#defForm').onsubmit = async e => {
  e.preventDefault(); const y = String(calView.getFullYear()), v = $('#defQ').value;
  await setDoc(doc(db, 'leaveCalendar', calId(y)), { orgId: S.orgId, deptId: S.deptId, defaultQuota: v === '' ? deleteField() : Number(v) }, { merge: true });
  calCache.clear(); await invalidate('leaveCalendar/'); toast('Default saved.', 'ok'); drawCal();
};
loaders.calendar = () => { $('#qFrom').value = $('#qTo').value = today(); drawCal(); showOnLeave(today()); };

/* ============ ROSTER (one unit) ============ */
loaders.roster = () => editor.load();

/* ============ SWAPS ============ */
let swaps = [];
loaders.swaps = async () => { swaps = (await cachedDocs(key('swaps'), scopeQ('swaps'))).sort(byNewest); drawSwaps(); };
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
    await updateDoc(doc(db, 'swaps', b.dataset.swc), { status: 'cancelled', updatedAt: serverTimestamp(), cancelledBy: profile.name || profile.email });
    freshly(loaders.swaps);
  });
}
$('#swFilter').onchange = drawSwaps;

/* ============ UNITS (company admin) ============ */
/** keeps the public company-code record (company name + unit list for registration) in step */
async function syncJoinCode() {
  if (!S.org?.code) return;
  await setDoc(doc(db, 'joinCodes', S.org.code), {
    orgId: S.orgId, orgName: S.org.name, active: S.org.active !== false,
    departments: S.depts.map(d => ({ id: d.id, name: d.name, active: d.active !== false }))
  });
}
async function refreshOrg() { await invalidate(`orgs`, `units:${S.orgId}`); await freshly(() => setOrg(S.orgId)); }
loaders.departments = async () => {
  const all = await cachedDocs(`users:${S.orgId}:all`, query(collection(db, 'users'), where('orgId', '==', S.orgId)));
  const count = {}; all.forEach(d => { count[d.deptId] = (count[d.deptId] || 0) + 1; });
  $('#deptBody').innerHTML = S.depts.length ? S.depts.map(d => `<tr><td><strong>${esc(d.name)}</strong></td><td>${count[d.id] || 0}</td>
    <td>${d.active === false ? pill('disabled') : pill('active')}</td>
    <td><div class="actions">
      <button class="btn ghost sm" data-dset="${d.id}">Settings</button>
      <button class="btn ghost sm" data-dren="${d.id}">Rename</button>
      <button class="btn ghost sm" data-dact="${d.id}">${d.active === false ? 'Activate' : 'Hide'}</button>
      ${count[d.id] ? '' : `<button class="btn ghost sm" data-ddel="${d.id}">Delete</button>`}
    </div></td></tr>`).join('') : '<tr><td colspan="4" class="empty">No units yet.</td></tr>';
  const after = async msg => { await refreshOrg(); await syncJoinCode(); toast(msg, 'ok'); loaders.departments(); };
  $$('[data-dset]').forEach(b => b.onclick = async () => { await changeScope({ deptId: b.dataset.dset }); showTab('settings'); });
  $$('[data-dren]').forEach(b => b.onclick = async () => {
    const d = S.depts.find(x => x.id === b.dataset.dren); const name = prompt('New name for ' + d.name, d.name);
    if (!name?.trim() || name.trim() === d.name) return;
    try { await updateDoc(doc(db, 'departments', d.id), { name: name.trim() }); await after('Renamed.'); } catch (e) { toast(e.message, 'bad'); }
  });
  $$('[data-dact]').forEach(b => b.onclick = async () => {
    const d = S.depts.find(x => x.id === b.dataset.dact);
    try { await updateDoc(doc(db, 'departments', d.id), { active: d.active === false }); await after(d.active === false ? 'Unit active again.' : 'Hidden from the registration page.'); } catch (e) { toast(e.message, 'bad'); }
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
  if (S.depts.some(d => d.name.toLowerCase() === name.toLowerCase())) return toast('That unit already exists.', 'bad');
  try {
    await addDoc(collection(db, 'departments'), { orgId: S.orgId, name, active: true, createdAt: serverTimestamp() });
    $('#newDept').value = ''; await refreshOrg(); await syncJoinCode(); toast(`${name} added.`, 'ok'); loaders.departments();
  } catch (err) { toast(err.message, 'bad'); }
};

/* ============ SETTINGS ============ */
const LISTS = ['slEmails', 'frlEmails', 'leaveEmails', 'swapEmails'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
$('#oWeekend').innerHTML = DAYS.map((d, i) => `<label class="check" style="margin:0 8px 0 0"><input type="checkbox" value="${i}"> ${d}</label>`).join('');
let orgShiftEd = null, unitShiftEd = null, unitSettings = {};
loaders.settings = async () => {
  $('#meEmail').textContent = profile.email;
  const code = S.org?.code || '';
  $('#inviteCode').textContent = code || '—';
  $('#inviteLink').value = code ? `${location.origin}/register.html?code=${encodeURIComponent(code)}` : '';
  $('#aiStatus').innerHTML = S.org?.aiEnabled
    ? `⚡ Auto-roster is always available in Duty roster (free, built in). ✨ The optional AI assistant (Google Gemini free tier) is <strong>on</strong> for this company, up to ${S.org.aiDailyLimit || 20} requests a day.`
    : '⚡ Auto-roster is always available in Duty roster (free, built in). <span class="muted">The optional AI assistant is off for this company.</span>';
  if (ORGADMIN && S.org) {
    const o = S.org;
    $('#oName').value = o.name || ''; $('#oShort').value = o.shortName || ''; $('#oEmail').value = o.contactEmail || ''; $('#oPhone').value = o.contactPhone || '';
    $('#oAddr').value = o.address || ''; $('#oCode').value = o.code || ''; $('#oAL').value = o.defaultAL ?? 30;
    const we = o.weekendDays || [5, 6]; $$('#oWeekend input').forEach(c => c.checked = we.includes(Number(c.value)));
    const st = (await cachedDoc(doc(db, 'orgSettings', S.orgId))) || {};
    LISTS.forEach(k => $('#o_' + k).value = (st[k] || []).join('\n'));
    $('#emailAdmins').checked = st.emailAdmins !== false; $('#pushAdmins').checked = st.pushAdmins !== false;
  }
  $('#unitSettings').hidden = !S.deptId; $('#deptSetPick').hidden = !!S.deptId;
  if (S.deptId) {
    unitSettings = (await cachedDoc(doc(db, 'deptSettings', S.deptId))) || {};
    LISTS.forEach(k => $('#d_' + k).value = (unitSettings[k] || []).join('\n'));
  }
};

/* ---- shifts, timings & roster rules window (opens from Settings and from Duty roster) ---- */
const opt = (v, label) => `<option value="${v}">${label}</option>`;
const NO = opt('', 'No rule');
$('#ruMaxConsec').innerHTML = NO + Array.from({ length: 14 }, (_, i) => opt(i + 1, `${i + 1} day${i ? 's' : ''}`)).join('');
$('#ruMinRest').innerHTML = NO + Array.from({ length: 25 }, (_, i) => opt(i, `${i} hours`)).join('');
$('#ruMaxWeek').innerHTML = NO + [24, 30, 35, 36, 38, 40, 42, 44, 45, 48, 50, 52, 54, 56, 60, 66, 72, 84].map(h => opt(h, `${h} hours`)).join('');
$('#ruMinOff').innerHTML = NO + [1, 2, 3, 4].map(d => opt(d, `${d} day${d > 1 ? 's' : ''}`)).join('');
async function openShiftRules() {
  if (!S.orgId) return toast('Choose a company first.', 'bad');
  $('#srOrg').hidden = !ORGADMIN;
  if (ORGADMIN) orgShiftEd = shiftEditor($('#orgShifts'), S.org?.shifts?.length ? S.org.shifts : DEFAULT_SHIFTS);
  const hasUnit = !!S.deptId;
  $('#srNoUnit').hidden = hasUnit; $('#srUnit').hidden = !hasUnit; $('#rulesForm').hidden = !hasUnit;
  if (hasUnit) {
    unitSettings = (await cachedDoc(doc(db, 'deptSettings', S.deptId), { fresh: true }).catch(() => null)) || {};
    unitShiftEd = shiftEditor($('#unitShifts'), unitSettings.shifts || []);
    drawRules();
  }
  $$('.deptNameTxt').forEach(x => x.textContent = deptName(S.deptId) || '—');
  if (!$('#srDlg').open) $('#srDlg').showModal();
}
$('#openShiftRules').onclick = openShiftRules;
$('#srClose').onclick = () => $('#srDlg').close();
/** the roster editor picks up new shifts / rules straight away */
function rosterNeedsReload() { loaded.delete('roster'); if (current === 'roster' && S.deptId) editor.load(); }
function drawRules() {
  const r = unitSettings.rules || {};
  const setSel = (id, v) => { const el = $('#' + id); if (v != null && v !== '' && ![...el.options].some(o => o.value === String(v))) el.insertAdjacentHTML('beforeend', opt(v, v)); el.value = v ?? ''; };
  setSel('ruMaxConsec', r.maxConsecutive); setSel('ruMinRest', r.minRestHours); setSel('ruMaxWeek', r.maxWeeklyHours); setSel('ruMinOff', r.minDaysOffPerWeek);
  $('#ruNotes').value = r.notes || '';
  const shifts = Object.values(mergeShifts(S.org?.shifts?.length ? S.org.shifts : DEFAULT_SHIFTS, unitSettings.shifts || [])).filter(s => !s.off);
  $('#ruMinStaff').innerHTML = shifts.map(s => `<label class="min-item"><span class="code sc-${esc(s.color || 'sky')}">${esc(s.start ? s.start.replace(':', '') : s.code)}</span> ${esc(s.name)}
    <select data-min="${esc(s.code)}">${opt('', '—')}${Array.from({ length: 21 }, (_, i) => `<option value="${i}" ${String(r.minPerShift?.[s.code] ?? '') === String(i) ? 'selected' : ''}>${i}</option>`).join('')}</select></label>`).join('') || '<span class="muted small">No working shifts defined yet — add them above and save.</span>';
}
$('#copyLink').onclick = async () => { try { await navigator.clipboard.writeText($('#inviteLink').value); toast('Link copied.', 'ok'); } catch { $('#inviteLink').select(); } };
$('#orgForm').onsubmit = async e => {
  e.preventDefault(); const b = $('#orgSave'); busy(b, true, 'Saving…');
  try {
    const code = $('#oCode').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,16}$/.test(code)) throw new Error('Company code must be 4–16 letters or numbers.');
    const data = {
      name: $('#oName').value.trim(), shortName: $('#oShort').value.trim(), contactEmail: $('#oEmail').value.trim(), contactPhone: $('#oPhone').value.trim(),
      address: $('#oAddr').value.trim(), code, defaultAL: Number($('#oAL').value || 0),
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
    await refreshOrg(); await syncJoinCode();
    if (SUPER) await freshly(loadOrgs).then(() => $('#orgSel').value = S.orgId);
    toast('Company details saved.', 'ok'); loaders.settings();
  } catch (err) { toast(err.message, 'bad', 7000); }
  busy(b, false);
};
$('#orgShiftSave').onclick = async () => {
  const b = $('#orgShiftSave'); busy(b, true, 'Saving…');
  try {
    const shifts = orgShiftEd.get();
    await updateDoc(doc(db, 'orgs', S.orgId), { shifts, updatedAt: serverTimestamp() });
    await refreshOrg(); toast('Company shifts saved.', 'ok'); if (S.deptId) drawRules(); rosterNeedsReload();
  } catch (err) { toast(err.message, 'bad', 7000); }
  busy(b, false);
};
$('#orgMailForm').onsubmit = async e => {
  e.preventDefault(); const b = $('#orgMailSave'); busy(b, true, 'Saving…');
  try {
    const data = { emailAdmins: $('#emailAdmins').checked, pushAdmins: $('#pushAdmins').checked, updatedAt: serverTimestamp() };
    LISTS.forEach(k => { data[k] = linesToEmails($('#o_' + k).value); $('#o_' + k).value = data[k].join('\n'); });
    await setDoc(doc(db, 'orgSettings', S.orgId), data, { merge: true });
    await invalidate(`orgSettings/${S.orgId}`); toast('Company email lists saved.', 'ok');
  } catch (err) { toast(err.message, 'bad'); }
  busy(b, false);
};
async function saveUnit(patch, msg) {
  await setDoc(doc(db, 'deptSettings', S.deptId), { orgId: S.orgId, ...patch, updatedAt: serverTimestamp() }, { merge: true });
  await invalidate(`deptSettings/${S.deptId}`);
  unitSettings = { ...unitSettings, ...patch };
  toast(msg, 'ok');
}
$('#deptSetForm').onsubmit = async e => {
  e.preventDefault(); const b = $('#deptSetSave'); busy(b, true, 'Saving…');
  try {
    const data = {};
    LISTS.forEach(k => { data[k] = linesToEmails($('#d_' + k).value); $('#d_' + k).value = data[k].join('\n'); });
    await saveUnit(data, `${deptName(S.deptId)} email lists saved.`);
  } catch (err) { toast(err.message, 'bad'); }
  busy(b, false);
};
$('#unitShiftSave').onclick = async () => {
  const b = $('#unitShiftSave'); busy(b, true, 'Saving…');
  try { await saveUnit({ shifts: unitShiftEd.get() }, `${deptName(S.deptId)} shifts saved.`); drawRules(); rosterNeedsReload(); }
  catch (err) { toast(err.message, 'bad', 7000); }
  busy(b, false);
};
$('#rulesForm').onsubmit = async e => {
  e.preventDefault(); const b = $('#rulesSave'); busy(b, true, 'Saving…');
  try {
    const n = id => { const v = $('#' + id).value; return v === '' ? null : Number(v); };
    const minPerShift = {}; $$('#ruMinStaff [data-min]').forEach(i => { if (i.value !== '') minPerShift[i.dataset.min] = Number(i.value); });
    const rules = { maxConsecutive: n('ruMaxConsec'), minRestHours: n('ruMinRest'), maxWeeklyHours: n('ruMaxWeek'), minDaysOffPerWeek: n('ruMinOff'), minPerShift, notes: $('#ruNotes').value.trim() };
    await saveUnit({ rules }, `${deptName(S.deptId)} roster rules saved.`); rosterNeedsReload();
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
$('#clearCacheBtn').onclick = async () => {
  if (!confirm('Delete the copy of portal data saved on this device? It will be downloaded again from Firebase. Roster drafts are kept.')) return;
  await clearDeviceData(); toast('Device data cleared. Reloading from Firebase…', 'ok'); setTimeout(() => location.reload(), 800);
};

/* ============ COMPANIES (App admin) ============ */
loaders.companies = async () => {
  await loadOrgs();
  $('#orgBody').innerHTML = orgs.length ? orgs.map(o => `<tr><td><strong>${esc(o.name)}</strong><div class="small muted">${esc(o.contactEmail || '')}</div></td>
    <td><code>${esc(o.code || '')}</code></td><td>${o.active === false ? pill('disabled') : pill('active')}</td>
    <td><label class="check" style="margin:0"><input type="checkbox" data-orgai="${o.id}" ${o.aiEnabled ? 'checked' : ''}> On</label>
      <div class="small muted">limit <input type="number" min="1" max="1000" data-ailim="${o.id}" value="${o.aiDailyLimit || 20}" style="width:64px;padding:2px 6px"> / day</div></td>
    <td><div class="actions"><button class="btn ghost sm" data-open="${o.id}">Open</button>
      <button class="btn ghost sm" data-oact="${o.id}">${o.active === false ? 'Activate' : 'Deactivate'}</button></div></td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No companies yet. Add the first one →</td></tr>';
  const afterOrg = async id => { await invalidate('orgs'); if (id === S.orgId) await freshly(() => setOrg(id)); await freshly(loaders.companies); };
  $$('[data-open]').forEach(b => b.onclick = async () => { $('#orgSel').value = b.dataset.open; await changeScope({ orgId: b.dataset.open }); showTab('staff'); });
  $$('[data-orgai]').forEach(c => c.onchange = async () => { await updateDoc(doc(db, 'orgs', c.dataset.orgai), { aiEnabled: c.checked }); toast(`AI assistant ${c.checked ? 'switched on' : 'switched off'}.`, 'ok'); afterOrg(c.dataset.orgai); });
  $$('[data-ailim]').forEach(i => i.onchange = async () => { await updateDoc(doc(db, 'orgs', i.dataset.ailim), { aiDailyLimit: Math.max(1, Number(i.value) || 20) }); toast('AI daily limit saved.', 'ok'); afterOrg(i.dataset.ailim); });
  $$('[data-oact]').forEach(b => b.onclick = async () => {
    const o = orgs.find(x => x.id === b.dataset.oact); const active = o.active === false;
    if (!active && !confirm(`Deactivate ${o.name}? Its staff can no longer use the portal or register.`)) return;
    const batch = writeBatch(db);
    batch.update(doc(db, 'orgs', o.id), { active });
    if (o.code) batch.set(doc(db, 'joinCodes', o.code), { active }, { merge: true });
    await batch.commit(); toast(active ? 'Company activated.' : 'Company deactivated.', 'ok');
    afterOrg(o.id);
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
    batch.set(orgRef, { name, code, active: true, weekendDays: [5, 6], defaultAL: self.DEFAULT_AL_DAYS ?? 30, shifts: DEFAULT_SHIFTS, aiEnabled: $('#nAi').checked, aiDailyLimit: 20, createdAt: serverTimestamp() });
    batch.set(doc(db, 'orgSettings', orgRef.id), { emailAdmins: true, pushAdmins: true, slEmails: [], frlEmails: [], leaveEmails: [], swapEmails: [] });
    const depts = deptNames.map(n => { const r = doc(collection(db, 'departments')); batch.set(r, { orgId: orgRef.id, name: n, active: true, createdAt: serverTimestamp() }); return { id: r.id, name: n, active: true }; });
    batch.set(doc(db, 'joinCodes', code), { orgId: orgRef.id, orgName: name, active: true, departments: depts });
    await batch.commit();
    e.target.reset(); $('#nDepts').value = 'General'; delete $('#nCode').dataset.touched;
    toast(`${name} created. Company code: ${code}`, 'ok', 8000);
    await invalidate('orgs'); await freshly(loaders.companies); $('#orgSel').value = orgRef.id; await changeScope({ orgId: orgRef.id }); showTab('settings');
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
