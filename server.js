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

// Railway / HTTPS cookies
app.set("trust proxy", 1);
const IS_PROD = process.env.NODE_ENV === "production";

// Writable DB location on Railway
const DB_FILE = process.env.DB_FILE || path.join("/tmp", "db.json");

// ===== MIDDLEWARE =====
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
      secure: IS_PROD
    }
  })
);

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// ===== JSON DB HELPERS =====
function ensureDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify(
        { users: [], stations: [], events: [], feedback: [], rewardsCatalog: [] },
        null,
        2
      )
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

// Ensure rewards catalog exists
function ensureRewardsCatalog(db) {
  if (!Array.isArray(db.rewardsCatalog) || db.rewardsCatalog.length === 0) {
    db.rewardsCatalog = [
      { id: "r1", name: "5% Discount Coupon", cost: 50, partner: "Local Partner" },
      { id: "r2", name: "10% Discount Coupon", cost: 100, partner: "Local Partner" },
      { id: "r3", name: "Free Coffee Coupon", cost: 150, partner: "Cafe Partner" }
    ];
  }
  return db;
}

// ===== AUTH HELPERS =====
function requireResident(req, res, next) {
  if (req.session?.user?.id) return next();
  return res.status(401).json({ ok: false, error: "RESIDENT_NOT_LOGGED_IN" });
}

function requireAuthority(req, res, next) {
  if (req.session?.authority === true) return next();
  return res.status(401).json({ ok: false, error: "AUTHORITY_NOT_LOGGED_IN" });
}

// ===== AUTH API =====
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ ok: false, error: "Missing name/email/password" });
  }

  const db = ensureRewardsCatalog(readDB());
  const e = String(email).toLowerCase().trim();

  if (db.users.find((u) => u.email === e)) {
    return res.status(409).json({ ok: false, error: "Email already registered" });
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

  db.users.push(user);
  writeDB(db);

  req.session.user = { id: user.id, name: user.name, email: user.email };
  res.json({ ok: true, user: req.session.user });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: "Missing email/password" });
  }

  const db = ensureRewardsCatalog(readDB());
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

  if (password !== AUTHORITY_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Wrong password" });
  }

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
    s = {
      id,
      name: p.name || `Station ${id}`,
      lat: typeof p.lat === "number" ? p.lat : 0,
      lng: typeof p.lng === "number" ? p.lng : 0,
      createdAt: new Date().toISOString()
    };
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
  s.odorAlert = false;
  s.lastEmptiedAt = new Date().toISOString();
  writeDB(db);

  res.json({ ok: true, station: s });
});

// ===== FEEDBACK API =====
app.post("/api/v1/feedback", requireResident, (req, res) => {
  const { stationId, issueType, note } = req.body || {};

  if (!issueType) {
    return res.status(400).json({ ok: false, error: "Missing issueType" });
  }

  const db = readDB();
  db.feedback.push({
    id: "f_" + Date.now(),
    userId: req.session.user.id,
    stationId: stationId || null,
    issueType,
    note: note || "",
    createdAt: new Date().toISOString()
  });
  writeDB(db);

  res.json({ ok: true });
});

// ===== REWARDS API =====

// Current points balance
app.get("/api/rewards/balance", requireResident, (req, res) => {
  const db = readDB();
  const user = db.users.find((u) => u.id === req.session.user.id);
  if (!user) return res.status(404).json({ ok: false, error: "User not found" });
  res.json({ ok: true, points: user.points || 0 });
});

// Anti-abuse: 1 scan per station per hour per user
function scannedRecently(events, userId, stationId, windowMs) {
  const now = Date.now();
  // Find any scan in the last windowMs
  return events.some((e) => {
    if (e.type !== "reward_scan") return false;
    if (e.userId !== userId) return false;
    if (e.stationId !== stationId) return false;
    const t = new Date(e.createdAt).getTime();
    return now - t < windowMs;
  });
}

// QR scan (stationId from QR text)
app.post("/api/rewards/scan", requireResident, (req, res) => {
  const { stationId } = req.body || {};
  if (!stationId) return res.status(400).json({ ok: false, error: "Missing stationId" });

  const db = readDB();
  const user = db.users.find((u) => u.id === req.session.user.id);
  if (!user) return res.status(404).json({ ok: false, error: "User not found" });

  const stationExists = (db.stations || []).some((s) => s.id === stationId);
  if (!stationExists) {
    return res.status(400).json({ ok: false, error: "Invalid stationId" });
  }

  // 1 hour window
  const WINDOW_MS = 60 * 60 * 1000;
  if (scannedRecently(db.events || [], user.id, stationId, WINDOW_MS)) {
    return res.status(429).json({
      ok: false,
      error: "You already scanned this station in the last hour."
    });
  }

  const pointsEarned = 10;
  user.points = (user.points || 0) + pointsEarned;

  db.events.push({
    id: "e_" + Date.now(),
    type: "reward_scan",
    userId: user.id,
    stationId,
    points: pointsEarned,
    createdAt: new Date().toISOString()
  });

  writeDB(db);
  res.json({ ok: true, newBalance: user.points, added: pointsEarned });
});

// Reward history (scans + redeems)
app.get("/api/rewards/history", requireResident, (req, res) => {
  const db = readDB();
  const history = (db.events || [])
    .filter((e) => e.userId === req.session.user.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  res.json({ ok: true, history });
});

// Leaderboard (Top 10)
app.get("/api/rewards/leaderboard", (req, res) => {
  const db = readDB();
  const leaderboard = (db.users || [])
    .slice()
    .sort((a, b) => (b.points || 0) - (a.points || 0))
    .slice(0, 10)
    .map((u) => ({ name: u.name, points: u.points || 0 }));

  res.json({ ok: true, leaderboard });
});

// Rewards catalog
app.get("/api/rewards/catalog", (req, res) => {
  const db = ensureRewardsCatalog(readDB());
  writeDB(db);
  res.json({ ok: true, catalog: db.rewardsCatalog });
});

// Redeem reward by rewardId
app.post("/api/rewards/redeem", requireResident, (req, res) => {
  const { rewardId } = req.body || {};
  if (!rewardId) return res.status(400).json({ ok: false, error: "Missing rewardId" });

  const db = ensureRewardsCatalog(readDB());
  const user = db.users.find((u) => u.id === req.session.user.id);
  if (!user) return res.status(404).json({ ok: false, error: "User not found" });

  const reward = (db.rewardsCatalog || []).find((r) => r.id === rewardId);
  if (!reward) return res.status(404).json({ ok: false, error: "Reward not found" });

  const cost = Number(reward.cost) || 0;
  if ((user.points || 0) < cost) {
    return res.status(400).json({ ok: false, error: "Not enough points" });
  }

  user.points -= cost;

  // simple coupon code
  const coupon = "SB-" + Math.random().toString(36).slice(2, 8).toUpperCase();

  db.events.push({
    id: "e_" + Date.now(),
    type: "reward_redeem",
    userId: user.id,
    rewardId: reward.id,
    rewardName: reward.name,
    partner: reward.partner,
    points: -cost,
    coupon,
    createdAt: new Date().toISOString()
  });

  writeDB(db);

  res.json({
    ok: true,
    newBalance: user.points,
    coupon,
    reward
  });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));