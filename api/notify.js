// Vercel serverless function: sends THAAS push notifications to the Android app.
// POST /api/notify   body: { roomId, kind }   header: Authorization: Bearer <Firebase ID token>
//
// kinds: "turn"  -> the player whose turn it is now
//        "start" / "round" -> everyone at the table (game / next round started)
//        "ended" -> everyone at the table (someone called DIGU or CALL)
//        "join"  -> the lounge owner (someone joined their lounge)
//        "sit"   -> everyone already at that lobby table (someone sat down)
//
// Needs the Vercel environment variable FIREBASE_SERVICE_ACCOUNT (the whole service-account JSON).
const admin = require("firebase-admin");

function init() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
  const databaseURL = process.env.FIREBASE_DATABASE_URL; // set this when the card tables are in Realtime Database
  return admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), ...(databaseURL ? { databaseURL } : {}) });
}

const GAME = { digu: "DIGU", call: "CALL" };
const tableLabel = (id, r) => {
  const g = GAME[r.game === "call" ? "call" : "digu"];
  if (r.public === false) {
    const owner = (r.players || []).find((p) => p.uid === r.host);
    return `${owner?.name || "A"}'s lounge (${g})`;
  }
  return `${g} table ${r.tableNo || String(id).slice(-1)}`;
};

// Who gets told what. Only players at this table can ever be targets.
function plan(kind, roomId, r, caller) {
  const name = (r.players || []).find((p) => p.uid === caller)?.name || "Someone";
  const others = (r.playerIds || []).filter((u) => u !== caller);
  const where = tableLabel(roomId, r);
  switch (kind) {
    case "turn": {
      if (r.status !== "playing") return null;
      const next = r.playerIds?.[r.turn];
      if (!next || next === caller) return null;
      return { to: [next], title: "Your turn 🃏", body: `${where} · ${name} just played` };
    }
    case "start":
      if (r.status !== "playing") return null;
      return { to: others, title: "Game started!", body: `${where} · tap to play` };
    case "round":
      if (r.status !== "playing") return null;
      return { to: others, title: "Next round dealt", body: `${where} · round ${r.gameRound || ""}`.trim() };
    case "ended":
      if (r.status !== "ended" || r.winner !== caller) return null;
      return { to: others, title: `${name} called ${GAME[r.game === "call" ? "call" : "digu"]}!`, body: `${where} · see the scores` };
    case "join":
      if (r.public !== false || r.host === caller) return null;
      return { to: [r.host], title: "New player in your lounge", body: `${name} joined · ${r.playerIds.length} seated` };
    case "sit":
      if (r.public === false || r.status !== "lobby" || others.length === 0) return null;
      return { to: others, title: "Someone sat at your table", body: `${name} sat at ${where} · tap Start to play` };
    default:
      return null;
  }
}

module.exports = async function handler(req, res) {
  // the app runs on its own origin (https://localhost), so allow cross-origin calls
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let app;
  try { app = init(); } catch (e) { return res.status(500).json({ error: e.message }); }

  // 1. who is asking?
  const idToken = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  let caller;
  try { caller = (await app.auth().verifyIdToken(idToken)).uid; }
  catch { return res.status(401).json({ error: "not signed in" }); }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const { roomId, kind } = body;
  if (kind === "update") return sendUpdate(app, caller, body, res);
  if (!roomId || typeof roomId !== "string" || roomId.includes("/")) return res.status(400).json({ error: "bad roomId" });

  // 2. they must be at that table
  const db = app.firestore();
  // card tables: Realtime Database when it's set up, otherwise Firestore
  let room = null;
  if (process.env.FIREBASE_DATABASE_URL) room = (await app.database().ref(`rooms/${roomId}`).get()).val();
  if (!room) { const snap = await db.doc(`rooms/${roomId}`).get(); room = snap.exists ? snap.data() : null; }
  if (!room) return res.status(404).json({ error: "no such room" });
  room.playerIds = Array.isArray(room.playerIds) ? room.playerIds : Object.values(room.playerIds || {});
  room.players = Array.isArray(room.players) ? room.players : Object.values(room.players || {});
  if (!(room.playerIds || []).includes(caller)) return res.status(403).json({ error: "not at this table" });

  // 3. decide who to tell
  const msg = plan(kind, roomId, room, caller);
  if (!msg || !msg.to.length) return res.json({ sent: 0 });

  // 4. collect their phones
  const phones = await db.getAll(...msg.to.map((u) => db.doc(`pushTokens/${u}`)));
  const tokens = [], owner = [];
  phones.forEach((u) => (u.get("tokens") || []).forEach((t) => { tokens.push(t); owner.push(u.id); }));
  if (!tokens.length) return res.json({ sent: 0 });

  // 5. send
  const result = await app.messaging().sendEachForMulticast({
    tokens,
    notification: { title: msg.title, body: msg.body },
    data: { roomId, kind },
    android: {
      priority: "high",
      notification: { channelId: "turns", tag: `${roomId}-${kind}`, color: "#E8B64C", sound: "default" },
    },
  });

  // 6. forget phones that uninstalled the app
  const dead = {};
  result.responses.forEach((r, i) => {
    const code = r.error?.code || "";
    if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token") || code.includes("invalid-argument")) {
      (dead[owner[i]] ||= []).push(tokens[i]);
    }
  });
  await Promise.all(Object.entries(dead).map(([u, t]) =>
    db.doc(`pushTokens/${u}`).update({ tokens: admin.firestore.FieldValue.arrayRemove(...t) }).catch(() => {})));

  return res.json({ sent: result.successCount, failed: result.failureCount });
};

// Admin only: tell every phone with the app that a new version is out.
async function sendUpdate(app, caller, body, res) {
  const db = app.firestore();
  if (!(await db.doc(`admins/${caller}`).get()).exists) return res.status(403).json({ error: "admins only" });
  const all = await db.collection("pushTokens").get();
  const tokens = [];
  all.forEach((u) => (u.get("tokens") || []).forEach((t) => tokens.push(t)));
  if (!tokens.length) return res.json({ sent: 0 });
  const text = String(body.text || "").slice(0, 140) || "New features and fixes are ready. Open THAAS to update.";
  let sent = 0, failed = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const r = await app.messaging().sendEachForMulticast({
      tokens: tokens.slice(i, i + 500),
      notification: { title: "🔄 THAAS update available", body: text },
      data: { kind: "update", version: String(body.version || "") },
      android: { priority: "high", notification: { channelId: "turns", tag: "thaas-update", color: "#E8B64C", sound: "default" } },
    });
    sent += r.successCount; failed += r.failureCount;
  }
  return res.json({ sent, failed });
}

module.exports.plan = plan; // for tests
