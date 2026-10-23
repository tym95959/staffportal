// POST /api/ai  { rosterId, instruction, rows: {uid: [codes]}, onlyEmpty }
// OPTIONAL AI roster assistant using Google Gemini's FREE tier (no billing needed).
// The built-in ⚡ Auto-roster in the editor needs none of this — it is free and runs in the browser.
//
// Privacy: Google may use free-tier requests to improve its products, so NO staff names are sent.
// Staff become S1, S2…; names typed in the request are replaced with those codes before sending,
// and the codes in the AI's reply are turned back into names here.
// Only managers of that unit can call it, only when the App admin switched AI on for the company,
// and only up to the company's daily limit. Nothing is saved — the admin reviews it and publishes.
//
// Vercel environment variables:
//   GEMINI_API_KEY   free key from https://aistudio.google.com  (no credit card)
//   AI_MODEL         optional, default gemini-3.8-flash
import { withAuth, httpError, db, FieldValue, requireMgr } from './_lib.js';

const DEFAULT_SHIFTS = [
  { code: 'M', name: 'Morning', start: '06:00', end: '14:00' }, { code: 'E', name: 'Evening', start: '14:00', end: '22:00' },
  { code: 'N', name: 'Night', start: '22:00', end: '06:00' }, { code: 'OFF', name: 'Day off', off: true },
  { code: 'AL', name: 'Annual leave', off: true }, { code: 'SL', name: 'Sick leave', off: true }, { code: 'PH', name: 'Public holiday', off: true }
];
const CUSTOM_RE = /^\d{2}:\d{2}-\d{2}:\d{2}$/;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hours = s => { if (s.off || !s.start || !s.end) return 0; const t = x => { const [h, m] = x.split(':').map(Number); return h * 60 + m; }; let d = t(s.end) - t(s.start); if (d <= 0) d += 1440; return Math.round(d / 6) / 10; };

async function callAi(system, prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw httpError(500, 'The AI assistant is not set up: add a free GEMINI_API_KEY (from aistudio.google.com) in Vercel → Settings → Environment Variables, then redeploy. The ⚡ Auto-roster works without it.');
  const model = process.env.AI_MODEL || 'gemini-3.8-flash';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 12000 } })
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 429) throw httpError(429, 'Google’s free AI limit is used up for now. Try again later, or use ⚡ Auto-roster (no limits).');
  if (!r.ok) throw httpError(502, `AI error (Gemini): ${j.error?.message || r.status}`);
  return (j.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('');
}
function parseJson(text) {
  const s = String(text || '').replace(/```(?:json)?/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw httpError(502, 'The AI did not return a roster. Try again or rephrase.');
  try { return JSON.parse(s.slice(a, b + 1)); } catch { throw httpError(502, 'The AI answer could not be read. Try again.'); }
}

export default withAuth(async ({ me, body }) => {
  const { rosterId, instruction = '', rows: current = {}, onlyEmpty = false } = body || {};
  const [orgId, deptId, month] = String(rosterId || '').split('__');
  if (!orgId || !deptId || !/^\d{4}-\d{2}$/.test(month || '')) throw httpError(400, 'Bad roster');
  if (!String(instruction).trim()) throw httpError(400, 'Tell the assistant what you want');
  requireMgr(me, orgId, deptId);

  const orgSnap = await db().doc(`orgs/${orgId}`).get();
  const org = orgSnap.data() || {};
  if (!org.aiEnabled) throw httpError(403, 'The AI assistant is not switched on for this company. Ask the App admin.');
  if (!process.env.GEMINI_API_KEY) throw httpError(500, 'The AI assistant is not set up: add a free GEMINI_API_KEY in Vercel, then redeploy. The ⚡ Auto-roster works without it.');

  // daily limit per company
  const limit = Number(org.aiDailyLimit) || 20, day = new Date().toISOString().slice(0, 10);
  const uref = db().doc(`aiUsage/${orgId}_${day}`);
  let used = 0;
  await db().runTransaction(async tx => {
    const s = await tx.get(uref); used = s.exists ? s.data().count || 0 : 0;
    if (used >= limit) throw httpError(429, `This company has used all ${limit} AI requests for today. Try again tomorrow.`);
    tx.set(uref, { orgId, day, count: used + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });

  const [dirQ, dsetSnap, leaveQ, unitSnap] = await Promise.all([
    db().collection('directory').where('orgId', '==', orgId).where('deptId', '==', deptId).where('active', '==', true).get(),
    db().doc(`deptSettings/${deptId}`).get(),
    db().collection('leaveRequests').where('orgId', '==', orgId).where('deptId', '==', deptId).get(),
    db().doc(`departments/${deptId}`).get()
  ]);
  const dset = dsetSnap.data() || {};
  const shiftMap = {};
  [...(org.shifts?.length ? org.shifts : DEFAULT_SHIFTS), ...(dset.shifts || [])].forEach(s => { if (s?.code) shiftMap[String(s.code).toUpperCase()] = s; });
  const shifts = Object.values(shiftMap);
  const rules = dset.rules || {};
  const [y, m] = month.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const dayList = Array.from({ length: days }, (_, i) => `${i + 1} ${DOW[new Date(Date.UTC(y, m - 1, i + 1)).getUTCDay()]}`);
  const weekend = (org.weekendDays || [5, 6]).map(d => DOW[d]).join(', ');

  // staff get short keys (S1, S2…) so names / ids can't confuse the model
  const staff = dirQ.docs.map(d => ({ uid: d.id, ...d.data() })).sort((a, b) => (a.level || '').localeCompare(b.level || '') || (a.name || '').localeCompare(b.name || ''));
  if (!staff.length) throw httpError(400, 'There are no active staff in this unit.');
  const keyOf = {}, uidOf = {};
  staff.forEach((s, i) => { keyOf[s.uid] = `S${i + 1}`; uidOf[`S${i + 1}`] = s.uid; });
  const leaveDays = {};
  leaveQ.docs.map(d => d.data()).filter(l => l.status === 'approved').forEach(l => {
    for (let i = 1; i <= days; i++) { const d = `${month}-${String(i).padStart(2, '0')}`; if (d >= l.fromDate && d <= l.toDate) (leaveDays[l.uid] ||= []).push(i); }
  });
  const valid = new Set([...Object.keys(shiftMap), 'AL']);
  const clean = v => { v = String(v ?? '').trim().toUpperCase(); return v === '-' || v === '' ? '' : (valid.has(v) || CUSTOM_RE.test(v)) ? v : null; };
  const cur = uid => Array.from({ length: days }, (_, i) => clean(current?.[uid]?.[i]) || '');

  const ruleLines = [
    rules.maxConsecutive && `- At most ${rules.maxConsecutive} working days in a row.`,
    rules.minRestHours != null && rules.minRestHours !== '' && `- At least ${rules.minRestHours} hours rest between the end of one shift and the start of the next (a Night ending 06:00 followed by a Morning starting 06:00 is 0 hours rest).`,
    rules.maxWeeklyHours && `- At most ${rules.maxWeeklyHours} working hours in any 7 consecutive days.`,
    rules.minDaysOffPerWeek && `- At least ${rules.minDaysOffPerWeek} day(s) off in every Monday–Sunday week.`,
    ...Object.entries(rules.minPerShift || {}).filter(([, n]) => n).map(([c, n]) => `- At least ${n} staff on ${c} every day.`),
    rules.notes && `- Unit notes: ${rules.notes}`
  ].filter(Boolean);

  const system = 'You are a careful staff rostering assistant for a workplace. You produce duty rosters as strict JSON only, with no other text. You follow the unit rules exactly when possible, treat staff fairly (balanced hours, nights and weekends), never schedule work on approved leave days (use AL there), and explain briefly any rule you could not satisfy.';
  // replace any staff names the admin typed with their codes (longest names first)
  const nameKeys = staff.flatMap(s => { const full = String(s.name || '').trim(); const first = full.split(/\s+/)[0];
    return [[full, keyOf[s.uid]], ...(first && first.length > 2 && staff.filter(o => String(o.name || '').split(/\s+/)[0] === first).length === 1 ? [[first, keyOf[s.uid]]] : [])]; })
    .filter(([n]) => n).sort((a, b) => b[0].length - a[0].length);
  const escRe = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const anon = text => nameKeys.reduce((t, [n, k]) => t.replace(new RegExp(`\\b${escRe(n)}\\b`, 'gi'), k), String(text));
  const safeInstruction = String(instruction).slice(0, 2000);
  const prompt = [
    `Month: ${month} (${days} days). Weekend days: ${weekend}.`,
    `Days: ${dayList.join(', ')}`,
    '', 'Shifts (code | name | time | hours):',
    ...shifts.map(s => `${s.code} | ${s.name || s.code} | ${s.off ? 'not working (day off / leave)' : `${s.start}-${s.end}`} | ${hours(s)}`),
    'Custom working times may be written as HH:MM-HH:MM (e.g. 09:00-17:00) only if the request asks for them.',
    '', 'Rules:', ...(ruleLines.length ? ruleLines : ['- (no rules set)']),
    '', 'Staff (key | level | approved leave days):',
    ...staff.map(s => `${keyOf[s.uid]} | ${s.level || '-'} | ${(leaveDays[s.uid] || []).join(',') || 'none'}`),
    '', `Current roster (key: ${days} comma-separated values, "-" = empty):`,
    ...staff.map(s => `${keyOf[s.uid]}: ${cur(s.uid).map(v => v || '-').join(',')}`),
    '', `Request from the admin: ${safeInstruction}`,
    onlyEmpty ? 'IMPORTANT: keep every non-empty value of the current roster exactly as it is; only replace "-" cells.' : '',
    '', `Reply with JSON only, exactly this shape: {"rows": {"S1": "M,M,OFF,...", ...}, "notes": "one or two sentences: what you did and any rule you could not meet"}.`,
    `Every row must have exactly ${days} comma-separated values, using only these codes: ${[...valid].join(', ')}, a custom time, or "-" for empty. Include every staff key.`
  ].join('\n');

  let out;
  try { out = parseJson(await callAi(system, anon(prompt))); }
  catch (e) { await uref.update({ count: FieldValue.increment(-1) }).catch(() => {}); throw e; } // failed calls don't count
  const rows = {}; let invalid = 0;
  for (const [k, val] of Object.entries(out.rows || {})) {
    const uid = uidOf[String(k).trim().toUpperCase()]; if (!uid) continue;
    const list = Array.isArray(val) ? val : String(val).split(',');
    const before = cur(uid);
    rows[uid] = Array.from({ length: days }, (_, i) => {
      const v = clean(list[i]);
      if (v === null) { invalid++; return before[i]; }
      if (onlyEmpty && before[i]) return before[i];
      if ((leaveDays[uid] || []).includes(i + 1) && v && !shiftMap[v]?.off && v !== 'AL') return 'AL';
      return v;
    });
  }
  if (!Object.keys(rows).length) throw httpError(502, 'The AI did not return any usable rows. Try again or rephrase.');
  const nameOf = Object.fromEntries(staff.map(s => [keyOf[s.uid], s.name]));
  const notes = String(out.notes || '').replace(/\bS(\d+)\b/g, (m) => nameOf[m] || m);
  return { rows, notes: notes.slice(0, 1200) + (invalid ? ` (${invalid} unknown code(s) were ignored.)` : ''), remaining: Math.max(0, limit - used - 1) };
});
