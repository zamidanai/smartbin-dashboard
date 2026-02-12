// server.js
// SmartBin backend: auth (residents + authority) + stations storage

const express = require("express");
const cors = require("cors");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const { LowSync } = require("lowdb");
const { JSONFileSync } = require("lowdb/node");
const { nanoid } = require("nanoid");

const app = express();

// ---------- CONFIG ----------
const PORT = process.env.PORT || 8080;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev_secret_change_me";
const AUTHORITY_PASSWORD =
  process.env.AUTHORITY_PASSWORD || "smartbinaccess";

const DB_FILE = path.join(__dirname, "db.json");
const defaultData = {
  stations: [],
  users: [],
  events: [],
  feedback: []
};

// ---------- DB (lowdb) ----------
const adapter = new JSONFileSync(DB_FILE);
const db = new LowSync(adapter, defaultData);
db.read();
if (!db.data) db.data = defaultData;

function saveDB() {
  db.write();
}

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false // ok for now; you can switch to true+trust proxy later
    }
  })
);

// Static files
app.use(express.static(path.join(__dirname, "public")));

// ---------- AUTH HELPERS ----------
function requireAuthority(req, res, next) {
  if (req.session?.authority === true) return next();
  return res.status(401).json({ ok: false, error: "AUTHORITY_NOT_LOGGED_IN" });
}

// ---------- AUTH ROUTES ----------

// Resident register
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing name/email/password" });
  }

  const e = String(email).toLowerCase().trim();
  const dbData = db.data;

  const existing = dbData.users.find((u) => u.email === e);
  if (existing) {
    return res
      .status(409)
      .json({ ok: false, error: "Email already registered" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: "u_" + Date.now(),
    name: String(name).trim(),
    email: e,
    passwordHash,
    points: 0,
    createdAt: new Date().toISOString()
  };

  dbData.users.push(user);
  saveDB();

  req.session.user = { id: user.id, name: user.name, email: user.email };
  res.json({ ok: true, user: req.session.user });
});

// Resident login
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing email/password" });
  }

  const e = String(email).toLowerCase().trim();
  const dbData = db.data;
  const user = dbData.users.find((u) => u.email === e);
  if (!user) {
    return res.status(401).json({ ok: false, error: "Invalid credentials" });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ ok: false, error: "Invalid credentials" });
  }

  req.session.user = { id: user.id, name: user.name, email: user.email };
  res.json({ ok: true, user: req.session.user });
});

// Authority login (password only)
app.post("/api/auth/authority-login", (req, res) => {
  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ ok: false, error: "Missing password" });
  }
  if (password !== AUTHORITY_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Wrong password" });
  }

  req.session.authority = true;
  res.json({ ok: true });
});

// Logout for both
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Who am I (optional debug)
app.get("/api/auth/me", (req, res) => {
  res.json({
    ok: true,
    resident: req.session?.user || null,
    authority: req.session?.authority === true
  });
});

// ---------- PAGE GUARDS ----------

app.get("/resident", (req, res) => {
  if (!req.session?.user?.id) return res.redirect("/resident-login.html");
  res.sendFile(path.join(__dirname, "public", "resident.html"));
});

app.get("/authority", (req, res) => {
  if (req.session?.authority !== true)
    return res.redirect("/authority-login.html");
  res.sendFile(path.join(__dirname, "public", "authority.html"));
});

// ---------- STATION API (keeps your ESP/dashboard working) ----------

// List stations (used by dashboards)
app.get("/api/v1/stations", (req, res) => {
  res.json({ ok: true, stations: db.data.stations || [] });
});

// ESP32 (or simulator) sends telemetry for a station
// Body example: { name, lat, lng, fillPct, odorAlert, hatchOpen, locked }
app.post("/api/v1/stations/:id/telemetry", (req, res) => {
  const { id } = req.params;
  const payload = req.body || {};
  const dbData = db.data;

  let station = dbData.stations.find((s) => s.id === id);
  if (!station) {
    station = {
      id,
      code: id.toUpperCase(),
      name: payload.name || `Station ${id}`,
      lat: payload.lat || 0,
      lng: payload.lng || 0,
      createdAt: new Date().toISOString()
    };
    dbData.stations.push(station);
  }

  station.fillPct =
    typeof payload.fillPct === "number"
      ? Math.max(0, Math.min(100, payload.fillPct))
      : station.fillPct || 0;
  station.odorAlert = !!payload.odorAlert;
  station.hatchOpen = !!payload.hatchOpen;
  station.locked = !!payload.locked;
  station.lastSeen = new Date().toISOString();

  saveDB();
  res.json({ ok: true, station });
});

// Authority marks station emptied (example action)
app.post("/api/v1/stations/:id/mark-emptied", requireAuthority, (req, res) => {
  const dbData = db.data;
  const station = dbData.stations.find((s) => s.id === req.params.id);
  if (!station)
    return res.status(404).json({ ok: false, error: "Station not found" });

  station.fillPct = 0;
  station.locked = false;
  station.lastEmptiedAt = new Date().toISOString();
  saveDB();

  res.json({ ok: true, station });
});

// Feedback endpoint placeholder (for Report / Feedback tab later)
app.post("/api/v1/feedback", (req, res) => {
  const { stationId, issueType, note } = req.body || {};
  const item = {
    id: nanoid(),
    stationId: stationId || null,
    issueType: issueType || "other",
    note: note || "",
    createdAt: new Date().toISOString()
  };
  db.data.feedback.push(item);
  saveDB();
  res.json({ ok: true, feedback: item });
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});