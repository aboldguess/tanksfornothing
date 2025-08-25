// tanksfornothing-server.js
// Summary: Entry point server for Tanks for Nothing, a minimal blocky multiplayer tank game.
// This script sets up an Express web server with Socket.IO for real-time tank position updates and persists admin-defined tanks to disk.
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

// In-memory stores (tanks persisted to disk)
const players = new Map(); // socket.id -> player state
let tanks = []; // CRUD via admin, loaded from JSON file
const ammo = []; // CRUD via admin
let terrain = 'flat';
let baseBR = null; // Battle Rating of first player

const DATA_FILE = new URL('./data/tanks.json', import.meta.url);

async function loadTanks() {
  try {
    const text = await fs.readFile(DATA_FILE, 'utf8');
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
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

await loadTanks();

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

// Admin CRUD endpoints
app.get('/api/tanks', (req, res) => res.json(tanks));
app.post('/api/tanks', requireAdmin, async (req, res) => {
  const t = req.body;
  const classes = new Set(['Light', 'Medium', 'Heavy', 'Tank Destroyer', 'SPAA']);
  if (typeof t.name !== 'string' || !t.name.trim()) return res.status(400).json({ error: 'name required' });
  if (typeof t.nation !== 'string' || !t.nation.trim()) return res.status(400).json({ error: 'nation required' });
  if (typeof t.br !== 'number' || t.br < 1 || t.br > 10) return res.status(400).json({ error: 'br out of range' });
  if (typeof t.armor !== 'number' || t.armor < 0 || t.armor > 500) return res.status(400).json({ error: 'armor out of range' });
  if (typeof t.cannonCaliber !== 'number' || t.cannonCaliber <= 0) return res.status(400).json({ error: 'invalid caliber' });
  if (!Array.isArray(t.ammo) || !t.ammo.every(a => typeof a === 'string')) return res.status(400).json({ error: 'invalid ammo list' });
  if (!Number.isInteger(t.crew) || t.crew <= 0) return res.status(400).json({ error: 'invalid crew count' });
  if (typeof t.engineHp !== 'number' || t.engineHp <= 0) return res.status(400).json({ error: 'invalid engine hp' });
  if (typeof t.incline !== 'number' || t.incline < 0 || t.incline > 60) return res.status(400).json({ error: 'incline out of range' });
  if (typeof t.bodyRotation !== 'number' || t.bodyRotation < 0) return res.status(400).json({ error: 'invalid body rotation' });
  if (typeof t.turretRotation !== 'number' || t.turretRotation < 0) return res.status(400).json({ error: 'invalid turret rotation' });
  if (typeof t.class !== 'string' || !classes.has(t.class)) return res.status(400).json({ error: 'invalid class' });

  const newTank = {
    name: t.name.trim(),
    nation: t.nation.trim(),
    br: t.br,
    armor: t.armor,
    cannonCaliber: t.cannonCaliber,
    ammo: t.ammo,
    crew: t.crew,
    engineHp: t.engineHp,
    incline: t.incline,
    bodyRotation: t.bodyRotation,
    turretRotation: t.turretRotation,
    class: t.class
  };
  tanks.push(newTank);
  await saveTanks();
  res.json({ success: true });
});

app.get('/api/ammo', (req, res) => res.json(ammo));
app.post('/api/ammo', requireAdmin, (req, res) => {
  ammo.push(req.body);
  res.json({ success: true });
});

app.get('/api/terrain', (req, res) => res.json({ terrain }));
app.post('/api/terrain', requireAdmin, (req, res) => {
  terrain = req.body.terrain || 'flat';
  io.emit('terrain', terrain); // notify players
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
