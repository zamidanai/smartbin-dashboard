const express = require("express");
const cors = require("cors");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");

const app = express();

// ===== CONFIG =====
const PORT = process.env.PORT || 8080;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev_secret_change_me";
const AUTHORITY_PASSWORD = process.env.AUTHORITY_PASSWORD || "smartbinaccess";

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: false }
  })
);

app.use(express.static(path.join(__dirname, "public")));

// ===== JSON DB =====
const DB_FILE = path.join(__dirname, "db.json");

function ensureDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify({ users: [], stations: [], events: [], feedback: [] }, null, 2)
    );
  }
}

function readDB() {
  ensureDB();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ===== AUTH HELPERS =====
function requireAuthority(req, res, next) {
  if (req.session?.authority === true) return next();
  return res.status(401).json({ ok: false, error: "AUTHORITY_NOT_LOGGED_IN" });
}

// ===== AUTH API =====
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password)
    return res.status(400).json({ ok: false, error: "Missing name/email/password" });

  const db = readDB();
  const e = String(email).toLowerCase().trim();

  if (db.users.find((u) => u.email === e))
    return res.status(409).json({ ok: false, error: "Email already registered" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: "u_" + Date.now(),
    name: String(name).trim(),
    email: e,
    passwordHash,
    points: 0,
    createdAt: new Date().toISOString()
  };

  db.users.push(user);
  writeDB(db);

  req.session.user = { id: user.id, name: user.name, email: user.email };
  res.json({ ok: true, user: req.session.user });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ ok: false, error: "Missing email/password" });

  const db = readDB();
  const e = String(email).toLowerCase().trim();
  const user = db.users.find((u) => u.email === e);
  if (!user) return res.status(401).json({ ok: false, error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });

  req.session.user = { id: user.id, name: user.name, email: user.email };
  res.json({ ok: true, user: req.session.user });
});

app.post("/api/auth/authority-login", (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ ok: false, error: "Missing password" });
  if (password !== AUTHORITY_PASSWORD)
    return res.status(401).json({ ok: false, error: "Wrong password" });

  req.session.authority = true;
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/auth/me", (req, res) => {
  res.json({
    ok: true,
    resident: req.session?.user || null,
    authority: req.session?.authority === true
  });
});

// ===== PAGE GUARDS =====
app.get("/resident", (req, res) => {
  if (!req.session?.user?.id) return res.redirect("/resident-login.html");
  res.sendFile(path.join(__dirname, "public", "resident.html"));
});

app.get("/authority", (req, res) => {
  if (req.session?.authority !== true) return res.redirect("/authority-login.html");
  res.sendFile(path.join(__dirname, "public", "authority.html"));
});

// ===== STATIONS API =====
app.get("/api/v1/stations", (req, res) => {
  const db = readDB();
  res.json({ ok: true, stations: db.stations || [] });
});

app.post("/api/v1/stations/:id/telemetry", (req, res) => {
  const db = readDB();
  const id = req.params.id;
  const p = req.body || {};

  let s = (db.stations || []).find((x) => x.id === id);
  if (!s) {
    s = { id, name: p.name || `Station ${id}`, lat: p.lat || 0, lng: p.lng || 0, createdAt: new Date().toISOString() };
    db.stations.push(s);
  }

  if (typeof p.fillPct === "number") s.fillPct = Math.max(0, Math.min(100, p.fillPct));
  if (typeof p.odorAlert !== "undefined") s.odorAlert = !!p.odorAlert;
  if (typeof p.hatchOpen !== "undefined") s.hatchOpen = !!p.hatchOpen;
  if (typeof p.locked !== "undefined") s.locked = !!p.locked;

  s.lastSeen = new Date().toISOString();
  writeDB(db);
  res.json({ ok: true, station: s });
});

app.post("/api/v1/stations/:id/mark-emptied", requireAuthority, (req, res) => {
  const db = readDB();
  const s = (db.stations || []).find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: "Station not found" });

  s.fillPct = 0;
  s.locked = false;
  s.lastEmptiedAt = new Date().toISOString();
  writeDB(db);

  res.json({ ok: true, station: s });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));