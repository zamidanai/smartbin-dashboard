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

app.set("trust proxy", 1);
const IS_PROD = process.env.NODE_ENV === "production";
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

app.use(express.static(path.join(__dirname, "public")));

// ===== DB =====
function ensureDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      users: [],
      stations: [],
      events: [],
      feedback: [],
      rewardsCatalog: []
    }, null, 2));
  }
}

function readDB() {
  ensureDB();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ===== AUTH =====
function requireResident(req, res, next) {
  if (req.session?.user?.id) return next();
  return res.status(401).json({ ok:false });
}

function requireAuthority(req, res, next) {
  if (req.session?.authority) return next();
  return res.status(401).json({ ok:false });
}

app.post("/api/auth/authority-login",(req,res)=>{
  if(req.body.password===AUTHORITY_PASSWORD){
    req.session.authority=true;
    res.json({ok:true});
  } else {
    res.status(401).json({ok:false});
  }
});

app.post("/api/auth/logout",(req,res)=>{
  req.session.destroy(()=>res.json({ok:true}));
});

// ===== STATIONS =====
app.get("/api/v1/stations",(req,res)=>{
  const db=readDB();
  res.json({ok:true,stations:db.stations||[]});
});

app.post("/api/v1/stations/:id/mark-emptied",requireAuthority,(req,res)=>{
  const db=readDB();
  const s=db.stations.find(x=>x.id===req.params.id);
  if(!s) return res.status(404).json({ok:false});
  s.fillPct=0;
  s.locked=false;
  s.odorAlert=false;
  s.lastEmptiedAt=new Date().toISOString();
  writeDB(db);
  res.json({ok:true});
});

// ===== SIMULATION ENGINE =====
let simulationOn=false;

function simulateOverflow(){
  if(!simulationOn) return;
  const db=readDB();

  db.stations.forEach((s,i)=>{
    const wave=2+Math.sin(Date.now()/4000+i)*2;
    if(typeof s.fillPct!=="number") s.fillPct=0;

    s.fillPct+=wave;

    if(s.fillPct>=80) s.odorAlert=true;
    if(s.fillPct>=95){
      s.fillPct=100;
      s.locked=true;
    }

    s.lastSeen=new Date().toISOString();
  });

  writeDB(db);
}

setInterval(simulateOverflow,5000);

app.post("/api/simulation/start",(req,res)=>{
  simulationOn=true;
  res.json({ok:true});
});

app.post("/api/simulation/stop",(req,res)=>{
  simulationOn=false;
  res.json({ok:true});
});

app.listen(PORT,()=>console.log("Server running on",PORT));