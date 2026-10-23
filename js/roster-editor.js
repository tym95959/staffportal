// Roster editor for the admin page + shared helpers for shift timings and roster rules.
import {
  db, $, $$, esc, fmtShort, fmtTs, plural, ym, daysInMonth, isWeekend, toast, busy, api, rosterId, idb,
  shiftClass, shiftSpan, cellText, isCustomTime, mergeShifts, shiftLegend, SHIFT_PALETTE, OFF_CODES,
  cachedDoc, cachedDocs, invalidate, collection, doc, query, where, setDoc, serverTimestamp
} from '/js/app.js';

/* ======================================================================
   Shift definitions
   ====================================================================== */
export const DEFAULT_SHIFTS = [
  { code: 'M', name: 'Morning', start: '06:00', end: '14:00', color: 'amber' },
  { code: 'E', name: 'Evening', start: '14:00', end: '22:00', color: 'violet' },
  { code: 'N', name: 'Night', start: '22:00', end: '06:00', color: 'indigo' },
  { code: 'OFF', name: 'Day off', off: true, color: 'grey' },
  { code: 'AL', name: 'Annual leave', off: true, color: 'green' },
  { code: 'SL', name: 'Sick leave', off: true, color: 'rose' },
  { code: 'PH', name: 'Public holiday', off: true, color: 'teal' }
];
/** what a shift looks like in the roster: its start time (0830) or, for day off / leave, its code */
/** shifts in time order (earliest start first), day-off / leave codes last */
export const byTime = shifts => Object.values(shifts).sort((a, b) => (!!a.off - !!b.off) || String(a.start || '').localeCompare(String(b.start || '')) || a.code.localeCompare(b.code));
export const lbl = s => (!s.off && s.start ? s.start.replace(':', '') : s.code);
const hrs = s => { const sp = shiftSpan(s.code || 'X', { [s.code || 'X']: s }); return sp ? Math.round(sp.hours * 100) / 100 : ''; };

/* Times every 15 minutes for the dropdowns: 00:00, 00:15 … 23:45 */
export const TIMES = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);
export const timeOptions = sel => (sel && !TIMES.includes(sel) ? `<option value="${esc(sel)}" selected>${esc(sel)}</option>` : '')
  + TIMES.map(t => `<option value="${t}" ${t === sel ? 'selected' : ''}>${t}</option>`).join('');

/** Editable table of shifts (code, name, start, end, colour, day-off). Returns { get() } */
export function shiftEditor(el, list) {
  let rows = (list || []).map(s => ({ ...s }));
  const rowHtml = (s, i) => `<tr data-i="${i}">
      <td data-l="Code"><input data-k="code" value="${esc(s.code || '')}" maxlength="6" style="width:76px;text-transform:uppercase" placeholder="M"></td>
      <td data-l="Name"><input data-k="name" value="${esc(s.name || '')}" placeholder="Morning" style="min-width:120px"></td>
      <td data-l="Start">${s.off ? '<span class="muted small">—</span>' : `<select data-k="start" class="time-sel">${timeOptions(s.start || '09:00')}</select>`}</td>
      <td data-l="End">${s.off ? '<span class="muted small">—</span>' : `<select data-k="end" class="time-sel">${timeOptions(s.end || '17:00')}</select>`}</td>
      <td class="small hrs" data-l="Hours">${s.off ? '—' : hrs(s) || '—'}</td>
      <td data-l="Colour"><div class="actions" style="flex-wrap:nowrap"><select data-k="color" style="width:auto">${SHIFT_PALETTE.map(c => `<option value="${c}" ${s.color === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
        <span class="code sc-${esc(s.color || 'sky')}">${esc(s.code || '?')}</span></div></td>
      <td data-l="Day off / leave" style="text-align:center"><input type="checkbox" data-k="off" ${s.off ? 'checked' : ''} aria-label="Day off / leave"></td>
      <td class="del"><button type="button" class="btn ghost sm" data-del="${i}" aria-label="Remove">×</button></td></tr>`;
  const draw = () => {
    el.innerHTML = `<div class="table-wrap"><table class="shift-table"><thead><tr><th>Code</th><th>Name</th><th>Start</th><th>End</th><th>Hours</th><th>Colour</th><th>Day off / leave</th><th></th></tr></thead><tbody>
      ${rows.map(rowHtml).join('')}
      ${rows.length ? '' : '<tr><td colspan="8" class="empty">No shifts yet.</td></tr>'}
      </tbody></table></div>
      <div class="actions" style="margin-top:8px"><button type="button" class="btn ghost sm" data-add>+ Add shift</button>
      ${rows.length ? '' : '<button type="button" class="btn ghost sm" data-defaults>Use standard shifts (M, E, N, OFF, AL, SL, PH)</button>'}</div>`;
    // typing or choosing updates the row in place, so the next tap is never lost
    $$('[data-k]', el).forEach(inp => {
      const ev = inp.tagName === 'SELECT' || inp.type === 'checkbox' ? 'change' : 'input';
      inp.addEventListener(ev, () => {
        const tr = inp.closest('tr'), i = +tr.dataset.i, k = inp.dataset.k, r = rows[i];
        const oldAuto = (r.start || '').replace(':', '');
        r[k] = inp.type === 'checkbox' ? inp.checked : k === 'code' ? inp.value.trim().toUpperCase() : inp.value;
        if (k === 'off') { if (r.off) { delete r.start; delete r.end; } else { r.start ||= '09:00'; r.end ||= '17:00'; } draw(); return; }
        if (k === 'start' || k === 'end') {
          r.start = $('[data-k="start"]', tr)?.value; r.end = $('[data-k="end"]', tr)?.value;
          // a code that was just the start time follows the new start time
          if (k === 'start' && (!r.code || r.code === oldAuto)) { r.code = r.start.replace(':', ''); $('[data-k="code"]', tr).value = r.code; }
        }
        const badge = $('.code', tr); badge.textContent = r.code || '?'; badge.className = `code sc-${r.color || 'sky'}`;
        $('.hrs', tr).textContent = r.off ? '—' : hrs(r) || '—';
      });
    });
    $$('[data-del]', el).forEach(b => b.onclick = () => { rows.splice(+b.dataset.del, 1); draw(); });
    $('[data-add]', el).onclick = () => { rows.push({ code: '0900', name: '', start: '09:00', end: '17:00', color: SHIFT_PALETTE[rows.length % SHIFT_PALETTE.length] }); draw(); $$('tr[data-i] input[data-k="code"]', el).at(-1)?.focus(); };
    const d = $('[data-defaults]', el); if (d) d.onclick = () => { rows = DEFAULT_SHIFTS.map(s => ({ ...s })); draw(); };
  };
  draw();
  return {
    get() {
      const out = [], seen = new Set();
      for (const s of rows) {
        const code = String(s.code || (!s.off && s.start ? s.start.replace(':', '') : '')).trim().toUpperCase();
        if (!code) continue;
        if (!/^[A-Z0-9]{1,6}$/.test(code)) throw new Error(`Shift code "${code}" — use 1–6 letters or numbers.`);
        if (seen.has(code)) throw new Error(`Shift code ${code} is used twice. Two shifts starting at the same time need different codes, e.g. ${code} and ${code}L.`);
        if (!s.off && (!s.start || !s.end)) throw new Error(`Shift ${code} needs a start and end time (or tick "Day off").`);
        if (!s.off && s.start === s.end) throw new Error(`Shift ${code} starts and ends at the same time.`);
        seen.add(code);
        out.push(s.off ? { code, name: s.name || code, off: true, color: s.color || 'grey' } : { code, name: s.name || `${s.start}–${s.end}`, start: s.start, end: s.end, color: s.color || 'sky' });
      }
      return out;
    }
  };
}

/* ======================================================================
   Rule check
   rules = { maxConsecutive, minRestHours, maxWeeklyHours, minDaysOffPerWeek, minPerShift: {CODE: n}, notes }
   ====================================================================== */
export function validateRoster({ month, days, order, rows, names, shifts, rules = {}, leave = {} }) {
  const flags = new Map(), warnings = [], totals = {};
  const num = v => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
  const maxConsec = num(rules.maxConsecutive), minRest = num(rules.minRestHours), maxWeek = num(rules.maxWeeklyHours), minOff = num(rules.minDaysOffPerWeek);
  const flag = (uid, i, msg) => { const k = `${uid}|${i}`; flags.set(k, flags.has(k) ? `${flags.get(k)}\n${msg}` : msg); };
  const dateOf = i => `${month}-${String(i + 1).padStart(2, '0')}`;
  const r1 = n => Math.round(n * 10) / 10;
  for (const uid of order) {
    const row = rows[uid] || [], nm = names[uid]?.name || 'Someone';
    const spans = Array.from({ length: days }, (_, i) => shiftSpan(row[i], shifts));
    let hours = 0, count = 0; spans.forEach(s => { if (s) { hours += s.hours; count++; } });
    totals[uid] = { hours: r1(hours), count };
    for (const i of leave[uid] || []) if (spans[i]) { flag(uid, i, 'Working on a day of approved leave'); warnings.push({ uid, kind: 'leave', msg: `${nm} is rostered on ${fmtShort(dateOf(i))} but has approved leave` }); }
    if (maxConsec) {
      let run = 0;
      for (let i = 0; i < days; i++) {
        if (spans[i]) { run++; if (run > maxConsec) { flag(uid, i, `${run} working days in a row (max ${maxConsec})`); if (run === maxConsec + 1) warnings.push({ uid, kind: 'consec', msg: `${nm} works more than ${maxConsec} days in a row (from ${fmtShort(dateOf(i - maxConsec))})` }); } }
        else run = 0;
      }
    }
    if (minRest != null) {
      for (let i = 1; i < days; i++) {
        const a = spans[i - 1], b = spans[i];
        if (a && b) { const rest = (b.start + 1440 - a.end) / 60; if (rest < minRest) { flag(uid, i, `Only ${r1(rest)} h rest after the previous shift (min ${minRest} h)`); warnings.push({ uid, kind: 'rest', msg: `${nm}: only ${r1(rest)} h rest before ${fmtShort(dateOf(i))} (min ${minRest} h)` }); } }
      }
    }
    if (maxWeek) {
      let worst = 0, at = -1;
      for (let i = 0; i + 7 <= days; i++) { let h = 0; for (let j = i; j < i + 7; j++) h += spans[j]?.hours || 0; if (h > worst) { worst = h; at = i; } }
      if (worst > maxWeek) { for (let j = at; j < at + 7; j++) if (spans[j]) flag(uid, j, `${r1(worst)} h in 7 days (max ${maxWeek})`); warnings.push({ uid, kind: 'hours', msg: `${nm}: ${r1(worst)} hours in the 7 days from ${fmtShort(dateOf(at))} (max ${maxWeek})` }); }
    }
    if (minOff) {
      for (let i = 0; i + 6 < days; i++) {
        if (new Date(dateOf(i) + 'T00:00').getDay() !== 1) continue; // weeks that start on Monday and end inside the month
        let off = 0; for (let j = i; j < i + 7; j++) if (!spans[j]) off++;
        if (off < minOff) { for (let j = i; j < i + 7; j++) if (spans[j]) flag(uid, j, `Only ${off} day(s) off this week (min ${minOff})`); warnings.push({ uid, kind: 'off', msg: `${nm}: only ${off} day(s) off in the week of ${fmtShort(dateOf(i))} (min ${minOff})` }); }
      }
    }
  }
  const coverage = {}, minPer = rules.minPerShift || {};
  Object.values(shifts).filter(s => !s.off).forEach(s => { coverage[s.code] = Array.from({ length: days }, (_, i) => order.filter(u => (rows[u] || [])[i] === s.code).length); });
  for (const [code, need] of Object.entries(minPer)) {
    const n = num(need); if (!n || !coverage[code]) continue;
    const short = coverage[code].map((c, i) => c < n ? i : -1).filter(i => i >= 0);
    if (short.length) warnings.push({ kind: 'coverage', msg: `${code} (${shifts[code]?.name || code}) has fewer than ${n} staff on ${plural(short.length, 'day')}: ${short.slice(0, 8).map(i => i + 1).join(', ')}${short.length > 8 ? '…' : ''}` });
  }
  return { flags, warnings, coverage, totals };
}

/* ======================================================================
   Auto-roster — built-in roster generator (no AI service, free, runs in the browser)
   Fills each day shift by shift up to the number of staff needed, choosing among the people who can
   legally work it (leave, rest hours, days in a row, weekly hours, days off per week) and preferring
   whoever has worked least / done that shift least / had fewer weekends, mixing levels. It tries many
   variations and keeps the one with the fewest rule problems and the fairest hours.
   ====================================================================== */
export function autoRoster({ month, days, order, rows, names, levels = {}, shifts, rules = {}, leave = {}, need, staff, onlyEmpty = true, fillOff = true, startDay = 0, runs = 60 }) {
  const num = v => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
  const maxConsec = num(rules.maxConsecutive), minRest = num(rules.minRestHours), maxWeek = num(rules.maxWeeklyHours), minOff = num(rules.minDaysOffPerWeek);
  const work = Object.values(shifts).filter(s => !s.off && shiftSpan(s.code, shifts));
  const offCode = shifts.OFF ? 'OFF' : (Object.values(shifts).find(s => s.off && !/leave|holiday/i.test(s.name || ''))?.code || 'OFF');
  const alCode = shifts.AL ? 'AL' : (Object.values(shifts).find(s => s.off && /leave/i.test(s.name || ''))?.code || 'AL');
  const pick = new Set(staff);
  const dateOf = i => `${month}-${String(i + 1).padStart(2, '0')}`;
  const weekend = Array.from({ length: days }, (_, i) => isWeekend(dateOf(i)));
  const dow = Array.from({ length: days }, (_, i) => new Date(dateOf(i) + 'T00:00').getDay());
  // shifts that are hardest to place first: late starts (nights) before early ones
  const order2 = [...work].sort((a, b) => shiftSpan(b.code, shifts).start - shiftSpan(a.code, shifts).start);
  const sp = c => shiftSpan(c, shifts);

  function oneRun(jitter) {
    const R = {}, fixed = {};
    for (const u of order) {
      R[u] = [...(rows[u] || Array(days).fill(''))];
      fixed[u] = R[u].map((v, i) => !pick.has(u) || i < startDay || (onlyEmpty && !!v));
      if (pick.has(u)) for (let i = startDay; i < days; i++) {
        if (!fixed[u][i]) R[u][i] = '';
        if (leave[u]?.has(i) && !R[u][i]) { R[u][i] = alCode; fixed[u][i] = true; }
      }
    }
    const hours = {}, cnt = {}, wk = {};
    for (const u of order) { hours[u] = 0; cnt[u] = {}; wk[u] = 0; R[u].forEach((v, i) => { const x = sp(v); if (x) { hours[u] += x.hours; cnt[u][v] = (cnt[u][v] || 0) + 1; if (weekend[i]) wk[u]++; } }); }
    const shortages = [];
    const ok = (u, i, code) => {
      const x = sp(code), row = R[u];
      if (maxConsec) { let run = 1; for (let j = i - 1; j >= 0 && sp(row[j]); j--) run++; for (let j = i + 1; j < days && sp(row[j]); j++) run++; if (run > maxConsec) return false; }
      if (minRest != null) {
        const p = i > 0 ? sp(row[i - 1]) : null; if (p && (x.start + 1440 - p.end) / 60 < minRest) return false;
        const n = i < days - 1 ? sp(row[i + 1]) : null; if (n && (n.start + 1440 - x.end) / 60 < minRest) return false;
      }
      if (maxWeek) for (let a = Math.max(0, i - 6); a <= Math.min(i, days - 7); a++) { let h = x.hours; for (let j = a; j < a + 7; j++) if (j !== i) h += sp(row[j])?.hours || 0; if (h > maxWeek) return false; }
      if (minOff) {
        let ws = i; while (ws > 0 && dow[ws] !== 1) ws--;
        if (dow[ws] === 1 && ws + 6 < days) { let possibleOff = 0; for (let j = ws; j < ws + 7; j++) if (j !== i && !sp(row[j])) possibleOff++; if (possibleOff < minOff) return false; }
      }
      return true;
    };
    for (let i = startDay; i < days; i++) {
      const placed = {};
      for (const s of order2) placed[s.code] = order.filter(u => R[u][i] === s.code).map(u => levels[u]);
      for (const s of order2) {
        const want = Number(need[s.code]?.[weekend[i] ? 'we' : 'wd']) || 0;
        let missing = want - placed[s.code].length;
        while (missing > 0) {
          let best = null, bestScore = Infinity;
          for (const u of order) {
            if (!pick.has(u) || fixed[u][i] || R[u][i]) continue;
            if (!ok(u, i, s.code)) continue;
            const prev = R[u][i - 1];
            let score = hours[u] / 8 + (cnt[u][s.code] || 0) * 1.5 + (weekend[i] ? wk[u] * 1.2 : 0)
              + (prev === s.code ? -1 : sp(prev) ? 0.6 : 0)
              + (placed[s.code].includes(levels[u]) ? 1.5 : 0)
              + Math.random() * jitter;
            if (score < bestScore) { bestScore = score; best = u; }
          }
          if (!best) { shortages.push({ i, code: s.code, missing }); break; }
          R[best][i] = s.code; placed[s.code].push(levels[best]);
          hours[best] += sp(s.code).hours; cnt[best][s.code] = (cnt[best][s.code] || 0) + 1; if (weekend[i]) wk[best]++;
          missing--;
        }
      }
      if (fillOff) for (const u of order) if (pick.has(u) && !fixed[u][i] && !R[u][i]) R[u][i] = offCode;
    }
    return { R, shortages, hours };
  }
  let best = null;
  for (let r = 0; r < runs; r++) {
    const res = oneRun(r === 0 ? 0 : 2.5);
    const v = validateRoster({ month, days, order, rows: res.R, names, shifts, rules: { ...rules, minPerShift: {} }, leave: Object.fromEntries(Object.entries(leave).map(([u, st]) => [u, [...st]])) });
    const hs = staff.map(u => res.hours[u]); const avg = hs.reduce((a, b) => a + b, 0) / (hs.length || 1);
    const spread = Math.sqrt(hs.reduce((a, b) => a + (b - avg) ** 2, 0) / (hs.length || 1));
    const missing = res.shortages.reduce((a, x) => a + x.missing, 0);
    const cost = v.warnings.length * 10 + missing * 25 + spread;
    if (!best || cost < best.cost) best = { ...res, cost, spread, warnings: v.warnings.length };
  }
  return best;
}

/* ======================================================================
   The editor
   ctx = { S, profile, deptName(id), notifySoft(body) }
   ====================================================================== */
export function initRosterEditor(ctx) {
  const { S, profile } = ctx;
  let E = null;            // current roster being edited
  let brush = null;        // null = pick from list, '' = eraser, 'CUSTOM' = custom time, otherwise a shift code
  let painting = false, autosaveT = null;
  const undoStack = [];
  const snapshot = () => JSON.stringify(E.rows);
  const pushUndo = () => { undoStack.push(snapshot()); if (undoStack.length > 60) undoStack.shift(); $('#rUndo').disabled = false; };
  const draftKey = () => `${profile.id}|${E.id}`;
  const dateOf = i => `${E.month}-${String(i + 1).padStart(2, '0')}`;
  const pubVal = (uid, i) => E.published?.rows?.[uid]?.[i] || '';
  const changedCount = () => E ? E.order.reduce((a, uid) => a + E.rows[uid].filter((v, i) => v !== pubVal(uid, i)).length, 0) : 0;
  const isDirty = () => changedCount() > 0;

  $('#rMonth').value = ym(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1));
  const goMonth = n => { if (isDirty()) saveDraft(true); const [y, m] = $('#rMonth').value.split('-').map(Number); $('#rMonth').value = ym(new Date(y, m - 1 + n, 1)); load(); };
  $('#rPrev').onclick = () => goMonth(-1); $('#rNext').onclick = () => goMonth(1);
  $('#rMonth').onchange = () => { load(); };

  /* ---------- loading ---------- */
  async function load({ fresh = false, ignoreDraft = false } = {}) {
    const month = $('#rMonth').value; if (!month || !S.deptId) return;
    $('#rStatus').textContent = 'Loading…';
    const id = rosterId(month, S.orgId, S.deptId);
    const opt = { fresh };
    const [dir, pub, dset, leaves] = await Promise.all([
      cachedDocs(`dir:${S.orgId}:${S.deptId}`, query(collection(db, 'directory'), where('orgId', '==', S.orgId), where('deptId', '==', S.deptId), where('active', '==', true)), opt),
      cachedDoc(doc(db, 'rosters', id), opt),
      cachedDoc(doc(db, 'deptSettings', S.deptId), opt),
      cachedDocs(`leave:${S.orgId}:${S.deptId}`, query(collection(db, 'leaveRequests'), where('orgId', '==', S.orgId), where('deptId', '==', S.deptId)), opt)
    ]);
    const days = daysInMonth(month);
    const staff = dir.sort((a, b) => (a.level || '').localeCompare(b.level || '') || (a.name || '').localeCompare(b.name || ''));
    const names = { ...(pub?.names || {}) };
    staff.forEach(d => names[d.id] = { name: d.name, staffId: d.staffId || '', level: d.level || '' });
    const order = [...(pub?.order || [])];
    staff.forEach(d => { if (!order.includes(d.id)) order.push(d.id); });
    const rows = {};
    order.forEach(uid => rows[uid] = Array.from({ length: days }, (_, i) => pub?.rows?.[uid]?.[i] || ''));
    // approved (and pending) leave inside this month
    const leave = {}, pending = {};
    for (const l of leaves) {
      if (!['approved', 'pending'].includes(l.status) || l.toDate < `${month}-01` || l.fromDate > `${month}-${days}`) continue;
      const target = l.status === 'approved' ? leave : pending;
      for (let i = 0; i < days; i++) { const d = `${month}-${String(i + 1).padStart(2, '0')}`; if (d >= l.fromDate && d <= l.toDate) (target[l.uid] ||= new Set()).add(i); }
    }
    E = {
      id, month, days, order, names, rows, published: pub, leave, pending,
      shifts: mergeShifts(S.org?.shifts?.length ? S.org.shifts : DEFAULT_SHIFTS, dset?.shifts || []),
      rules: dset?.rules || {}, activeIds: new Set(staff.map(s => s.id))
    };
    undoStack.length = 0; $('#rUndo').disabled = true;
    // a draft kept on this device?
    const draft = ignoreDraft ? null : await idb.get('drafts', draftKey());
    $('#rDraftBanner').hidden = true;
    if (draft && draft.rows) {
      const differs = order.some(uid => (draft.rows[uid] || []).some((v, i) => (v || '') !== rows[uid][i]));
      if (differs) {
        order.forEach(uid => { if (draft.rows[uid]) rows[uid] = Array.from({ length: days }, (_, i) => draft.rows[uid][i] || ''); });
        const newer = pub?.updatedAt && (pub.updatedAt.seconds * 1000) > draft.savedAt;
        $('#rDraftBanner').innerHTML = `<span>Showing your <strong>draft saved on this device</strong> (${new Date(draft.savedAt).toLocaleString()}).${newer ? ' <strong>Note:</strong> the published roster was changed after this draft.' : ''}</span>
          <span class="actions"><button type="button" class="btn ghost sm" id="rUsePub">Show published version</button></span>`;
        $('#rDraftBanner').hidden = false;
        $('#rUsePub').onclick = async () => { if (!confirm('Discard the device draft and show the published roster?')) return; await idb.del('drafts', draftKey()); load({ ignoreDraft: true }); };
      } else await idb.del('drafts', draftKey());
    }
    $('#rMsg').textContent = staff.length ? '' : 'No active staff in this unit yet.';
    drawPalette(); render();
  }

  /* ---------- palette ---------- */
  function drawPalette() {
    const sh = byTime(E.shifts);
    const t = s => s.off ? s.name : `${s.start}–${s.end}`;
    $('#palette').innerHTML = `<button type="button" class="chip-btn ${brush === null ? 'on' : ''}" data-brush="__pick">☝ Pick</button>`
      + sh.map(s => `<button type="button" class="chip-btn sc-${esc(s.color || 'sky')} ${brush === s.code ? 'on' : ''}" data-brush="${esc(s.code)}" title="${esc(s.name)} ${esc(t(s))}"><strong>${esc(lbl(s))}</strong><small>${esc(s.off ? s.name : `to ${s.end}`)}</small></button>`).join('')
      + `<button type="button" class="chip-btn sc-sky ${brush === 'CUSTOM' ? 'on' : ''}" data-brush="CUSTOM"><strong>⏱</strong><small>Custom time</small></button>`
      + `<button type="button" class="chip-btn ${brush === '' ? 'on' : ''}" data-brush=""><strong>⌫</strong><small>Eraser</small></button>`;
    $$('#palette [data-brush]').forEach(b => b.onclick = () => { const v = b.dataset.brush; brush = v === '__pick' ? null : v; drawPalette(); $('#rGrid').classList.toggle('painting', brush !== null); });
    $('#customTime').hidden = brush !== 'CUSTOM';
    $('#rLegend').innerHTML = sh.map(s => `<span><span class="code sc-${esc(s.color || 'sky')}">${esc(lbl(s))}</span> ${esc(s.name)}${s.off ? '' : ` ${esc(s.start)}–${esc(s.end)}`}</span>`).join('');
  }
  $('#ctStart').innerHTML = timeOptions('09:00'); $('#ctEnd').innerHTML = timeOptions('17:00');
  const brushValue = () => brush === 'CUSTOM' ? `${$('#ctStart').value}-${$('#ctEnd').value}` : brush;

  /* ---------- grid ---------- */
  let V = null; // last validation
  function render() {
    V = validateRoster({ ...E, leave: Object.fromEntries(Object.entries(E.leave).map(([u, s]) => [u, [...s]])) });
    const { days, order, names, rows, shifts } = E;
    let h = '<thead><tr><th class="name">Staff</th>';
    for (let i = 0; i < days; i++) { const d = dateOf(i); h += `<th class="${isWeekend(d) ? 'we' : ''}">${new Date(d + 'T00:00').toLocaleDateString(undefined, { weekday: 'narrow' })}<span class="dn">${i + 1}</span></th>`; }
    h += '<th class="tot">Hours</th><th class="tot">Shifts</th></tr></thead><tbody>';
    for (const uid of order) {
      const n = names[uid] || {};
      const gone = !E.activeIds.has(uid);
      h += `<tr><td class="name">${esc(n.name || uid)}<div class="small muted">${esc(n.staffId || '')}${n.level ? ' · ' + esc(n.level) : ''}${gone ? ' · <span style="color:var(--bad)">not in unit</span>' : ''}</div></td>`;
      for (let i = 0; i < days; i++) h += cellHtml(uid, i);
      const tt = V.totals[uid] || {};
      h += `<td class="tot">${tt.hours || 0}</td><td class="tot">${tt.count || 0}</td></tr>`;
    }
    h += '</tbody><tfoot>';
    const minPer = E.rules.minPerShift || {};
    for (const [code, counts] of Object.entries(V.coverage)) {
      const need = Number(minPer[code]) || 0;
      h += `<tr class="cov"><td class="name"><span class="code ${shiftClass(code, shifts)}">${esc(cellText(code, shifts))}</span> on duty${need ? ` <span class="muted">(min ${need})</span>` : ''}</td>`
        + counts.map(c => `<td class="${need ? (c < need ? 'low' : 'okc') : ''}">${c || ''}</td>`).join('') + '<td class="tot"></td><td class="tot"></td></tr>';
    }
    $('#rGrid').innerHTML = h + '</tfoot>';
    $('#rGrid').classList.toggle('painting', brush !== null);
    drawStatus(); drawWarnings();
  }
  function cellHtml(uid, i) {
    const v = E.rows[uid][i] || '', d = dateOf(i);
    const lv = E.leave[uid]?.has(i), lp = E.pending[uid]?.has(i);
    const f = V?.flags.get(`${uid}|${i}`);
    const cls = [shiftClass(v, E.shifts), isWeekend(d) ? 'we' : '', lv ? 'lv' : lp ? 'lvp' : '', v !== pubVal(uid, i) ? 'chg' : '', f ? 'bad' : ''].join(' ');
    const tip = [v ? (E.shifts[v] ? `${E.shifts[v].name}${E.shifts[v].off ? '' : ` ${E.shifts[v].start}–${E.shifts[v].end}`}` : isCustomTime(v) ? `Custom ${v}` : v) : '', lv ? 'Approved leave' : lp ? 'Leave requested (pending)' : '', f || ''].filter(Boolean).join('\n');
    return `<td class="cell ${cls}" data-u="${uid}" data-i="${i}" title="${esc(tip)}">${esc(cellText(v, E.shifts))}</td>`;
  }
  function setCell(uid, i, v, td) {
    if ((E.rows[uid][i] || '') === v) return false;
    E.rows[uid][i] = v;
    if (td) td.outerHTML = cellHtml(uid, i);
    return true;
  }
  function changed() { render(); clearTimeout(autosaveT); autosaveT = setTimeout(() => saveDraft(true), 800); }
  function drawStatus() {
    const n = changedCount();
    $('#rStatus').innerHTML = (E.published ? `<span class="pill active">Published</span> ${fmtTs(E.published.updatedAt)}` : '<span class="pill pending">Not published</span>')
      + (n ? ` · <strong style="color:var(--c-orange)">${plural(n, 'unpublished change')}</strong>` : '')
      + (E.draftAt ? ` · <span class="muted">draft on device ${new Date(E.draftAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>` : '');
  }
  function drawWarnings() {
    const r = E.rules, parts = [];
    if (r.maxConsecutive) parts.push(`max ${r.maxConsecutive} days in a row`);
    if (r.minRestHours !== undefined && r.minRestHours !== '') parts.push(`${r.minRestHours} h rest`);
    if (r.maxWeeklyHours) parts.push(`max ${r.maxWeeklyHours} h / 7 days`);
    if (r.minDaysOffPerWeek) parts.push(`${r.minDaysOffPerWeek} day(s) off / week`);
    $('#rRulesTxt').textContent = parts.length ? `Rules: ${parts.join(' · ')}` : 'No rules set — add them in Settings → Roster rules';
    const w = V.warnings;
    $('#rWarnings').innerHTML = w.length ? `<ul class="warn-list">${w.slice(0, 40).map(x => `<li class="w-${x.kind}">${esc(x.msg)}</li>`).join('')}</ul>${w.length > 40 ? `<p class="muted">…and ${w.length - 40} more</p>` : ''}`
      : '<span style="color:var(--ok);font-weight:700">✓ No rule problems found.</span>';
  }

  /* ---------- painting & picking ---------- */
  const grid = $('#rGrid');
  grid.addEventListener('pointerdown', e => {
    const td = e.target.closest('td.cell'); if (!td || !E) return;
    if (brush === null) { openPop(td); return; }
    e.preventDefault(); pushUndo(); painting = true;
    setCell(td.dataset.u, +td.dataset.i, brushValue(), td);
  });
  document.addEventListener('pointermove', e => {
    if (!painting) return;
    const td = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('#rGrid td.cell');
    if (td) setCell(td.dataset.u, +td.dataset.i, brushValue(), td);
  });
  document.addEventListener('pointerup', () => { if (painting) { painting = false; if (undoStack.at(-1) === snapshot()) undoStack.pop(); $('#rUndo').disabled = !undoStack.length; changed(); } });

  const pop = $('#cellPop');
  function openPop(td) {
    const uid = td.dataset.u, i = +td.dataset.i, cur = E.rows[uid][i] || '';
    const n = E.names[uid]?.name || '';
    pop.innerHTML = `<div class="pop-head"><strong>${esc(n)}</strong> · ${fmtShort(dateOf(i))}${E.leave[uid]?.has(i) ? ' · <span style="color:var(--ok)">approved leave</span>' : ''}</div>
      <div class="pop-list">${byTime(E.shifts).map(s => `<button type="button" class="chip-btn sc-${esc(s.color || 'sky')} ${cur === s.code ? 'on' : ''}" data-v="${esc(s.code)}"><strong>${esc(lbl(s))}</strong><small>${esc(s.off ? s.name : `to ${s.end}`)}</small></button>`).join('')}</div>
      <div class="pop-custom"><span class="small muted">Custom</span> <select id="popS" class="time-sel">${timeOptions(isCustomTime(cur) ? cur.slice(0, 5) : '09:00')}</select> – <select id="popE" class="time-sel">${timeOptions(isCustomTime(cur) ? cur.slice(6) : '17:00')}</select> <button type="button" class="btn ghost sm" id="popSet">Set</button></div>
      <div class="actions" style="justify-content:space-between"><button type="button" class="btn ghost sm" data-v="">Clear</button><button type="button" class="btn ghost sm" id="popClose">Close</button></div>`;
    const r = td.getBoundingClientRect();
    pop.hidden = false;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left + window.scrollX - pw / 2 + r.width / 2)) + 'px';
    pop.style.top = (r.bottom + window.scrollY + ph + 8 > window.scrollY + window.innerHeight ? r.top + window.scrollY - ph - 6 : r.bottom + window.scrollY + 6) + 'px';
    const apply = v => { pushUndo(); if (!setCell(uid, i, v)) undoStack.pop(); pop.hidden = true; changed(); };
    $$('[data-v]', pop).forEach(b => b.onclick = () => apply(b.dataset.v));
    $('#popSet').onclick = () => { const s = $('#popS').value, e2 = $('#popE').value; if (s === e2) return toast('Start and end are the same.', 'bad'); apply(`${s}-${e2}`); };
    $('#popClose').onclick = () => pop.hidden = true;
  }
  document.addEventListener('pointerdown', e => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('#rGrid td.cell')) pop.hidden = true; });

  function undo() { if (!undoStack.length) return; E.rows = JSON.parse(undoStack.pop()); $('#rUndo').disabled = !undoStack.length; changed(); }
  $('#rUndo').onclick = undo;
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !$('[data-panel="roster"]').hidden && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) { e.preventDefault(); undo(); } });

  /* ---------- drafts on this device ---------- */
  async function saveDraft(silent) {
    if (!E) return;
    if (!isDirty()) { await idb.del('drafts', draftKey()); E.draftAt = null; drawStatus(); return; }
    E.draftAt = Date.now();
    await idb.set('drafts', draftKey(), { rows: E.rows, savedAt: E.draftAt, month: E.month });
    drawStatus(); if (!silent) toast('Draft saved on this device. It is not visible to staff until you publish.', 'ok');
  }
  $('#rSaveDraft').onclick = () => saveDraft(false);
  $('#rLoadFb').onclick = async () => {
    if (isDirty() && !confirm('Replace the grid with the version published in Firebase? Your device draft for this month will be deleted.')) return;
    await idb.del('drafts', draftKey()); await load({ fresh: true, ignoreDraft: true }); toast('Loaded the latest published roster from Firebase.', 'ok');
  };

  /* ---------- publish ---------- */
  $('#rSave').onclick = async () => {
    if (!E) return;
    const b = $('#rSave'); busy(b, true, 'Publishing…');
    try {
      const { id, month, days, rows, order, names, published } = E;
      const changes = {};
      order.forEach(uid => { const ds = []; rows[uid].forEach((v, i) => { if (v !== pubVal(uid, i)) ds.push(dateOf(i)); }); if (ds.length) changes[uid] = ds; });
      if (published && !Object.keys(changes).length) { toast('Nothing changed since the last publish.'); busy(b, false); return; }
      if (V.warnings.length && !confirm(`There ${V.warnings.length === 1 ? 'is 1 rule warning' : `are ${V.warnings.length} rule warnings`}. Publish anyway?`)) { busy(b, false); return; }
      const cleanOrder = order.filter(uid => rows[uid].some(Boolean) || published?.rows?.[uid]);
      const used = new Set(cleanOrder.flatMap(u => rows[u]).filter(Boolean));
      const shifts = Object.fromEntries(Object.values(E.shifts).filter(s => used.has(s.code) || !s.off).map(s => [s.code, s]));
      await setDoc(doc(db, 'rosters', id), {
        orgId: S.orgId, deptId: S.deptId, month, days, order: cleanOrder, names: Object.fromEntries(cleanOrder.map(u => [u, names[u] || {}])),
        rows: Object.fromEntries(cleanOrder.map(u => [u, rows[u]])), shifts, legend: shiftLegend(shifts), updatedAt: serverTimestamp(), updatedBy: profile.name || profile.email || 'Admin'
      });
      await idb.del('drafts', draftKey()); await invalidate('rosters/');
      const notifyUids = Object.keys(changes).filter(u => cleanOrder.includes(u));
      let msg = 'Roster published to Firebase.';
      if ($('#rNotify').checked && notifyUids.length) {
        const r = await ctx.notifySoft({ event: 'roster', rosterId: id, isNew: !published, changes: Object.fromEntries(notifyUids.map(u => [u, changes[u]])) });
        if (r) msg += ` ${plural(notifyUids.length, 'staff member')} notified.`;
      }
      toast(msg, 'ok'); await load({ fresh: true, ignoreDraft: true });
    } catch (err) { toast(err.message, 'bad', 8000); }
    busy(b, false);
  };

  /* ---------- clear / CSV ---------- */
  $('#rClear').onclick = () => { if (!E || !confirm('Clear every cell of this month? (You can undo.)')) return; pushUndo(); E.order.forEach(u => E.rows[u] = E.rows[u].map(() => '')); changed(); };
  $('#rTemplate').onclick = () => {
    if (!E) return;
    const head = ['Staff ID', 'Name', ...Array.from({ length: E.days }, (_, i) => i + 1)];
    const cell = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v;
    const lines = [head, ...E.order.map(uid => [E.names[uid]?.staffId || '', E.names[uid]?.name || '', ...E.rows[uid]])].map(r => r.map(cell).join(','));
    lines.push('', `Shift codes: ${Object.values(E.shifts).map(s => `${s.code}=${s.name}${s.off ? '' : ` ${s.start}-${s.end}`}`).join('; ')}. Custom time: 09:00-17:00`);
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `roster-${(ctx.deptName(S.deptId) || 'unit').replace(/[^\w-]+/g, '_')}-${E.month}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  async function loadSheetJS() {
    if (window.XLSX) return window.XLSX;
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load the spreadsheet reader')); document.head.append(s); });
    return window.XLSX;
  }
  $('#rFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f || !E) return;
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
        else if (typeof c === 'number' && c > 31) day = new Date(Math.round((c - 25569) * 86400000)).getUTCDate();
        else if (/^\d{1,2}$/.test(String(c).trim())) day = Number(String(c).trim());
        else if (/^\d{4}-\d{2}-\d{2}/.test(String(c).trim())) day = Number(String(c).trim().slice(8, 10));
        if (day && day <= E.days) dayCols[j] = day - 1;
      });
      if (!Object.keys(dayCols).length) throw new Error('No day columns found. Use 1, 2, 3 … or dates as column headers.');
      const bySid = Object.fromEntries(E.order.map(u => [String(E.names[u]?.staffId || '').toUpperCase(), u]));
      let matched = 0; const unknown = []; pushUndo();
      for (const row of aoa.slice(hi + 1)) {
        const sid = String(row[idCol] ?? '').trim().toUpperCase(); if (!sid) continue;
        const uid = bySid[sid]; if (!uid) { unknown.push(sid); continue; }
        Object.entries(dayCols).forEach(([j, i]) => E.rows[uid][i] = String(row[j] ?? '').trim().toUpperCase());
        matched++;
      }
      changed();
      $('#rMsg').innerHTML = `Loaded ${plural(matched, 'staff row')} from <strong>${esc(f.name)}</strong>. Review, then publish.` + (unknown.length ? `<div style="color:var(--bad)">Staff IDs not in this unit, skipped: ${unknown.map(esc).join(', ')}</div>` : '');
    } catch (err) { toast(err.message, 'bad', 8000); }
  };

  /* ---------- pattern fill ---------- */
  let seq = [];
  const chipFor = c => `<span class="code ${shiftClass(c, E.shifts)}">${esc(cellText(c, E.shifts))}</span>`;
  function drawSeq() { $('#patSeq').innerHTML = seq.length ? seq.map(chipFor).join(' ') + ` <span class="small muted">(${seq.length}-day cycle)</span>` : '<span class="muted small">Tap shifts above…</span>'; }
  $('#rPattern').onclick = () => {
    if (!E) return;
    const sh = byTime(E.shifts);
    $('#patChips').innerHTML = sh.map(s => `<button type="button" class="chip-btn sc-${esc(s.color || 'sky')}" data-c="${esc(s.code)}"><strong>${esc(lbl(s))}</strong><small>${esc(s.off ? s.name : `to ${s.end}`)}</small></button>`).join('');
    $$('#patChips [data-c]').forEach(b => b.onclick = () => { seq.push(b.dataset.c); drawSeq(); });
    const work = sh.filter(s => !s.off).map(s => s.code), off = sh.find(s => s.off && /^OFF$/i.test(s.code))?.code || sh.find(s => s.off)?.code || '';
    const presets = [];
    const L = c => cellText(c, E.shifts);
    if (work[0] && off) presets.push([`5× ${L(work[0])} + 2 ${off}`, [...Array(5).fill(work[0]), off, off]]);
    if (work.length >= 3 && off) presets.push([`2-2-2 rotation`, [work[0], work[0], work[1], work[1], work[2], work[2], off, off]]);
    if (work.length >= 2 && off) presets.push([`${L(work[0])} / ${L(work[1])} weeks`, [...Array(5).fill(work[0]), off, off, ...Array(5).fill(work[1]), off, off]]);
    $('#patPresets').innerHTML = presets.map((p, i) => `<button type="button" class="btn ghost sm" data-p="${i}">${esc(p[0])}</button>`).join('');
    $$('#patPresets [data-p]').forEach(b => b.onclick = () => { seq = [...presets[+b.dataset.p][1]]; drawSeq(); });
    $('#patStaff').innerHTML = E.order.map(uid => `<label class="check"><input type="checkbox" value="${uid}" checked> ${esc(E.names[uid]?.name || uid)} <span class="muted small">${esc(E.names[uid]?.level || '')}</span></label>`).join('');
    $('#patStart').max = E.days; drawSeq();
    $('#patternDlg').showModal();
  };
  $('#patBack').onclick = () => { seq.pop(); drawSeq(); };
  $('#patReset').onclick = () => { seq = []; drawSeq(); };
  $('#patAll').onclick = e => { e.preventDefault(); $$('#patStaff input').forEach(c => c.checked = true); };
  $('#patNone').onclick = e => { e.preventDefault(); $$('#patStaff input').forEach(c => c.checked = false); };
  $('#patCancel').onclick = () => $('#patternDlg').close();
  $('#patternForm').onsubmit = e => {
    e.preventDefault();
    if (!seq.length) return toast('Tap some shifts to build the pattern first.', 'bad');
    const start = Math.max(1, Math.min(E.days, Number($('#patStart').value) || 1)) - 1;
    const stagger = Number($('#patStagger').value) || 0, onlyEmpty = $('#patOnlyEmpty').checked, useLeave = $('#patLeave').checked;
    const alCode = E.shifts.AL ? 'AL' : (Object.values(E.shifts).find(s => s.off && /leave/i.test(s.name))?.code || 'AL');
    const picked = $$('#patStaff input:checked').map(c => c.value);
    if (!picked.length) return toast('Choose at least one staff member.', 'bad');
    pushUndo();
    picked.forEach((uid, k) => {
      for (let i = start; i < E.days; i++) {
        if (onlyEmpty && E.rows[uid][i]) continue;
        E.rows[uid][i] = useLeave && E.leave[uid]?.has(i) ? alCode : seq[((i - start) + k * stagger) % seq.length];
      }
    });
    $('#patternDlg').close(); changed(); toast(`Pattern applied to ${plural(picked.length, 'person', )}.`.replace('persons', 'people'), 'ok');
  };

  /* ---------- copy previous month ---------- */
  let prevRoster = null;
  $('#rCopyPrev').onclick = async () => {
    if (!E) return;
    const [y, m] = E.month.split('-').map(Number); const pm = ym(new Date(y, m - 2, 1));
    prevRoster = await cachedDoc(doc(db, 'rosters', rosterId(pm, S.orgId, S.deptId))).catch(() => null);
    const draft = await idb.get('drafts', `${profile.id}|${rosterId(pm, S.orgId, S.deptId)}`);
    if (draft?.rows) prevRoster = { ...(prevRoster || {}), rows: { ...(prevRoster?.rows || {}), ...draft.rows }, days: daysInMonth(pm) };
    if (!prevRoster?.rows) return toast(`There is no roster for ${new Date(y, m - 2, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}.`, 'bad');
    $('#copyInfo').textContent = `From ${new Date(y, m - 2, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}${draft?.rows ? ' (including your device draft)' : ''}.`;
    $('#copyDlg').showModal();
  };
  $('#copyCancel').onclick = () => $('#copyDlg').close();
  $('#copyForm').onsubmit = e => {
    e.preventDefault();
    const mode = $('input[name="copyMode"]:checked').value, onlyEmpty = $('#copyOnlyEmpty').checked;
    const pDays = prevRoster.days || 31;
    pushUndo(); let n = 0;
    E.order.forEach(uid => {
      const src = prevRoster.rows[uid]; if (!src) return;
      for (let i = 0; i < E.days; i++) {
        let v;
        if (mode === 'date') v = i < pDays ? src[i] : '';
        else { const j = i - 28; v = j < 0 ? src[pDays + j] : E.rows[uid][j]; } // 4 weeks earlier → same weekday
        if (onlyEmpty && E.rows[uid][i]) continue;
        if (v && E.leave[uid]?.has(i)) v = E.shifts.AL ? 'AL' : v;
        if ((v || '') !== E.rows[uid][i]) { E.rows[uid][i] = v || ''; n++; }
      }
    });
    $('#copyDlg').close(); changed(); toast(`Copied ${plural(n, 'cell')}. Review, then publish.`, 'ok');
  };

  /* ---------- Auto-roster (built in, free) ---------- */
  let beforeAuto = null;
  $('#rAuto').onclick = () => {
    if (!E) return;
    const minPer = E.rules.minPerShift || {};
    const work = byTime(E.shifts).filter(s => !s.off);
    if (!work.length) return toast('Add working shifts with times first (Settings → Shifts & timings).', 'bad', 7000);
    $('#autoNeed').innerHTML = `<table class="need-table"><thead><tr><th>Shift</th><th>Weekdays</th><th>Weekend</th></tr></thead><tbody>${work.map(s => `<tr>
      <td><span class="code sc-${esc(s.color || 'sky')}">${esc(lbl(s))}</span> ${esc(s.name)} <span class="muted small">${esc(s.start)}–${esc(s.end)}</span></td>
      <td><input type="number" min="0" max="99" data-need="${esc(s.code)}" data-k="wd" value="${esc(minPer[s.code] ?? '')}" placeholder="0"></td>
      <td><input type="number" min="0" max="99" data-need="${esc(s.code)}" data-k="we" value="${esc(minPer[s.code] ?? '')}" placeholder="0"></td></tr>`).join('')}</tbody></table>`;
    $('#autoStaff').innerHTML = E.order.filter(u => E.activeIds.has(u)).map(uid => `<label class="check"><input type="checkbox" value="${uid}" checked> ${esc(E.names[uid]?.name || uid)} <span class="muted small">${esc(E.names[uid]?.level || '')}</span></label>`).join('');
    $('#autoStart').max = E.days; $('#autoResult').hidden = true; $('#autoUndo').hidden = true;
    $('#autoDlg').showModal();
  };
  $('#autoAll').onclick = e => { e.preventDefault(); $$('#autoStaff input').forEach(c => c.checked = true); };
  $('#autoNone').onclick = e => { e.preventDefault(); $$('#autoStaff input').forEach(c => c.checked = false); };
  $('#autoClose').onclick = () => $('#autoDlg').close();
  $('#autoUndo').onclick = () => { if (!beforeAuto) return; pushUndo(); E.rows = JSON.parse(beforeAuto); beforeAuto = null; $('#autoUndo').hidden = true; changed(); toast('Auto-roster undone.'); };
  $('#autoForm').onsubmit = e => {
    e.preventDefault();
    const need = {};
    $$('#autoNeed [data-need]').forEach(i => { (need[i.dataset.need] ||= {})[i.dataset.k] = Number(i.value) || 0; });
    if (!Object.values(need).some(n => n.wd || n.we)) return toast('Enter how many staff each shift needs.', 'bad');
    const staff = $$('#autoStaff input:checked').map(c => c.value);
    if (!staff.length) return toast('Choose at least one staff member.', 'bad');
    const b = $('#autoGo'); busy(b, true, 'Building…');
    setTimeout(() => {
      try {
        const levels = Object.fromEntries(E.order.map(u => [u, E.names[u]?.level || '']));
        const res = autoRoster({ ...E, levels, need, staff, onlyEmpty: $('#autoOnlyEmpty').checked, fillOff: $('#autoOff').checked,
          startDay: Math.max(1, Math.min(E.days, Number($('#autoStart').value) || 1)) - 1 });
        beforeAuto = snapshot(); pushUndo();
        let n = 0;
        for (const u of E.order) res.R[u].forEach((v, i) => { if ((v || '') !== E.rows[u][i]) { E.rows[u][i] = v || ''; n++; } });
        changed();
        const hs = staff.map(u => V.totals[u]?.hours || 0);
        const short = res.shortages;
        const byShift = {}; short.forEach(x => byShift[x.code] = (byShift[x.code] || 0) + x.missing);
        $('#autoResult').hidden = false;
        $('#autoResult').innerHTML = `<strong>${plural(n, 'cell')} filled.</strong> Hours per person: ${Math.min(...hs)}–${Math.max(...hs)}.
          ${short.length ? `<div style="color:var(--bad);margin-top:6px">Not enough staff who could legally work: ${Object.entries(byShift).map(([c, m]) => `${esc(c)} short ${plural(m, 'time')}`).join(', ')}. Add staff, lower the numbers, or relax a rule.</div>` : '<div style="color:var(--ok);margin-top:6px">Every shift got the staff it needs.</div>'}
          ${V.warnings.length ? `<div class="muted" style="margin-top:4px">${plural(V.warnings.length, 'rule warning')} left — see Rule check under the grid.</div>` : ''}
          <div class="small muted" style="margin-top:6px">Nothing is published yet. Check the grid, then press “Publish to Firebase”. Press Build again for a different variation.</div>`;
        $('#autoUndo').hidden = !n;
      } catch (err) { toast(err.message, 'bad', 8000); }
      busy(b, false);
    }, 30);
  };

  /* ---------- AI assistant (optional, Gemini free tier) ---------- */
  let beforeAi = null;
  const AI_CHIPS = ['Fill the whole month fairly and follow all the rules', 'Only fill the empty days', 'Fix the rule warnings with as few changes as possible', 'Give everyone weekends off in turn', 'Balance hours so everyone works about the same'];
  $('#aiChips').innerHTML = AI_CHIPS.map(c => `<button type="button" class="btn ghost sm" data-ai="${esc(c)}">${esc(c)}</button>`).join('');
  $$('#aiChips [data-ai]').forEach(b => b.onclick = () => { $('#aiPrompt').value = b.dataset.ai; if (/empty/i.test(b.dataset.ai)) $('#aiOnlyEmpty').checked = true; });
  $('#rAi').onclick = () => { $('#aiResult').hidden = true; $('#aiUndo').hidden = true; $('#aiDlg').showModal(); };
  $('#aiClose').onclick = () => $('#aiDlg').close();
  $('#aiUndo').onclick = () => { if (!beforeAi) return; pushUndo(); E.rows = JSON.parse(beforeAi); beforeAi = null; $('#aiUndo').hidden = true; changed(); toast('AI changes undone.'); };
  $('#aiForm').onsubmit = async e => {
    e.preventDefault();
    const instruction = $('#aiPrompt').value.trim(); if (!instruction) return toast('Tell the assistant what you want.', 'bad');
    const b = $('#aiGo'); busy(b, true, 'Thinking… (up to a minute)');
    $('#aiResult').hidden = false; $('#aiResult').innerHTML = '<span class="muted">Working on it…</span>';
    try {
      const r = await api('/api/ai', { rosterId: E.id, instruction, onlyEmpty: $('#aiOnlyEmpty').checked, rows: Object.fromEntries(E.order.map(u => [u, E.rows[u]])) });
      beforeAi = snapshot(); pushUndo();
      let n = 0;
      for (const [uid, row] of Object.entries(r.rows || {})) {
        if (!E.rows[uid]) continue;
        row.forEach((v, i) => { if (i < E.days && (v || '') !== E.rows[uid][i]) { E.rows[uid][i] = v || ''; n++; } });
      }
      changed();
      $('#aiResult').innerHTML = `<strong>${plural(n, 'cell')} changed.</strong> ${esc(r.notes || '')}<div class="small muted" style="margin-top:6px">Nothing is published yet — check the grid and the rule check, then press “Publish to Firebase”. ${r.remaining != null ? `AI requests left today: ${r.remaining}.` : ''}</div>`;
      $('#aiUndo').hidden = !n;
    } catch (err) { $('#aiResult').innerHTML = `<span style="color:var(--bad)">${esc(err.message)}</span>`; }
    busy(b, false);
  };

  $('#rShiftRules').onclick = () => ctx.openShiftRules?.();
  return {
    load, isDirty,
    setAiVisible(on) { $('#rAi').hidden = !on; },
    beforeLeave() { if (E && isDirty()) saveDraft(true); }
  };
}
