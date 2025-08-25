// tanksfornothing-server.js
// Summary: Entry point server for Tanks for Nothing, a minimal blocky multiplayer tank game.
// This script sets up an Express web server with Socket.IO for real-time tank position updates and persists admin-defined tanks,
// nations and terrain details to disk.
// Structure: configuration -> express setup -> socket handlers -> in-memory stores -> persistence helpers -> server start.
// Usage: Run with `node tanksfornothing-server.js` or `npm start`. Set PORT env to change port.
// ---------------------------------------------------------------------------

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cookieParser from 'cookie-parser';
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
const ammo = []; // CRUD via admin
// Terrains now include metadata so map listings can show thumbnails and size
let terrains = [{ name: 'flat', type: 'default', size: { x: 1, y: 1 } }];
let currentTerrain = 0; // index into terrains
let terrain = 'flat'; // currently active terrain name
let baseBR = null; // Battle Rating of first player
// Nations persisted separately; maintain array and Set for validation
let nations = []; // CRUD via admin, loaded from JSON file
let nationsSet = new Set();

const TANKS_FILE = new URL('./data/tanks.json', import.meta.url);
const NATIONS_FILE = new URL('./data/nations.json', import.meta.url);
const TERRAIN_FILE = new URL('./data/terrains.json', import.meta.url);

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

// Middleware
app.use(express.static('public'));
app.use('/admin', express.static('admin'));
app.use(express.json());
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
  console.log('player connected', socket.id);
  socket.emit('tanks', tanks);
  socket.emit('ammo', ammo);
  socket.emit('terrain', terrain);

  socket.on('join', (tank) => {
    // Ensure BR constraint
    if (baseBR === null) baseBR = tank.br;
    if (tank.br > baseBR + 1) {
      socket.emit('join-denied', 'Tank BR too high');
      return;
    }
    players.set(socket.id, { ...tank, x: 0, y: 0, z: 0, rot: 0, turret: 0 });
    io.emit('player-joined', { id: socket.id, tank });
  });

  socket.on('update', (state) => {
    const p = players.get(socket.id);
    if (!p) return;
    Object.assign(p, state);
    socket.broadcast.emit('player-update', { id: socket.id, state: p });
  });

  socket.on('disconnect', () => {
    console.log('player disconnected', socket.id);
    players.delete(socket.id);
    io.emit('player-left', socket.id);
    if (players.size === 0) baseBR = null; // reset BR when game empty
  });
});

server.listen(PORT, () => console.log(`Tanks for Nothing server running on port ${PORT}`));
