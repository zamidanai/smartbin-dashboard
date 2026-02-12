const express = require("express");
const cors = require("cors");
const { Low } = require("lowdb");
const { JSONFile } = require("lowdb/node");
const { nanoid } = require("nanoid");

const app = express();
app.use(cors());
app.use(express.json());

// ===== SETTINGS =====
const ADMIN_CODE = process.env.ADMIN_CODE || "1234";
const UNLOCK_DURATION_SEC = 120;
const COMMAND_TTL_SEC = 180;

// ===== DB (JSON file) =====
const adapter = new JSONFile("./db.json");
const db = new Low(adapter, { stations: {}, commands: {} });

async function initDb() {
  await db.read();
  db.data ||= { stations: {}, commands: {} };

  db.data.stations["DAM-001"] ||= {
    station_id: "DAM-001",
    name: "Prototype Station",
    lat: 26.4207,
    lng: 50.0888,
    fill_percent: 0,
    is_full: false,
    hatch_state: "CLOSED",
    service_lock_state: "LOCKED",
    odor_alert: false,
    fault_code: 0,
    signal_rssi: null,
    last_seen: null
  };

  await db.write();
}

function secondsSince(ts) {
  if (!ts) return 999999;
  return Math.floor((Date.now() - ts) / 1000);
}

// ESP32 -> Telemetry
app.post("/api/v1/telemetry", async (req, res) => {
  const t = req.body || {};
  if (!t.station_id) return res.status(400).json({ ok: false, error: "station_id required" });

  await db.read();
  db.data ||= { stations: {}, commands: {} };

  const s = db.data.stations[t.station_id] || {
    station_id: t.station_id,
    name: t.station_id,
    lat: 26.4207,
    lng: 50.0888
  };

  s.fill_percent = Number(t.fill_percent ?? 0);
  s.is_full = !!t.is_full;
  s.hatch_state = String(t.hatch_state ?? "CLOSED");
  s.service_lock_state = String(t.service_lock_state ?? "LOCKED");
  s.odor_alert = !!t.odor_alert;
  s.fault_code = Number(t.fault_code ?? 0);
  s.signal_rssi = (t.signal_rssi ?? null);
  s.last_seen = Date.now();

  db.data.stations[t.station_id] = s;
  await db.write();

  res.json({ ok: true });
});

// Website -> Stations list
app.get("/api/v1/stations", async (req, res) => {
  await db.read();
  const stations = Object.values(db.data.stations || {}).map(s => ({
    ...s,
    seconds_since_seen: secondsSince(s.last_seen),
    last_seen: s.last_seen ? new Date(s.last_seen).toISOString() : null
  }));
  res.json(stations);
});

// Website -> Unlock (queues command)
app.post("/api/v1/stations/:id/unlock", async (req, res) => {
  const stationId = req.params.id;
  const code = String(req.body?.code ?? "");

  if (code !== ADMIN_CODE) {
    return res.status(403).json({ ok: false, error: "Invalid code" });
  }

  await db.read();
  db.data ||= { stations: {}, commands: {} };

  const command_id = "cmd_" + nanoid(10);
  const now = Date.now();

  db.data.commands[command_id] = {
    command_id,
    station_id: stationId,
    command: "UNLOCK_SERVICE",
    duration_sec: UNLOCK_DURATION_SEC,
    created_at: now,
    expires_at: now + COMMAND_TTL_SEC * 1000,
    status: "PENDING"
  };

  await db.write();
  res.json({ ok: true, message: `Unlock queued for ${UNLOCK_DURATION_SEC}s.`, command_id });
});

// ESP32 -> Poll commands
app.get("/api/v1/commands/poll", async (req, res) => {
  const stationId = String(req.query.station_id ?? "");
  if (!stationId) return res.status(400).json({ ok: false, error: "station_id required" });

  await db.read();
  db.data ||= { stations: {}, commands: {} };

  const now = Date.now();
  const cmds = Object.values(db.data.commands || {})
    .filter(c => c.station_id === stationId && c.status === "PENDING" && c.expires_at > now)
    .sort((a, b) => a.created_at - b.created_at);

  if (cmds.length === 0) return res.json({ ok: true, command: "NONE" });

  const cmd = cmds[0];
  cmd.status = "SENT";
  db.data.commands[cmd.command_id] = cmd;
  await db.write();

  res.json({ ok: true, command: cmd.command, duration_sec: cmd.duration_sec, command_id: cmd.command_id });
});

// ESP32 -> Ack
app.post("/api/v1/commands/ack", async (req, res) => {
  const { station_id, command_id, status } = req.body || {};
  if (!station_id || !command_id) return res.status(400).json({ ok: false, error: "station_id and command_id required" });

  await db.read();
  db.data ||= { stations: {}, commands: {} };

  const cmd = db.data.commands?.[command_id];
  if (cmd && cmd.station_id === station_id) {
    cmd.status = String(status ?? "DONE");
    db.data.commands[command_id] = cmd;
    await db.write();
  }

  res.json({ ok: true });
});

// Serve Website
app.use("/", express.static("./public"));

initDb().then(() => {
  const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

});
