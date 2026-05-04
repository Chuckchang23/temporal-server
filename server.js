require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
const Database = require("better-sqlite3");

const obsCtl = require("./obs");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const db = new Database("game.db");

const now = () => Date.now();

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// =========================
// DB INIT
// =========================
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

CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, ts);
`);

// =========================
// STATE
// =========================
function defaultState() {
  return {
    artifact: null,
    path: [],
    sequence_index: 0,
    timeline_open: "PR",
    puzzles: {
      pr: { stage: 0 },
      pa: { stage: 0, inbox: [] },
      f: { stage: 0 },
    },
    system: {
      started: false,
      started_at: null,
      panic_unlock: false,
      panic_unlock_at: null,
    },
    last_event: null,
  };
}

function normalizeState(state) {
  if (!state || typeof state !== "object") state = defaultState();

  state.puzzles = state.puzzles || {};
  state.puzzles.pr = state.puzzles.pr || { stage: 0 };
  state.puzzles.pa = state.puzzles.pa || { stage: 0, inbox: [] };
  state.puzzles.pa.inbox = state.puzzles.pa.inbox || [];
  state.puzzles.f = state.puzzles.f || { stage: 0 };

  state.system = state.system || {
    started: false,
    started_at: null,
    panic_unlock: false,
    panic_unlock_at: null,
  };

  if (!Array.isArray(state.path)) state.path = [];
  if (typeof state.sequence_index !== "number") state.sequence_index = 0;
  if (!state.timeline_open) state.timeline_open = "PR";
  if (state.last_event === undefined) state.last_event = null;

  return state;
}

function getState(sessionId) {
  const row = db.prepare("SELECT state_json FROM sessions WHERE id=?").get(sessionId);
  if (!row) return null;
  return normalizeState(JSON.parse(row.state_json));
}

function saveState(sessionId, state) {
  db.prepare(`
    INSERT INTO sessions (id, state_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      state_json=excluded.state_json,
      updated_at=excluded.updated_at
  `).run(sessionId, JSON.stringify(normalizeState(state)), now());
}

function logEvent(sessionId, type, payload) {
  db.prepare(`
    INSERT INTO events (session_id, type, payload_json, ts)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, type, JSON.stringify(payload || {}), now());
}

function pathForArtifact(artifact) {
  if (artifact === "watch") return ["PR", "PA", "PR", "F", "PR", "PA", "F"];
  if (artifact === "compass") return ["PR", "F", "PR", "PA", "PR", "F", "PA"];
  if (artifact === "letter") return ["PR", "PA", "F", "PR", "F", "PA", "PR"];
  return ["PR"];
}

function applyEvent(state, type, payload = {}) {
  state = normalizeState(state);
  state.last_event = { type, payload, ts: now() };

  switch (type) {
    case "START_GAME": {
      state.system.started = true;
      state.system.started_at = now();
      return state;
    }

    case "RESET_SESSION": {
      return defaultState();
    }

    case "PANIC_UNLOCK": {
      state.system.panic_unlock = true;
      state.system.panic_unlock_at = now();
      return state;
    }

    case "CLEAR_PANIC": {
      state.system.panic_unlock = false;
      return state;
    }

    case "ARTIFACT_SELECTED": {
      const { artifact } = payload;
      if (!["watch", "compass", "letter"].includes(artifact)) {
        throw new Error("Invalid artifact");
      }

      state.artifact = artifact;
      state.path = pathForArtifact(artifact);
      state.sequence_index = 0;
      state.timeline_open = state.path[0] || "PR";
      return state;
    }

    case "PR_SET_NEXT_YEAR": {
      state.sequence_index = Math.min(state.sequence_index + 1, state.path.length - 1);
      state.timeline_open = state.path[state.sequence_index] || state.timeline_open;
      return state;
    }

    case "PA_ANSWER_CORRECT": {
      state.puzzles.pa.stage += 1;
      state.sequence_index = Math.min(state.sequence_index + 1, state.path.length - 1);
      state.timeline_open = state.path[state.sequence_index] || state.timeline_open;
      return state;
    }

    case "FUTURE_SENT_MESSAGE_TO_PAST": {
      const msg = payload.message || "Message from the future…";
      state.puzzles.pa.inbox.push({ id: `msg_${now()}`, message: msg });
      return state;
    }

    case "OBS_SWITCH_SCENE2": {
      state.puzzles.pr.last_obs_scene = "OBS_SWITCH_SCENE2";
      return state;
    }

    default:
      return state;
  }
}

// =========================
// WEBSOCKET
// =========================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
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
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) rooms.delete(sessionId);
  });
});

// =========================
// OBS HANDLER
// =========================
async function handleObsEvent(type, payload = {}) {
  switch (type) {
    case "GO_ELEVATOR":
      return obsCtl.goElevator();

    case "GO_OPENING":
      return obsCtl.goOpening();

    case "GO_CONTROL":
      return obsCtl.goControl();

    case "GO_PORTAL":
      return obsCtl.goPortal();

    case "GO_MINECRAFT":
      return obsCtl.goMinecraft();

    case "GO_MIRROR":
      return obsCtl.goMirror();

    case "GO_TRON":
      return obsCtl.goTron();

    case "SHOW_MIRROR_CONTROL":
      return obsCtl.showMirrorWallControl();

    case "HIDE_MIRROR_CONTROL":
      return obsCtl.hideMirrorWallControl();

    case "SHOW_MIRROR_PANELS":
      return obsCtl.showMirrorPanels();

    case "HIDE_MIRROR_PANELS":
      return obsCtl.hideMirrorPanels();

    case "SHOW_MINECRAFT_CHECKLIST":
      return obsCtl.showMinecraftChecklist();

    case "HIDE_MINECRAFT_CHECKLIST":
      return obsCtl.hideMinecraftChecklist();

    case "OBS_SET_SOURCE_VISIBLE": {
      const { sceneName, sourceName, visible } = payload;
      if (!sceneName || !sourceName || typeof visible !== "boolean") {
        throw new Error("sceneName, sourceName, and visible:boolean required");
      }
      return obsCtl.setSourceVisible(sceneName, sourceName, visible);
    }

    case "OBS_TOGGLE_SOURCE": {
      const { sceneName, sourceName } = payload;
      if (!sceneName || !sourceName) {
        throw new Error("sceneName and sourceName required");
      }
      return obsCtl.toggleSourceVisible(sceneName, sourceName);
    }

    case "OBS_SWITCH_SCENE2":
      // Legacy keypad event.
      // Adjust this behavior as needed.
      return obsCtl.goMirror();

    default:
      return null;
  }
}

// =========================
// HEALTH
// =========================
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: now() });
});

// =========================
// OBS REST API
// =========================
app.get("/obs/health", async (req, res) => {
  try {
    await obsCtl.connectOBS();
    res.json({ ok: true, scenes: obsCtl.SCENES });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/obs/scene", async (req, res) => {
  const { sceneName } = req.body || {};
  if (!sceneName) return res.status(400).json({ error: "sceneName required" });

  try {
    await obsCtl.switchScene(sceneName);
    res.json({ ok: true, sceneName });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/obs/action", async (req, res) => {
  const { type, payload } = req.body || {};
  if (!type) return res.status(400).json({ error: "type required" });

  try {
    await handleObsEvent(type, payload || {});
    res.json({ ok: true, type, payload: payload || {} });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// SESSION API
// =========================
app.post("/sessions", (req, res) => {
  const sessionId = req.body.sessionId || `S${Math.random().toString(16).slice(2, 8)}`;
  const state = defaultState();
  saveState(sessionId, state);
  res.json({ sessionId, state });
});

app.get("/sessions", (req, res) => {
  const rows = db
    .prepare("SELECT id, updated_at, state_json FROM sessions ORDER BY updated_at DESC LIMIT 50")
    .all()
    .map((r) => {
      let parsed = null;
      try {
        parsed = normalizeState(JSON.parse(r.state_json));
      } catch (e) {
        console.error("Bad JSON in session:", r.id);
      }

      return {
        sessionId: r.id,
        updatedAt: r.updated_at,
        state: parsed,
      };
    });

  res.json({ sessions: rows });
});

app.get("/sessions/:id", (req, res) => {
  const state = getState(req.params.id);
  if (!state) return res.status(404).json({ error: "Session not found" });
  res.json({ sessionId: req.params.id, state });
});

app.get("/sessions/:id/events", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 1000);

  const rows = db
    .prepare(`
      SELECT id, type, payload_json, ts
      FROM events
      WHERE session_id=?
      ORDER BY ts DESC
      LIMIT ?
    `)
    .all(req.params.id, limit)
    .map((r) => ({
      id: r.id,
      type: r.type,
      ts: r.ts,
      payload: JSON.parse(r.payload_json || "{}"),
    }));

  res.json({ sessionId: req.params.id, events: rows });
});

app.post("/sessions/:id/events", async (req, res) => {
  const sessionId = req.params.id;
  const state = getState(sessionId);
  if (!state) return res.status(404).json({ error: "Session not found" });

  const { type, payload } = req.body || {};
  if (!type) return res.status(400).json({ error: "Missing type" });

  try {
    logEvent(sessionId, type, payload || {});

    const newState = applyEvent(deepClone(state), type, payload || {});
    saveState(sessionId, newState);
    broadcast(sessionId, { type: "STATE_UPDATED", state: newState });

    // Fire OBS actions without blocking the game API response
    handleObsEvent(type, payload || {}).catch((err) => {
      console.error("OBS action failed:", err.message);
    });

    res.json({ ok: true, state: newState });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// =========================
// ADMIN QUICK ACTIONS
// =========================
function applyAndPersist(sessionId, type, payload = {}) {
  const state = getState(sessionId);
  if (!state) throw new Error("Session not found");

  logEvent(sessionId, type, payload);
  const newState = applyEvent(deepClone(state), type, payload);
  saveState(sessionId, newState);
  broadcast(sessionId, { type: "STATE_UPDATED", state: newState });
  return newState;
}

app.post("/sessions/:id/admin/start", (req, res) => {
  try {
    const state = applyAndPersist(req.params.id, "START_GAME", {});
    res.json({ ok: true, state });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/sessions/:id/admin/reset", (req, res) => {
  try {
    const state = applyAndPersist(req.params.id, "RESET_SESSION", {});
    res.json({ ok: true, state });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/sessions/:id/admin/panic", (req, res) => {
  try {
    const sessionId = req.params.id;
    const state = applyAndPersist(sessionId, "PANIC_UNLOCK", {});
    res.json({ ok: true, state });

    setTimeout(() => {
      try {
        applyAndPersist(sessionId, "CLEAR_PANIC", {});
      } catch {}
    }, parseInt(process.env.AUTO_CLEAR_PANIC_MS || "10000", 10));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// =========================
// ESP32 DIORAMA PROXY
// =========================
const ESP32_HOST = process.env.ESP32_HOST || "http://ttdiorama.local";

const VALID_MODES = new Set(["watch", "letter", "compass", "stop", "none"]);
const VALID_AUX = new Set(["botshelf", "midshelf", "up", "down", "stopaux"]);

function proxyToESP32(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, ESP32_HOST);
    const postData = body;

    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const req = http.request(options, (espRes) => {
      espRes.resume();
      resolve({ status: espRes.statusCode });
    });

    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("ESP32 request timed out"));
    });

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

app.post("/diorama/mode", async (req, res) => {
  const { artifact } = req.body || {};

  if (!artifact || !VALID_MODES.has(artifact)) {
    return res.status(400).json({
      ok: false,
      error: `artifact must be one of: ${[...VALID_MODES].join(", ")}`,
    });
  }

  try {
    await proxyToESP32("/mode", `artifact=${encodeURIComponent(artifact)}`);
    res.json({ ok: true, artifact });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post("/diorama/aux", async (req, res) => {
  const { action } = req.body || {};

  if (!action || !VALID_AUX.has(action)) {
    return res.status(400).json({
      ok: false,
      error: `action must be one of: ${[...VALID_AUX].join(", ")}`,
    });
  }

  try {
    await proxyToESP32("/aux", `action=${encodeURIComponent(action)}`);
    res.json({ ok: true, action });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ESP32 can poll this
app.get("/sessions/:id/minecraftmap", (req, res) => {
  const state = getState(req.params.id);
  if (!state) return res.status(404).json({ error: "Session not found" });

  res.json({
    ok: true,
    sessionId: req.params.id,
    artifact: state.artifact,
    active: !!state.artifact,
    timeline_open: state.timeline_open,
    sequence_index: state.sequence_index,
    puzzles: {
      pr: state.puzzles.pr.stage,
      pa: state.puzzles.pa.stage,
      f: state.puzzles.f.stage,
      pa_inbox_count: state.puzzles.pa.inbox.length,
    },
    last_event: state.last_event,
    ts: now(),
  });
});

// =========================
// START SERVER
// =========================
app.listen(3000, "0.0.0.0", () => {
  console.log("Server running on port 3000");
});