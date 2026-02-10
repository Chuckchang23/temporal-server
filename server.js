const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
const Database = require("better-sqlite3");
const OBSWebSocket = require("obs-websocket-js").default;

const app = express();
app.use(cors());
app.use(express.json());

const db = new Database("game.db");

// =========================
// OBS WebSocket CONFIG
// =========================
const OBS_IP = process.env.OBS_IP || "192.168.68.116";
const OBS_PORT = parseInt(process.env.OBS_PORT || "4455", 10);
const OBS_PASSWORD = process.env.OBS_PASSWORD || "6cfFyyzyp8R6m5f7";
const OBS_SCENE_2_NAME = process.env.OBS_SCENE_2_NAME || "Scene 2";
const { hideSoleilInScene3 } = require("./obs");
const obs = new OBSWebSocket();
let obsConnected = false;
let obsConnecting = null;

async function connectOBS() {
  if (obsConnected) return true;
  if (obsConnecting) return obsConnecting;

  obsConnecting = (async () => {
    try {
      await obs.connect(`ws://${OBS_IP}:${OBS_PORT}`, OBS_PASSWORD);
      obsConnected = true;
      console.log("✅ Connected to OBS WebSocket");
      return true;
    } catch (err) {
      obsConnected = false;
      console.log("❌ OBS connect error:", err?.message || err);
      return false;
    } finally {
      obsConnecting = null;
    }
  })();

  return obsConnecting;
}

async function setObsScene(sceneName) {
  const ok = await connectOBS();
  if (!ok) throw new Error("OBS not connected");

  // OBS WebSocket v5:
  await obs.call("SetCurrentProgramScene", { sceneName });
  return true;
}

// Optional: if OBS disconnects, mark it disconnected
obs.on("ConnectionClosed", () => {
  obsConnected = false;
  console.log("⚠️ OBS connection closed");
});

// --- DB init ---
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ts INTEGER NOT NULL
);
`);

const now = () => Date.now();

function defaultState() {
  return {
    artifact: null, // watch|compass|letter
    path: [],
    sequence_index: 0,
    timeline_open: "PR",
    puzzles: {
      pr: { stage: 0 },
      pa: { stage: 0, inbox: [] },
      f: { stage: 0 }
    },
    last_event: null
  };
}

function getState(sessionId) {
  const row = db.prepare("SELECT state_json FROM sessions WHERE id=?").get(sessionId);
  return row ? JSON.parse(row.state_json) : null;
}

function saveState(sessionId, state) {
  db.prepare(`
    INSERT INTO sessions (id, state_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      state_json=excluded.state_json,
      updated_at=excluded.updated_at
  `).run(sessionId, JSON.stringify(state), now());
}

function logEvent(sessionId, type, payload) {
  db.prepare(`
    INSERT INTO events (session_id, type, payload_json, ts)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, type, JSON.stringify(payload || {}), now());
}

// --- WebSocket rooms ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/** sessionId -> Set<WebSocket> */
const rooms = new Map();

function broadcast(sessionId, msg) {
  const set = rooms.get(sessionId);
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

wss.on("connection", (ws, req) => {
  // ws://ip:3000/ws?sessionId=S123&device=past
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("sessionId");
  const device = url.searchParams.get("device") || "unknown";

  if (!sessionId) {
    ws.close(1008, "Missing sessionId");
    return;
  }

  if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
  rooms.get(sessionId).add(ws);

  ws.send(JSON.stringify({ type: "HELLO", sessionId, device, ts: now() }));

  const state = getState(sessionId);
  if (state) ws.send(JSON.stringify({ type: "STATE_UPDATED", state }));

  ws.on("close", () => {
    const set = rooms.get(sessionId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) rooms.delete(sessionId);
    }
  });
});

// --- Game logic ---
function pathForArtifact(artifact) {
  if (artifact === "watch") return ["PR","PA","PR","F","PR","PA","F"];
  if (artifact === "compass") return ["PR","F","PR","PA","PR","F","PA"];
  if (artifact === "letter") return ["PR","PA","F","PR","F","PA","PR"];
  return ["PR"];
}

function applyEvent(state, type, payload) {
  state.last_event = { type, payload, ts: now() };

  switch (type) {
    case "ARTIFACT_SELECTED": {
      const { artifact } = payload;
      if (!["watch","compass","letter"].includes(artifact)) throw new Error("Invalid artifact");
      state.artifact = artifact;
      state.path = pathForArtifact(artifact);
      state.sequence_index = 0;
      state.timeline_open = state.path[0] || "PR";
      return state;
    }

    case "PR_SET_NEXT_YEAR": {
      state.sequence_index = Math.min(state.sequence_index + 1, state.path.length - 1);
      state.timeline_open = state.path[state.sequence_index];
      return state;
    }

    case "PA_ANSWER_CORRECT": {
      state.puzzles.pa.stage += 1;
      state.sequence_index = Math.min(state.sequence_index + 1, state.path.length - 1);
      state.timeline_open = state.path[state.sequence_index];
      return state;
    }

    case "FUTURE_SENT_MESSAGE_TO_PAST": {
      const msg = payload.message || "Message from the future…";
      state.puzzles.pa.inbox.push({ id: `msg_${now()}`, message: msg });
      return state;
    }

    // NEW: purely a state marker (optional)
    case "OBS_SWITCH_SCENE2": {
      state.puzzles.pr.last_obs_scene = "Scene2";
      return state;
    }

    default:
      return state;
  }
}

// =========================
// OBS REST API (optional direct trigger)
// =========================
app.get("/obs/health", async (req, res) => {
  const ok = await connectOBS();
  res.json({ ok, obsConnected: obsConnected, ip: OBS_IP, port: OBS_PORT });
});

app.post("/obs/scene", async (req, res) => {
  const { sceneName } = req.body || {};
  if (!sceneName) return res.status(400).json({ error: "sceneName required" });

  try {
    await setObsScene(sceneName);
    res.json({ ok: true, sceneName });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Convenience endpoint: switch to Scene 2
app.post("/obs/scene2", async (req, res) => {
  try {
    await setObsScene(OBS_SCENE_2_NAME);
    res.json({ ok: true, sceneName: OBS_SCENE_2_NAME });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// --- REST API ---
app.post("/sessions", (req, res) => {
  const sessionId = req.body.sessionId || `S${Math.random().toString(16).slice(2, 8)}`;
  const state = defaultState();
  saveState(sessionId, state);
  res.json({ sessionId, state });
});

app.get("/sessions/:id", (req, res) => {
  const state = getState(req.params.id);
  if (!state) return res.status(404).json({ error: "Session not found" });
  res.json({ sessionId: req.params.id, state });
});

app.post("/sessions/:id/events", async (req, res) => {
  const sessionId = req.params.id;
  const state = getState(sessionId);
  if (!state) return res.status(404).json({ error: "Session not found" });

  const { type, payload } = req.body || {};
  if (!type) return res.status(400).json({ error: "Missing type" });

  try {
    logEvent(sessionId, type, payload);

    const newState = applyEvent({ ...state }, type, payload || {});
    saveState(sessionId, newState);
    broadcast(sessionId, { type: "STATE_UPDATED", state: newState });

    // =========================
    // NEW: Trigger OBS when event says so
    // =========================
    if (type === "OBS_SWITCH_SCENE2") {
      // fire-and-forget (do not block game)
      // setObsScene(OBS_SCENE_2_NAME)
      //   .then(() => console.log(`🎬 OBS switched to: ${OBS_SCENE_2_NAME}`))
      //   .catch((err) => console.log("⚠️ OBS scene switch failed:", err?.message || err));


      if (type === "OBS_SWITCH_SCENE2") {
        // Example: also hide SOLEIL
        hideSoleilInScene3().catch(err =>
          console.error("OBS error:", err.message)
        );
      }
    }

    res.json({ ok: true, state: newState });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/sessions", (req, res) => {
  const rows = db
    .prepare("SELECT id, updated_at, state_json FROM sessions ORDER BY updated_at DESC LIMIT 50")
    .all()
    .map(r => ({
      sessionId: r.id,
      updatedAt: r.updated_at,
      state: JSON.parse(r.state_json)
    }));

  res.json({ sessions: rows });
});

server.listen(3000, "0.0.0.0", () => {
  console.log("Game Brain running on http://0.0.0.0:3000");
  console.log("WS: ws://<server-ip>:3000/ws?sessionId=<id>&device=<pr|pa|f|rpi>");
  console.log("OBS: POST http://<server-ip>:3000/obs/scene  { sceneName }");
});