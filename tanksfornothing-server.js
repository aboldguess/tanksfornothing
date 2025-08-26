// tanksfornothing-server.js
// Summary: Entry point server for Tanks for Nothing, a minimal blocky multiplayer tank game.
// This script sets up an Express web server with Socket.IO for real-time tank and projectile
// updates, persists admin-defined tanks, nations and terrain details (including capture-the-flag
// positions) to disk and enforces Battle Rating constraints when players join.
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

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

// Configuration
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'adminpass';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

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
    speed: 200,
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
    speed: 150,
    damage: 20,
    penetration: 10,
    explosion: 50
  }
];
// Active projectile list; each projectile contains position, velocity and metadata
const projectiles = new Map(); // id -> projectile state
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
let terrains = [{ name: 'flat', type: 'default', size: { x: 1, y: 1 }, flags: defaultFlags() }];
let currentTerrain = 0; // index into terrains
let terrain = 'flat'; // currently active terrain name
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
      try { await fs.copyFile(bak, file); } catch {}
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
  } catch {}
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    console.error(`Failed to write ${file.pathname}:`, err.message);
    try { await fs.rename(bak, file); } catch {}
    throw err;
  }
}

async function loadTanks() {
  const data = await safeReadJson(TANKS_FILE, { tanks: [] });
  if (Array.isArray(data.tanks)) tanks = data.tanks;
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
    nations = data.nations;
    nationsSet = new Set(nations);
  }
}

async function saveNations() {
  const data = {
    _comment: [
      'Summary: Persisted nation names for Tanks for Nothing.',
      'Structure: JSON object with _comment array and nations list.',
      'Usage: Managed automatically by server; do not edit manually.'
    ],
    nations
  };
  await safeWriteJson(NATIONS_FILE, data);
  nationsSet = new Set(nations);
}

async function loadTerrains() {
  const defaults = {
    current: 0,
    terrains: [{ name: 'flat', type: 'default', size: { x: 1, y: 1 }, flags: defaultFlags() }]
  };
  const data = await safeReadJson(TERRAIN_FILE, defaults);
  if (Array.isArray(data.terrains)) {
    terrains = data.terrains.map(t =>
      typeof t === 'string'
        ? { name: t, type: 'default', size: { x: 1, y: 1 }, flags: defaultFlags() }
        : { ...t, flags: sanitizeFlags(t.flags) }
    );
  }
  if (typeof data.current === 'number') currentTerrain = data.current;
  terrain = terrains[currentTerrain]?.name || 'flat';
}

async function saveTerrains() {
  const data = {
    _comment: [
      'Summary: Persisted terrain details and selected index for Tanks for Nothing.',
      'Structure: JSON object with _comment array, current index and terrains list of {name,type,size,flags}.',
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

// Middleware
app.use(express.static('public'));
app.use('/admin', express.static('admin'));
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // support classic form posts
app.use(cookieParser());

// Admin authentication middleware
function requireAdmin(req, res, next) {
  if (req.cookies && req.cookies.admin === 'true') return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Admin login endpoint
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    // Set signed-in flag with secure attributes to prevent XSS and CSRF
    res.cookie('admin', 'true', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });
    return res.json({ success: true });
  }
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
const classes = new Set(['Light/Scout', 'Medium/MBT', 'Heavy']);
const ammoChoices = new Set(['HE', 'HEAT', 'AP', 'Smoke']);
const ammoTypes = new Set(['HE', 'HEAT', 'AP', 'Smoke']);

function validateNation(n) {
  if (!n || typeof n.name !== 'string' || !n.name.trim()) return 'name required';
  return { name: n.name.trim() };
}

function validateTank(t) {
  if (typeof t.name !== 'string' || !t.name.trim()) return 'name required';
  if (typeof t.nation !== 'string' || !nationsSet.has(t.nation)) return 'invalid nation';
  if (typeof t.br !== 'number' || t.br < 1 || t.br > 10) return 'br out of range';
  if (typeof t.class !== 'string' || !classes.has(t.class)) return 'invalid class';
  if (typeof t.armor !== 'number' || t.armor < 10 || t.armor > 150) return 'armor out of range';
  if (typeof t.cannonCaliber !== 'number' || t.cannonCaliber < 20 || t.cannonCaliber > 150) return 'caliber out of range';
  if (!Array.isArray(t.ammo) || !t.ammo.every(a => ammoChoices.has(a))) return 'invalid ammo list';
  if (!Number.isInteger(t.crew) || t.crew <= 0) return 'invalid crew count';
  if (typeof t.maxAcceleration !== 'number' || t.maxAcceleration < 0.5 || t.maxAcceleration > 5) return 'invalid max acceleration';
  if (typeof t.maxSpeed !== 'number' || t.maxSpeed < 10 || t.maxSpeed > 100 || t.maxSpeed % 1 !== 0) return 'invalid max speed';
  if (typeof t.maxReverseSpeed !== 'number' || t.maxReverseSpeed < 0 || t.maxReverseSpeed > 50 || (t.maxReverseSpeed * 2) % 1 !== 0) return 'invalid max reverse speed';
  if (typeof t.incline !== 'number' || t.incline < 2 || t.incline > 12) return 'incline out of range';
  if (typeof t.bodyRotation !== 'number' || t.bodyRotation < 1 || t.bodyRotation > 60) return 'invalid body rotation';
  if (typeof t.turretRotation !== 'number' || t.turretRotation < 1 || t.turretRotation > 60) return 'invalid turret rotation';
  return {
    name: t.name.trim(),
    nation: t.nation,
    br: t.br,
    class: t.class,
    armor: t.armor,
    cannonCaliber: t.cannonCaliber,
    ammo: t.ammo,
    crew: t.crew,
    maxAcceleration: t.maxAcceleration,
    maxSpeed: t.maxSpeed,
    maxReverseSpeed: t.maxReverseSpeed,
    incline: t.incline,
    bodyRotation: t.bodyRotation,
    turretRotation: t.turretRotation
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
  return {
    name: a.name.trim(),
    nation: a.nation,
    caliber: a.caliber,
    armorPen: a.armorPen,
    type: a.type,
    explosionRadius: a.explosionRadius,
    pen0: a.pen0,
    pen100: a.pen100,
    // Derived gameplay fields so firing logic has required values
    speed: a.caliber * 10,
    damage: a.armorPen,
    penetration: a.pen0,
    explosion: a.explosionRadius
  };
}

app.get('/api/nations', (req, res) => res.json(nations));
app.post('/api/nations', requireAdmin, async (req, res) => {
  const valid = validateNation(req.body);
  if (typeof valid === 'string') return res.status(400).json({ error: valid });
  nations.push(valid.name);
  await saveNations();
  res.json({ success: true });
});
app.put('/api/nations/:idx', requireAdmin, async (req, res) => {
  const idx = Number(req.params.idx);
  if (!nations[idx]) return res.status(404).json({ error: 'not found' });
  const valid = validateNation(req.body);
  if (typeof valid === 'string') return res.status(400).json({ error: valid });
  nations[idx] = valid.name;
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
app.post('/api/ammo', requireAdmin, async (req, res) => {
  const valid = validateAmmo(req.body);
  if (typeof valid === 'string') return res.status(400).json({ error: valid });
  ammo.push(valid);
  await saveAmmo();
  res.json({ success: true });
});
app.put('/api/ammo/:idx', requireAdmin, async (req, res) => {
  const idx = Number(req.params.idx);
  if (!ammo[idx]) return res.status(404).json({ error: 'not found' });
  const valid = validateAmmo(req.body);
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
  if (!name) return res.status(400).json({ error: 'invalid name' });
  if (!type) return res.status(400).json({ error: 'invalid type' });
  if (!size || typeof size.x !== 'number' || typeof size.y !== 'number') {
    return res.status(400).json({ error: 'invalid size' });
  }
  terrains.push({ name, type, size, flags });
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
  if (!name || !type || typeof size?.x !== 'number' || typeof size?.y !== 'number') {
    return res.status(400).json({ error: 'invalid data' });
  }
  terrains[idx] = { name, type, size, flags };
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

  socket.on('join', (clientTank) => {
    const cookies = cookie.parse(socket.handshake.headers.cookie || '');
    try {
      const payload = jwt.verify(cookies.token || '', JWT_SECRET);
      const username = payload.username;
      const userRecord = users.get(username);
      if (!userRecord) throw new Error('no user');
      // Validate client-sent tank against server list to prevent tampering
      const tank = tanks.find(
        (t) => t.name === clientTank.name && t.nation === clientTank.nation
      );
      if (!tank) {
        socket.emit('join-denied', 'Invalid tank');
        return;
      }
      // Ensure BR constraint based on trusted server data
      if (baseBR === null) baseBR = tank.br;
      if (tank.br > baseBR + 1) {
        socket.emit('join-denied', 'Tank BR too high');
        return;
      }
      // Initialize server-side player state with health and armor for damage calculations
      players.set(socket.id, {
        ...tank,
        username,
        x: 0,
        y: 0,
        z: 0,
        rot: 0,
        turret: 0,
        health: 100,
        crew: tank.crew || 3,
        armor: tank.armor || 20
      });
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
    const ammoDef = ammo.find((a) => a.name === ammoName);
    if (!ammoDef) {
      socket.emit('error', 'Invalid ammo selection');
      return;
    }
    const angle = (shooter.rot || 0) + (shooter.turret || 0);
    const dirX = Math.sin(angle);
    const dirZ = Math.cos(angle);
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const speed = ammoDef.speed ?? 200;
    const projectile = {
      id,
      x: shooter.x,
      y: shooter.y + 1,
      z: shooter.z,
      vx: -dirX * speed,
      vy: 0,
      vz: -dirZ * speed,
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
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
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
}, 50);

server.listen(PORT, () => console.log(`Tanks for Nothing server running on port ${PORT}`));
