// tanksfornothing-server.js
// Summary: Entry point server for Tanks for Nothing, a minimal blocky multiplayer tank game.
// This script sets up an Express web server with Socket.IO for real-time tank and projectile
// updates, handles image uploads for ammo types, stores flag emojis for nations,
// persists admin-defined tanks, nations and terrain details (including capture-the-flag positions)
// to disk and enforces Battle Rating constraints when players join. Tank definitions
// now also store an ammoCapacity value to limit carried rounds and the server
// tracks turret and gun orientation so remote players render complete cannons
// and projectiles spawn from the muzzle using that orientation and arc under gravity.
// Structure: configuration -> express setup -> socket handlers -> in-memory stores ->
//            persistence helpers -> projectile physics loop -> server start.
// Usage: Run with `node tanksfornothing-server.js` or `npm start`. Set PORT env to change port.
// ---------------------------------------------------------------------------

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cookieParser from 'cookie-parser';
import { promises as fs } from 'fs';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookie from 'cookie';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateGentleHills } from './utils/terrain-noise.js';

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

// Configuration
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'adminpass';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadBase = path.join(__dirname, 'public', 'uploads');
const ammoDir = path.join(uploadBase, 'ammo');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdir(ammoDir, { recursive: true }).then(() => cb(null, ammoDir)).catch(cb);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only images allowed'));
    cb(null, true);
  }
});

// In-memory stores (tanks/ammo/terrains persisted to disk)
const players = new Map(); // socket.id -> player state
let tanks = []; // CRUD via admin, loaded from JSON file
let ammo = []; // CRUD via admin, loaded from JSON file
const defaultAmmo = [
  {
    name: 'AP',
    nation: 'Neutral',
    caliber: 40,
    armorPen: 50,
    type: 'AP',
    explosionRadius: 0,
    pen0: 50,
    pen100: 30,
    speed: 900,
    damage: 40,
    penetration: 50,
    explosion: 0
  },
  {
    name: 'HE',
    nation: 'Neutral',
    caliber: 100,
    armorPen: 10,
    type: 'HE',
    explosionRadius: 50,
    pen0: 10,
    pen100: 5,
    speed: 600,
    damage: 20,
    penetration: 10,
    explosion: 50
  }
];
// Active projectile list; each projectile contains position, velocity and metadata
const projectiles = new Map(); // id -> projectile state
// Gravity acceleration applied to shells (m/s^2)
const GRAVITY = -9.81;
// Terrains now include metadata so map listings can show thumbnails and size
function defaultFlags() {
  return {
    red: { a: null, b: null, c: null, d: null },
    blue: { a: null, b: null, c: null, d: null }
  };
}
function sanitizeFlags(f) {
  const res = defaultFlags();
  if (!f) return res;
  ['red', 'blue'].forEach(team => {
    ['a', 'b', 'c', 'd'].forEach(letter => {
      const pos = f?.[team]?.[letter];
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        res[team][letter] = { x: pos.x, y: pos.y };
      }
    });
  });
  return res;
}

function sanitizeGrid(g) {
  if (!Array.isArray(g)) return [];
  return g.map(row =>
    Array.isArray(row) ? row.map(v => (typeof v === 'number' ? v : 0)) : []
  );
}
let terrains = [{
  name: 'Gentle Hills',
  type: 'fields',
  size: { x: 1, y: 1 },
  flags: defaultFlags(),
  ground: Array.from({ length: 20 }, () => Array(20).fill(0)),
  elevation: generateGentleHills(20, 20)
}];
let currentTerrain = 0; // index into terrains
let terrain = 'Gentle Hills'; // currently active terrain name
let baseBR = null; // Battle Rating of first player
// Nations persisted separately; maintain array and Set for validation
let nations = []; // CRUD via admin, loaded from JSON file
let nationsSet = new Set();

// Users persisted to disk for authentication and stat tracking
let users = new Map(); // username -> { passwordHash, stats }

const TANKS_FILE = new URL('./data/tanks.json', import.meta.url);
const NATIONS_FILE = new URL('./data/nations.json', import.meta.url);
const TERRAIN_FILE = new URL('./data/terrains.json', import.meta.url);
const AMMO_FILE = new URL('./data/ammo.json', import.meta.url);
const USERS_FILE = new URL('./data/users.json', import.meta.url);

// Generic JSON helpers with backup handling to guard against corruption
async function safeReadJson(file, defaults) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    console.error(`Failed to read ${file.pathname}:`, err.message);
    const bak = new URL(file.href + '.bak');
    try {
      const backup = await fs.readFile(bak, 'utf8');
      console.warn(`Recovered ${file.pathname} from backup`);
      try {
        await fs.copyFile(bak, file);
      } catch (copyErr) {
        console.warn(`Failed to restore ${file.pathname} from backup:`, copyErr.message);
      }
      return JSON.parse(backup);
    } catch {
      console.warn(`No usable data for ${file.pathname}, using defaults`);
      return defaults;
    }
  }
}

async function safeWriteJson(file, data) {
  const dir = new URL('.', file);
  const tmp = new URL(file.href + '.tmp');
  const bak = new URL(file.href + '.bak');
  await fs.mkdir(dir, { recursive: true });
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(tmp, json);
  try {
    await fs.rename(file, bak);
  } catch (renameErr) {
    // It's acceptable if the original file does not exist yet.
    console.warn(`No original file to backup for ${file.pathname}:`, renameErr.message);
  }
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    console.error(`Failed to write ${file.pathname}:`, err.message);
    try {
      await fs.rename(bak, file);
    } catch (restoreErr) {
      console.error(`Failed to restore backup for ${file.pathname}:`, restoreErr.message);
    }
    throw err;
  }
}

async function loadTanks() {
  const data = await safeReadJson(TANKS_FILE, { tanks: [] });
  if (Array.isArray(data.tanks)) {
    // Only tank destroyers should retain a horizontal traverse limit; all other
    // classes rotate freely so we normalize their value to 0 (meaning unlimited).
    tanks = data.tanks.map(t => ({
      ...t,
      horizontalTraverse: t.class === 'Tank Destroyer' ? t.horizontalTraverse : 0
    }));
  }
}

async function saveTanks() {
  const data = {
    _comment: [
      'Summary: Persisted tank definitions for Tanks for Nothing.',
      'Structure: JSON object with _comment array and tanks list.',
      'Usage: Managed automatically by server; do not edit manually.'
    ],
    tanks
  };
  await safeWriteJson(TANKS_FILE, data);
}

async function loadNations() {
  const data = await safeReadJson(NATIONS_FILE, { nations: [] });
  if (Array.isArray(data.nations)) {
    nations = data.nations.map((n) => ({ name: n.name || n, flag: n.flag || '' }));
    nationsSet = new Set(nations.map((n) => n.name));
  }
}

async function saveNations() {
  const data = {
    _comment: [
      'Summary: Persisted nation definitions for Tanks for Nothing.',
      'Structure: JSON object with _comment array and nations list of {name,flag}.',
      'Usage: Managed automatically by server; do not edit manually.'
    ],
    nations
  };
  await safeWriteJson(NATIONS_FILE, data);
  nationsSet = new Set(nations.map((n) => n.name));
}

async function loadTerrains() {
  const defaults = {
    current: 0,
    terrains: [{
      name: 'Gentle Hills',
      type: 'fields',
      size: { x: 1, y: 1 },
      flags: defaultFlags(),
      ground: Array.from({ length: 20 }, () => Array(20).fill(0)),
      elevation: generateGentleHills(20, 20)
    }]
  };
  const data = await safeReadJson(TERRAIN_FILE, defaults);
  if (Array.isArray(data.terrains)) {
    terrains = data.terrains.map(t => ({
      name: t.name || 'Unnamed',
      type: t.type || 'fields',
      size: t.size || { x: 1, y: 1 },
      flags: sanitizeFlags(t.flags),
      ground: sanitizeGrid(t.ground),
      elevation: sanitizeGrid(t.elevation)
    }));
  }
  if (typeof data.current === 'number') currentTerrain = data.current;
  terrain = terrains[currentTerrain]?.name || 'Gentle Hills';
}

async function saveTerrains() {
  const data = {
    _comment: [
      'Summary: Persisted terrain details and selected index for Tanks for Nothing.',
      'Structure: JSON object with _comment array, current index and terrains list of {name,type,size,flags,ground,elevation}.',
      'Usage: Managed automatically by server; do not edit manually.'
    ],
    current: currentTerrain,
    terrains
  };
  await safeWriteJson(TERRAIN_FILE, data);
}

async function loadAmmo() {
  const data = await safeReadJson(AMMO_FILE, { ammo: defaultAmmo });
  if (Array.isArray(data.ammo)) ammo = data.ammo;
}

async function saveAmmo() {
  const data = {
    _comment: [
      'Summary: Persisted ammunition definitions for Tanks for Nothing.',
      'Structure: JSON object with _comment array and ammo list.',
      'Usage: Managed automatically by server; do not edit manually.'
    ],
    ammo
  };
  await safeWriteJson(AMMO_FILE, data);
}

async function loadUsers() {
  const data = await safeReadJson(USERS_FILE, { users: [] });
  if (Array.isArray(data.users)) {
    users = new Map(
      data.users.map(u => [u.username, { passwordHash: u.passwordHash, stats: u.stats || { games: 0, kills: 0, deaths: 0 } }])
    );
  }
}

async function saveUsers() {
  const data = {
    _comment: [
      'Summary: Persisted user accounts for Tanks for Nothing.',
      'Structure: JSON object with _comment array and users list of {username,passwordHash,stats}.',
      'Usage: Managed automatically by server; do not edit manually.'
    ],
    users: Array.from(users, ([username, u]) => ({ username, passwordHash: u.passwordHash, stats: u.stats }))
  };
  await safeWriteJson(USERS_FILE, data);
}

await loadNations();
await loadTanks();
await loadAmmo();
await loadTerrains();
await loadUsers();

// Middleware: parsers must run before routes that read cookies or body data
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // support classic form posts
app.use(cookieParser()); // ensure req.cookies is populated for auth checks
app.use(express.static('public'));

// Admin HTML pages require authentication; login assets remain public
app.get('/admin', (req, res) => {
  if (req.cookies && req.cookies.admin === 'true') {
    return res.redirect('/admin/admin.html');
  }
  res.redirect('/admin/login.html');
});
app.get('/admin/:page.html', (req, res, next) => {
  if (req.params.page === 'login') return next();
  if (req.cookies && req.cookies.admin === 'true') return next();
  return res.redirect('/admin/login.html');
});
app.use('/admin', express.static('admin'));

// Admin authentication middleware
function requireAdmin(req, res, next) {
  if (req.cookies && req.cookies.admin === 'true') return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Admin login endpoint
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    console.log('Admin login successful');
    // Set signed-in flag with secure attributes to prevent XSS and CSRF
    res.cookie('admin', 'true', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });
    return res.json({ success: true });
  }
  console.warn('Admin login failed');
  res.status(403).json({ error: 'bad password' });
});

// Admin logout endpoint to clear auth cookie with matching attributes
app.post('/admin/logout', (req, res) => {
  res.clearCookie('admin', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  });
  res.json({ success: true });
});

// Quick check endpoint for client to verify admin status
app.get('/admin/status', (req, res) => {
  if (req.cookies && req.cookies.admin === 'true') return res.json({ admin: true });
  res.status(401).json({ admin: false });
});

// Return all user statistics for admin dashboard
app.get('/api/users', requireAdmin, (req, res) => {
  const list = Array.from(users, ([username, u]) => ({ username, stats: u.stats }));
  res.json(list);
});

// User signup endpoint with bcrypt password hashing
app.post('/api/signup', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || password.length < 6) {
    return res.status(400).json({ error: 'invalid credentials' });
  }
  if (users.has(username)) return res.status(400).json({ error: 'user exists' });
  const hash = await bcrypt.hash(password, 10);
  users.set(username, { passwordHash: hash, stats: { games: 0, kills: 0, deaths: 0 } });
  await saveUsers();
  console.log(`User signed up: ${username}`);
  res.json({ success: true });
});

// User login endpoint issues httpOnly JWT cookie
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const record = users.get(username);
  if (!record || !(await bcrypt.compare(password || '', record.passwordHash))) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  });
  console.log(`User logged in: ${username}`);
  res.json({ success: true });
});

// Clear JWT cookie to sign out
app.post('/api/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  });
  res.json({ success: true });
});

// Authentication middleware using JWT cookie
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) return res.status(401).json({ error: 'auth required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.username = payload.username;
    return next();
  } catch {
    return res.status(401).json({ error: 'auth failed' });
  }
}

// Fetch current user stats
app.get('/api/stats', requireAuth, (req, res) => {
  const u = users.get(req.username);
  if (!u) return res.status(404).json({ error: 'user not found' });
  res.json({ username: req.username, stats: u.stats });
});

// Admin CRUD endpoints with validation helpers
const classes = new Set(['Light/Scout', 'Medium/MBT', 'Heavy', 'Tank Destroyer']);
const ammoChoices = new Set(['HE', 'HEAT', 'AP', 'Smoke']);
const ammoTypes = new Set(['HE', 'HEAT', 'AP', 'Smoke']);

function validateNation(n) {
  if (!n || typeof n.name !== 'string' || !n.name.trim()) return 'name required';
  // Flag is stored as an emoji string; fallback to empty if invalid
  return { name: n.name.trim(), flag: typeof n.flag === 'string' ? n.flag : '' };
}

function validateTank(t) {
  if (typeof t.name !== 'string' || !t.name.trim()) return 'name required';
  if (typeof t.nation !== 'string' || !nationsSet.has(t.nation)) return 'invalid nation';
  if (typeof t.br !== 'number' || t.br < 1 || t.br > 10) return 'br out of range';
  if (typeof t.class !== 'string' || !classes.has(t.class)) return 'invalid class';
  if (typeof t.armor !== 'number' || t.armor < 10 || t.armor > 150) return 'armor out of range';
  if (typeof t.turretArmor !== 'number' || t.turretArmor < 10 || t.turretArmor > 150) return 'turretArmor out of range'; // turret protection
  if (typeof t.cannonCaliber !== 'number' || t.cannonCaliber < 20 || t.cannonCaliber > 150) return 'caliber out of range';
  if (!Array.isArray(t.ammo) || !t.ammo.every(a => ammoChoices.has(a))) return 'invalid ammo list';
  if (typeof t.ammoCapacity !== 'number' || t.ammoCapacity < 1 || t.ammoCapacity > 120 || t.ammoCapacity % 1 !== 0)
    return 'invalid ammo capacity'; // ensure finite round count
  if (typeof t.barrelLength !== 'number' || t.barrelLength < 1 || t.barrelLength > 12 || (t.barrelLength * 4) % 1 !== 0)
    return 'invalid barrel length';
  if (typeof t.barrelDiameter !== 'number' || t.barrelDiameter < 0.05 || t.barrelDiameter > 0.3 || (t.barrelDiameter * 100) % 1 !== 0)
    return 'invalid barrel diameter';
  if (typeof t.mainCannonFireRate !== 'number' || t.mainCannonFireRate < 1 || t.mainCannonFireRate > 60 || t.mainCannonFireRate % 1 !== 0)
    return 'invalid main cannon fire rate';
  if (typeof t.maxAmmoStorage !== 'number' || t.maxAmmoStorage < 1 || t.maxAmmoStorage > 150 || t.maxAmmoStorage % 1 !== 0)
    return 'invalid max ammo storage';
  if (!Number.isInteger(t.turretXPercent) || t.turretXPercent < 0 || t.turretXPercent > 100) return 'invalid turretXPercent';
  if (!Number.isInteger(t.turretYPercent) || t.turretYPercent < 0 || t.turretYPercent > 100) return 'invalid turretYPercent';
  if (!Number.isInteger(t.crew) || t.crew <= 0) return 'invalid crew count';
  if (typeof t.engineHp !== 'number' || t.engineHp < 100 || t.engineHp > 1000) return 'invalid engine hp';
  if (typeof t.maxSpeed !== 'number' || t.maxSpeed < 10 || t.maxSpeed > 100 || t.maxSpeed % 1 !== 0) return 'invalid max speed';
  if (typeof t.maxReverseSpeed !== 'number' || t.maxReverseSpeed < 0 || t.maxReverseSpeed > 50 || (t.maxReverseSpeed * 2) % 1 !== 0) return 'invalid max reverse speed';
  if (typeof t.incline !== 'number' || t.incline < 2 || t.incline > 12) return 'incline out of range';
  if (typeof t.bodyRotation !== 'number' || t.bodyRotation < 1 || t.bodyRotation > 60) return 'invalid body rotation';
  if (typeof t.turretRotation !== 'number' || t.turretRotation < 1 || t.turretRotation > 60) return 'invalid turret rotation';
  if (typeof t.maxTurretIncline !== 'number' || t.maxTurretIncline < 0 || t.maxTurretIncline > 50 || t.maxTurretIncline % 1 !== 0) return 'invalid turret incline';
  if (typeof t.maxTurretDecline !== 'number' || t.maxTurretDecline < 0 || t.maxTurretDecline > 25 || t.maxTurretDecline % 1 !== 0) return 'invalid turret decline';
  if (!Number.isInteger(t.horizontalTraverse) || t.horizontalTraverse < 0 || t.horizontalTraverse > 20)
    return 'invalid horizontal traverse';
  if (typeof t.bodyWidth !== 'number' || t.bodyWidth < 1 || t.bodyWidth > 5 || (t.bodyWidth * 4) % 1 !== 0) return 'invalid body width';
  if (typeof t.bodyLength !== 'number' || t.bodyLength < 1 || t.bodyLength > 10 || (t.bodyLength * 4) % 1 !== 0) return 'invalid body length';
  if (typeof t.bodyHeight !== 'number' || t.bodyHeight < 1 || t.bodyHeight > 3 || (t.bodyHeight * 4) % 1 !== 0) return 'invalid body height';
  if (typeof t.turretWidth !== 'number' || t.turretWidth < 1 || t.turretWidth > 3 || (t.turretWidth * 4) % 1 !== 0) return 'invalid turret width';
  if (typeof t.turretLength !== 'number' || t.turretLength < 1 || t.turretLength > 5 || (t.turretLength * 4) % 1 !== 0) return 'invalid turret length';
  if (typeof t.turretHeight !== 'number' || t.turretHeight < 0.25 || t.turretHeight > 2 || (t.turretHeight * 4) % 1 !== 0) return 'invalid turret height';
  return {
    name: t.name.trim(),
    nation: t.nation,
    br: t.br,
    class: t.class,
    armor: t.armor,
    turretArmor: t.turretArmor,
    cannonCaliber: t.cannonCaliber,
    ammo: t.ammo,
    ammoCapacity: t.ammoCapacity, // rounds carried
    barrelLength: t.barrelLength,
    barrelDiameter: t.barrelDiameter,
    mainCannonFireRate: t.mainCannonFireRate,
    maxAmmoStorage: t.maxAmmoStorage,
    crew: t.crew,
    engineHp: t.engineHp,
    maxSpeed: t.maxSpeed,
    maxReverseSpeed: t.maxReverseSpeed,
    incline: t.incline,
    bodyRotation: t.bodyRotation,
    turretRotation: t.turretRotation,
    maxTurretIncline: t.maxTurretIncline,
    maxTurretDecline: t.maxTurretDecline,
    // Preserve traverse limits only for tank destroyers; others rotate freely.
    horizontalTraverse: t.class === 'Tank Destroyer' ? t.horizontalTraverse : 0,
    bodyWidth: t.bodyWidth,
    bodyLength: t.bodyLength,
    bodyHeight: t.bodyHeight,
    turretWidth: t.turretWidth,
    turretLength: t.turretLength,
    turretHeight: t.turretHeight,
    turretXPercent: t.turretXPercent,
    turretYPercent: t.turretYPercent
  };
}

function validateAmmo(a) {
  if (typeof a.name !== 'string' || !a.name.trim()) return 'name required';
  if (typeof a.nation !== 'string' || !nationsSet.has(a.nation)) return 'invalid nation';
  if (typeof a.caliber !== 'number' || a.caliber < 20 || a.caliber > 150 || a.caliber % 10 !== 0) return 'caliber out of range';
  if (typeof a.armorPen !== 'number' || a.armorPen < 20 || a.armorPen > 160 || a.armorPen % 10 !== 0) return 'armorPen out of range';
  if (typeof a.type !== 'string' || !ammoTypes.has(a.type)) return 'invalid type';
  if (typeof a.explosionRadius !== 'number' || a.explosionRadius < 0) return 'invalid radius';
  if (typeof a.pen0 !== 'number' || a.pen0 < 20 || a.pen0 > 160 || a.pen0 % 10 !== 0) return 'pen0 out of range';
  if (typeof a.pen100 !== 'number' || a.pen100 < 20 || a.pen100 > 160 || a.pen100 % 10 !== 0) return 'pen100 out of range';
  if (typeof a.speed !== 'number' || a.speed <= 0) return 'speed required';
  return {
    name: a.name.trim(),
    nation: a.nation,
    caliber: a.caliber,
    armorPen: a.armorPen,
    type: a.type,
    explosionRadius: a.explosionRadius,
    pen0: a.pen0,
    pen100: a.pen100,
    image: typeof a.image === 'string' ? a.image : '',
    // Gameplay fields used by firing logic
    speed: a.speed,
    damage: a.armorPen,
    penetration: a.pen0,
    explosion: a.explosionRadius
  };
}

app.get('/api/nations', (req, res) => res.json(nations));
app.post('/api/nations', requireAdmin, async (req, res) => {
  const valid = validateNation(req.body);
  if (typeof valid === 'string') return res.status(400).json({ error: valid });
  nations.push(valid);
  await saveNations();
  res.json({ success: true });
});
app.put('/api/nations/:idx', requireAdmin, async (req, res) => {
  const idx = Number(req.params.idx);
  if (!nations[idx]) return res.status(404).json({ error: 'not found' });
  const valid = validateNation(req.body);
  if (typeof valid === 'string') return res.status(400).json({ error: valid });
  nations[idx] = valid;
  await saveNations();
  res.json({ success: true });
});
app.delete('/api/nations/:idx', requireAdmin, async (req, res) => {
  const idx = Number(req.params.idx);
  if (idx < 0 || idx >= nations.length) return res.status(404).json({ error: 'not found' });
  nations.splice(idx, 1);
  await saveNations();
  res.json({ success: true });
});

app.get('/api/tanks', (req, res) => res.json(tanks));
app.post('/api/tanks', requireAdmin, async (req, res) => {
  const valid = validateTank(req.body);
  if (typeof valid === 'string') return res.status(400).json({ error: valid });
  tanks.push(valid);
  await saveTanks();
  res.json({ success: true });
});
app.put('/api/tanks/:idx', requireAdmin, async (req, res) => {
  const idx = Number(req.params.idx);
  if (!tanks[idx]) return res.status(404).json({ error: 'not found' });
  const valid = validateTank(req.body);
  if (typeof valid === 'string') return res.status(400).json({ error: valid });
  tanks[idx] = valid;
  await saveTanks();
  res.json({ success: true });
});
app.delete('/api/tanks/:idx', requireAdmin, async (req, res) => {
  const idx = Number(req.params.idx);
  if (idx < 0 || idx >= tanks.length) return res.status(404).json({ error: 'not found' });
  tanks.splice(idx, 1);
  await saveTanks();
  res.json({ success: true });
});

app.get('/api/ammo', (req, res) => res.json(ammo));
app.post('/api/ammo', requireAdmin, upload.single('image'), async (req, res) => {
  const imgPath = req.file ? `/uploads/ammo/${req.file.filename}` : '';
  const body = {
    ...req.body,
    caliber: Number(req.body.caliber),
    armorPen: Number(req.body.armorPen),
    explosionRadius: Number(req.body.explosionRadius),
    pen0: Number(req.body.pen0),
    pen100: Number(req.body.pen100),
    speed: Number(req.body.speed),
    image: imgPath
  };
  const valid = validateAmmo(body);
  if (typeof valid === 'string') return res.status(400).json({ error: valid });
  ammo.push(valid);
  await saveAmmo();
  res.json({ success: true });
});
app.put('/api/ammo/:idx', requireAdmin, upload.single('image'), async (req, res) => {
  const idx = Number(req.params.idx);
  if (!ammo[idx]) return res.status(404).json({ error: 'not found' });
  const imgPath = req.file ? `/uploads/ammo/${req.file.filename}` : ammo[idx].image;
  const body = {
    ...req.body,
    caliber: Number(req.body.caliber),
    armorPen: Number(req.body.armorPen),
    explosionRadius: Number(req.body.explosionRadius),
    pen0: Number(req.body.pen0),
    pen100: Number(req.body.pen100),
    speed: Number(req.body.speed),
    image: imgPath
  };
  const valid = validateAmmo(body);
  if (typeof valid === 'string') return res.status(400).json({ error: valid });
  ammo[idx] = valid;
  await saveAmmo();
  res.json({ success: true });
});
app.delete('/api/ammo/:idx', requireAdmin, async (req, res) => {
  const idx = Number(req.params.idx);
  if (idx < 0 || idx >= ammo.length) return res.status(404).json({ error: 'not found' });
  ammo.splice(idx, 1);
  await saveAmmo();
  res.json({ success: true });
});

app.get('/api/terrains', (req, res) => res.json({ terrains, current: currentTerrain }));
app.post('/api/terrains', requireAdmin, async (req, res) => {
  const name = (req.body.name || '').trim();
  const type = (req.body.type || '').trim();
  const size = req.body.size;
  const flags = sanitizeFlags(req.body.flags);
  const ground = sanitizeGrid(req.body.ground);
  const elevation = sanitizeGrid(req.body.elevation);
  if (!name) return res.status(400).json({ error: 'invalid name' });
  if (!type) return res.status(400).json({ error: 'invalid type' });
  if (!size || typeof size.x !== 'number' || typeof size.y !== 'number') {
    return res.status(400).json({ error: 'invalid size' });
  }
  terrains.push({ name, type, size, flags, ground, elevation });
  await saveTerrains();
  res.json({ success: true });
});
app.put('/api/terrains/:idx', requireAdmin, async (req, res) => {
  const idx = Number(req.params.idx);
  if (!terrains[idx]) return res.status(404).json({ error: 'not found' });
  const name = (req.body.name || '').trim();
  const type = (req.body.type || '').trim();
  const size = req.body.size;
  const flags = sanitizeFlags(req.body.flags);
  const ground = sanitizeGrid(req.body.ground);
  const elevation = sanitizeGrid(req.body.elevation);
  if (!name || !type || typeof size?.x !== 'number' || typeof size?.y !== 'number') {
    return res.status(400).json({ error: 'invalid data' });
  }
  terrains[idx] = { name, type, size, flags, ground, elevation };
  await saveTerrains();
  res.json({ success: true });
});
app.delete('/api/terrains/:idx', requireAdmin, async (req, res) => {
  const idx = Number(req.params.idx);
  if (idx < 0 || idx >= terrains.length) return res.status(404).json({ error: 'not found' });
  terrains.splice(idx, 1);
  if (currentTerrain >= terrains.length) currentTerrain = 0;
  terrain = terrains[currentTerrain]?.name || 'flat';
  await saveTerrains();
  res.json({ success: true });
});

app.post('/api/restart', requireAdmin, async (req, res) => {
  const idx = Number(req.body.index);
  if (!terrains[idx]) return res.status(404).json({ error: 'not found' });
  currentTerrain = idx;
  terrain = terrains[currentTerrain].name;
  await saveTerrains();
  players.clear();
  baseBR = null;
  io.emit('restart');
  io.emit('terrain', terrain);
  res.json({ success: true });
});

// Socket.IO connections
io.on('connection', (socket) => {
  console.log('player connected', socket.id);
  socket.emit('tanks', tanks);
  socket.emit('ammo', ammo);
  socket.emit('terrain', terrain);

  socket.on('join', (payload) => {
    const clientTank = payload?.tank || payload;
    const loadout = payload?.loadout || {};
    const cookies = cookie.parse(socket.handshake.headers.cookie || '');
    try {
      const jwtPayload = jwt.verify(cookies.token || '', JWT_SECRET);
      const username = jwtPayload.username;
      const userRecord = users.get(username);
      if (!userRecord) throw new Error('no user');
      const tank = tanks.find(
        (t) => t.name === clientTank.name && t.nation === clientTank.nation
      );
      if (!tank) {
        socket.emit('join-denied', 'Invalid tank');
        return;
      }
      if (baseBR === null) baseBR = tank.br;
      if (tank.br > baseBR + 1) {
        socket.emit('join-denied', 'Tank BR too high');
        return;
      }
      players.set(socket.id, {
        ...tank,
        username,
        ammoLoadout: loadout,
        x: 0,
        y: 0,
        z: 0,
        rot: 0,
        turret: 0,
        gun: 0,
        health: 100,
        crew: tank.crew || 3,
        armor: tank.armor || 20,
        ammoRemaining: tank.maxAmmoStorage ?? tank.ammoCapacity ?? 0,
        lastFire: 0
      });
      // Synchronize the newcomer with any players already in the game world.
      // Send existing player info before broadcasting the new arrival so the
      // client can immediately render all tanks.
      for (const [id, p] of players) {
        if (id === socket.id) continue;
        socket.emit('player-joined', { id, tank: p, username: p.username });
        socket.emit('player-update', { id, state: p });
      }
      userRecord.stats.games += 1;
      saveUsers();
      io.emit('player-joined', { id: socket.id, tank, username });
    } catch {
      socket.emit('join-denied', 'Authentication required');
    }
  });

  socket.on('update', (state) => {
    const p = players.get(socket.id);
    if (!p) return;
    Object.assign(p, state);
    socket.broadcast.emit('player-update', { id: socket.id, state: p });
  });

  // Handle firing requests from clients. Validate ammo selection and
  // compute projectile trajectory based on trusted server-side tank state.
  socket.on('fire', (ammoName) => {
    const shooter = players.get(socket.id);
    if (!shooter) return;
    const now = Date.now();
    const delay = 60000 / (shooter.mainCannonFireRate || 10);
    if (now - shooter.lastFire < delay || shooter.ammoRemaining <= 0) return;
    const ammoDef = ammo.find((a) => a.name === ammoName);
    if (!ammoDef) {
      socket.emit('error', 'Invalid ammo selection');
      return;
    }
    // Derive projectile origin and direction from turret yaw and gun pitch so shells
    // leave the barrel in the direction it faces.
    const yaw = (shooter.rot || 0) + (shooter.turret || 0);
    const pitch = shooter.gun || 0;
    const cosPitch = Math.cos(pitch);
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    shooter.lastFire = now;
    shooter.ammoRemaining -= 1;
    const id = `${now}-${Math.random().toString(16).slice(2)}`;
    const speed = ammoDef.speed ?? 200;
    const barrelLen = shooter.barrelLength ?? 3;
    const muzzleX =
      shooter.x +
      (shooter.turretYPercent / 100 - 0.5) * shooter.bodyWidth -
      sinYaw * cosPitch * barrelLen;
    const muzzleY = shooter.y + 1 + Math.sin(pitch) * barrelLen;
    const muzzleZ =
      shooter.z +
      (0.5 - shooter.turretXPercent / 100) * shooter.bodyLength -
      cosYaw * cosPitch * barrelLen;
    const projectile = {
      id,
      x: muzzleX,
      y: muzzleY,
      z: muzzleZ,
      vx: -sinYaw * cosPitch * speed,
      vy: Math.sin(pitch) * speed,
      vz: -cosYaw * cosPitch * speed,
      ammo: ammoDef.name,
      shooter: socket.id,
      life: 5
    };
    projectiles.set(id, projectile);
    io.emit('projectile-fired', projectile);
  });

  socket.on('disconnect', () => {
    console.log('player disconnected', socket.id);
    players.delete(socket.id);
    io.emit('player-left', socket.id);
    if (players.size === 0) baseBR = null; // reset BR when game empty
  });
});

// Basic projectile physics loop. Moves projectiles forward and checks for
// simple spherical collisions with players, applying damage on impact.
setInterval(() => {
  const dt = 0.05; // 20 ticks per second
  for (const [id, p] of projectiles) {
    p.vy += GRAVITY * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    if (p.y <= 0) {
      io.emit('projectile-exploded', { id, x: p.x, y: p.y, z: p.z });
      projectiles.delete(id);
      continue;
    }
    for (const [pid, player] of players) {
      if (pid === p.shooter) continue;
      const dx = player.x - p.x;
      const dy = player.y - p.y;
      const dz = player.z - p.z;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) < 2) {
        const ammoDef = ammo.find((a) => a.name === p.ammo) || {};
        const armor = player.armor || 0;
        const dmg = ammoDef.damage ?? ammoDef.armorPen ?? 10;
        const pen = ammoDef.penetration ?? ammoDef.pen0 ?? 0;
        const explosion = ammoDef.explosion ?? ammoDef.explosionRadius ?? 0;
        let total = pen > armor ? dmg : dmg / 2;
        total += explosion;
        player.health = Math.max(0, (player.health ?? 100) - total);
        io.emit('tank-damaged', { id: pid, health: player.health });
        if (player.health <= 0) {
          const shooter = players.get(p.shooter);
          const shooterUser = shooter && users.get(shooter.username);
          const victimUser = users.get(player.username);
          if (shooterUser) shooterUser.stats.kills += 1;
          if (victimUser) victimUser.stats.deaths += 1;
          saveUsers();
        }
        io.emit('projectile-exploded', { id, x: p.x, y: p.y, z: p.z });
        projectiles.delete(id);
        break;
      }
    }
    p.life -= dt;
    if (projectiles.has(id) && p.life <= 0) {
      io.emit('projectile-exploded', { id, x: p.x, y: p.y, z: p.z });
      projectiles.delete(id);
    }
  }
}, 50).unref();

server.listen(PORT, () => console.log(`Tanks for Nothing server running on port ${PORT}`));

export { app, server };
