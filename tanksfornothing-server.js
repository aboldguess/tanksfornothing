// tanksfornothing-server.js
// Summary: Entry point server for Tanks for Nothing, a minimal blocky multiplayer tank game.
// This script sets up an Express web server with Socket.IO for real-time tank position updates.
// Structure: configuration -> express setup -> socket handlers -> in-memory stores -> server start.
// Usage: Run with `node tanksfornothing-server.js` or `npm start`. Set PORT env to change port.
// ---------------------------------------------------------------------------

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cookieParser from 'cookie-parser';

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

// Configuration
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'adminpass';

// In-memory stores
const players = new Map(); // socket.id -> player state
const tanks = []; // CRUD via admin
const ammo = []; // CRUD via admin
let terrain = 'flat';
let baseBR = null; // Battle Rating of first player

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
    res.cookie('admin', 'true', { httpOnly: true });
    return res.json({ success: true });
  }
  res.status(403).json({ error: 'bad password' });
});

// Admin CRUD endpoints
app.get('/api/tanks', (req, res) => res.json(tanks));
app.post('/api/tanks', requireAdmin, (req, res) => {
  tanks.push(req.body);
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
