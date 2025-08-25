// tanksfornothing-server.js
// Summary: Entry point server for Tanks for Nothing, a minimal blocky multiplayer tank game
// with secure player signup/login and stat tracking.
// This script sets up an Express web server with Socket.IO for real-time tank and projectile
// updates, persists admin-defined tanks, nations, terrain and player accounts to disk and
// enforces Battle Rating constraints when players join.
// Structure: configuration -> express/session setup -> REST auth routes -> socket handlers ->
//            in-memory stores -> persistence helpers -> projectile physics loop -> server start.
// Usage: Run with `node tanksfornothing-server.js` or `npm start`. Set PORT env to change port.
// ---------------------------------------------------------------------------

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import bcrypt from 'bcrypt';
import { promises as fs } from 'fs';

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

// Configuration
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'adminpass';

// In-memory stores (tanks and terrains persisted to disk)
const players = new Map(); // socket.id -> player state
let tanks = []; // CRUD via admin, loaded from JSON file
// Default ammo set; additional types may be added via admin API
const ammo = [
  {
    name: 'AP',
    type: 'AP',
    speed: 200,
    damage: 40,
    penetration: 50,
    explosion: 0
  },
  {
    name: 'HE',
    type: 'HE',
    speed: 150,
    damage: 20,
    penetration: 10,
    explosion: 50
  }
];
// Active projectile list; each projectile contains position, velocity and metadata
const projectiles = new Map(); // id -> projectile state
// Terrains now include metadata so map listings can show thumbnails and size
let terrains = [{ name: 'flat', type: 'default', size: { x: 1, y: 1 } }];
let currentTerrain = 0; // index into terrains
let terrain = 'flat'; // currently active terrain name
let baseBR = null; // Battle Rating of first player
// Nations persisted separately; maintain array and Set for validation
let nations = []; // CRUD via admin, loaded from JSON file
let nationsSet = new Set();
let accounts = new Map(); // username -> {username, password, games, kills, deaths}

const TANKS_FILE = new URL('./data/tanks.json', import.meta.url);
const NATIONS_FILE = new URL('./data/nations.json', import.meta.url);
const TERRAIN_FILE = new URL('./data/terrains.json', import.meta.url);
const PLAYERS_FILE = new URL('./data/players.json', import.meta.url);

async function loadTanks() {
  try {
    const text = await fs.readFile(TANKS_FILE, 'utf8');
    const json = JSON.parse(text);
    if (Array.isArray(json.tanks)) tanks = json.tanks;
  } catch {
    console.warn('No existing tank data, starting with empty list');
  }
}

async function saveTanks() {
  await fs.mkdir(new URL('./data', import.meta.url), { recursive: true });
  const data = {
    _comment: [
      'Summary: Persisted tank definitions for Tanks for Nothing.',
      'Structure: JSON object with _comment array and tanks list.',
      'Usage: Managed automatically by server; do not edit manually.'
    ],
    tanks
  };
  await fs.writeFile(TANKS_FILE, JSON.stringify(data, null, 2));
}

async function loadNations() {
  try {
    const text = await fs.readFile(NATIONS_FILE, 'utf8');
    const json = JSON.parse(text);
    if (Array.isArray(json.nations)) {
      nations = json.nations;
      nationsSet = new Set(nations);
    }
  } catch {
    console.warn('No existing nation data, starting with empty list');
  }
}

async function saveNations() {
  await fs.mkdir(new URL('./data', import.meta.url), { recursive: true });
  const data = {
    _comment: [
      'Summary: Persisted nation names for Tanks for Nothing.',
      'Structure: JSON object with _comment array and nations list.',
      'Usage: Managed automatically by server; do not edit manually.'
    ],
    nations
  };
  await fs.writeFile(NATIONS_FILE, JSON.stringify(data, null, 2));
  nationsSet = new Set(nations);
}

async function loadTerrains() {
  try {
    const text = await fs.readFile(TERRAIN_FILE, 'utf8');
    const json = JSON.parse(text);
    if (Array.isArray(json.terrains)) {
      terrains = json.terrains.map(t =>
        typeof t === 'string' ? { name: t, type: 'default', size: { x: 1, y: 1 } } : t
      );
    }
    if (typeof json.current === 'number') currentTerrain = json.current;
  } catch {
    console.warn('No existing terrain data, starting with default');
  }
  terrain = terrains[currentTerrain]?.name || 'flat';
}

async function loadPlayers() {
  try {
    const text = await fs.readFile(PLAYERS_FILE, 'utf8');
    const json = JSON.parse(text);
    if (Array.isArray(json.players)) {
      accounts = new Map(json.players.map((p) => [p.username, p]));
    }
  } catch {
    console.warn('No existing player data, starting with empty list');
  }
}

async function savePlayers() {
  await fs.mkdir(new URL('./data', import.meta.url), { recursive: true });
  const data = {
    _comment: [
      'Summary: Persisted player accounts and statistics for Tanks for Nothing.',
      'Structure: JSON object with _comment array and players list containing username, password hash and stats.',
      'Usage: Managed automatically by server; do not edit manually.'
    ],
    players: Array.from(accounts.values())
  };
  await fs.writeFile(PLAYERS_FILE, JSON.stringify(data, null, 2));
}

async function saveTerrains() {
  await fs.mkdir(new URL('./data', import.meta.url), { recursive: true });
  const data = {
    _comment: [
      'Summary: Persisted terrain details and selected index for Tanks for Nothing.',
      'Structure: JSON object with _comment array, current index and terrains list of {name,type,size}.',
      'Usage: Managed automatically by server; do not edit manually.'
    ],
    current: currentTerrain,
    terrains
  };
  await fs.writeFile(TERRAIN_FILE, JSON.stringify(data, null, 2));
}

await loadNations();
await loadTanks();
await loadTerrains();
await loadPlayers();

// Middleware
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production'
  }
});

app.use(express.static('public'));
app.use('/admin', express.static('admin'));
app.use(express.json());
app.use(cookieParser());
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

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

// Player authentication routes
app.post('/api/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'missing credentials' });
  if (accounts.has(username)) return res.status(409).json({ error: 'user exists' });
  const hash = await bcrypt.hash(password, 10);
  const account = { username, password: hash, games: 0, kills: 0, deaths: 0 };
  accounts.set(username, account);
  await savePlayers();
  console.log(`Created account for ${username}`);
  res.json({ success: true });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const account = accounts.get(username);
  if (!account) return res.status(401).json({ error: 'invalid user' });
  const ok = await bcrypt.compare(password, account.password);
  if (!ok) return res.status(401).json({ error: 'invalid password' });
  req.session.username = username;
  res.json({ username, games: account.games, kills: account.kills, deaths: account.deaths });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/me', (req, res) => {
  const username = req.session.username;
  if (!username) return res.status(401).json({ error: 'not logged in' });
  const account = accounts.get(username);
  if (!account) return res.status(404).json({ error: 'missing account' });
  res.json({ username, games: account.games, kills: account.kills, deaths: account.deaths });
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
  if (typeof t.engineHp !== 'number' || t.engineHp < 100 || t.engineHp > 1000) return 'invalid engine hp';
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
    engineHp: t.engineHp,
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
    pen100: a.pen100
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
app.post('/api/ammo', requireAdmin, (req, res) => {
  const valid = validateAmmo(req.body);
  if (typeof valid === 'string') return res.status(400).json({ error: valid });
  ammo.push(valid);
  res.json({ success: true });
});
app.put('/api/ammo/:idx', requireAdmin, (req, res) => {
  const idx = Number(req.params.idx);
  if (!ammo[idx]) return res.status(404).json({ error: 'not found' });
  const valid = validateAmmo(req.body);
  if (typeof valid === 'string') return res.status(400).json({ error: valid });
  ammo[idx] = valid;
  res.json({ success: true });
});
app.delete('/api/ammo/:idx', requireAdmin, (req, res) => {
  const idx = Number(req.params.idx);
  if (idx < 0 || idx >= ammo.length) return res.status(404).json({ error: 'not found' });
  ammo.splice(idx, 1);
  res.json({ success: true });
});

app.get('/api/terrains', (req, res) => res.json({ terrains, current: currentTerrain }));
app.post('/api/terrains', requireAdmin, async (req, res) => {
  const name = (req.body.name || '').trim();
  const type = (req.body.type || '').trim();
  const size = req.body.size;
  if (!name) return res.status(400).json({ error: 'invalid name' });
  if (!type) return res.status(400).json({ error: 'invalid type' });
  if (!size || typeof size.x !== 'number' || typeof size.y !== 'number') {
    return res.status(400).json({ error: 'invalid size' });
  }
  terrains.push({ name, type, size });
  await saveTerrains();
  res.json({ success: true });
});
app.put('/api/terrains/:idx', requireAdmin, async (req, res) => {
  const idx = Number(req.params.idx);
  if (!terrains[idx]) return res.status(404).json({ error: 'not found' });
  const name = (req.body.name || '').trim();
  const type = (req.body.type || '').trim();
  const size = req.body.size;
  if (!name || !type || typeof size?.x !== 'number' || typeof size?.y !== 'number') {
    return res.status(400).json({ error: 'invalid data' });
  }
  terrains[idx] = { name, type, size };
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
  const username = socket.request.session?.username;
  console.log('player connected', socket.id, username);
  socket.emit('tanks', tanks);
  socket.emit('ammo', ammo);
  socket.emit('terrain', terrain);

  socket.on('join', (clientTank) => {
    const user = socket.request.session?.username;
    if (!user) {
      socket.emit('join-denied', 'Login required');
      return;
    }
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
      username: user,
      ...tank,
      x: 0,
      y: 0,
      z: 0,
      rot: 0,
      turret: 0,
      health: 100,
      crew: tank.crew || 3,
      armor: tank.armor || 20
    });
    const account = accounts.get(user);
    if (account) {
      account.games++;
      savePlayers();
    }
    io.emit('player-joined', { id: socket.id, tank, username: user });
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
    const projectile = {
      id,
      x: shooter.x,
      y: shooter.y + 1,
      z: shooter.z,
      vx: -dirX * ammoDef.speed,
      vy: 0,
      vz: -dirZ * ammoDef.speed,
      ammo: ammoDef.name,
      shooter: socket.id,
      life: 5
    };
    projectiles.set(id, projectile);
    io.emit('projectile-fired', projectile);
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    console.log('player disconnected', socket.id, p?.username);
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
        const dmg = ammoDef.damage || 10;
        const pen = ammoDef.penetration || 0;
        const explosion = ammoDef.explosion || 0;
        let total = pen > armor ? dmg : dmg / 2;
        total += explosion;
        player.health = Math.max(0, (player.health ?? 100) - total);
        io.emit('tank-damaged', { id: pid, health: player.health });
        io.emit('projectile-exploded', { id, x: p.x, y: p.y, z: p.z });
        if (player.health <= 0) {
          const shooter = players.get(p.shooter);
          const victim = players.get(pid);
          const shooterAcc = shooter && accounts.get(shooter.username);
          const victimAcc = victim && accounts.get(victim.username);
          if (shooterAcc) shooterAcc.kills++;
          if (victimAcc) victimAcc.deaths++;
          savePlayers();
          io.emit('player-killed', { id: pid, by: p.shooter });
        }
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
