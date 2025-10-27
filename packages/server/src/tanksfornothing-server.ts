// tanksfornothing-server.ts
// Summary: TypeScript entry point server for Tanks for Nothing, the blocky multiplayer tank game.
// This script now hosts an Express web server alongside a Colyseus room for authoritative
// multiplayer simulation, handles image uploads for ammo types, stores flag emojis for nations,
// persists admin-defined tanks, nations and terrain details (including capture-the-flag positions)
// to disk and enforces Battle Rating constraints when players join. Tank definitions
// store an ammoCapacity value to limit carried rounds while the Colyseus room tracks
// turret and gun orientation so remote players render complete cannons and projectiles
// spawn from the muzzle using that orientation and arc under gravity.
// Structure: configuration -> express setup -> Colyseus bootstrap -> in-memory stores ->
//            persistence helpers -> admin APIs -> server start.
// Usage: Run with `npm start` (which builds then executes dist/src/tanksfornothing-server.js).
// ---------------------------------------------------------------------------

import express, { type NextFunction, type Request, type Response } from 'express';
import http from 'node:http';
import { Server as ColyseusServer, type AuthContext } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import cookieParser from 'cookie-parser';
import { promises as fs } from 'node:fs';
import bcrypt from 'bcryptjs';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import cookie from 'cookie';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateGentleHills } from '@tanksfornothing/shared';

import { TanksForNothingRoom } from './game/tanks-room.js';
import type {
  AmmoDefinition,
  FlagPoint,
  NationRecord,
  TankDefinition,
  TeamFlags,
  TerrainDefinition,
  TerrainGroundPaletteEntry,
  TerrainLightingSettings,
  TerrainNoiseSettings,
  TerrainPayload,
  UserRecord,
  UserStats
} from './types.js';

interface AuthenticatedRequest extends Request {
  username?: string;
}

interface AuthJwtPayload extends JwtPayload {
  username: string;
}

const app = express();
const server = http.createServer(app);
const gameServer = new ColyseusServer({
  transport: new WebSocketTransport({
    server,
    path: '/colyseus'
  })
});

// Configuration
const rawPort = process.env.PORT;
// Normalise the runtime port to a numeric value so Node's HTTP server receives a
// concrete number even when the environment exposes a string (e.g. from cloud hosts).
const PORT: number = rawPort ? Number.parseInt(rawPort, 10) || 3000 : 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'adminpass';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const moduleDir = new URL('.', import.meta.url);
const workspaceDir = moduleDir.pathname.includes('/dist/')
  ? new URL('../../', moduleDir)
  : new URL('../', moduleDir);
const projectRootUrl = new URL('../../', workspaceDir);
const clientPublicDir = fileURLToPath(new URL('./packages/client/public', projectRootUrl));
const clientDistDir = fileURLToPath(new URL('./packages/client/dist', projectRootUrl));
const adminDir = fileURLToPath(new URL('./admin', projectRootUrl));
const uploadBase = path.join(clientPublicDir, 'uploads');
const ammoDir = path.join(uploadBase, 'ammo');

// Detect whether a Vite production build exists so the server can prioritise
// hashed assets in dist while gracefully falling back to the raw public files
// during development.
let clientBuildAvailable = false;
try {
  await fs.access(clientDistDir);
  clientBuildAvailable = true;
} catch {
  console.warn('Client dist assets missing; development build will serve unbundled public files.');
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdir(ammoDir, { recursive: true })
      .then(() => cb(null, ammoDir))
      .catch((error) => cb(error as Error, ammoDir));
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
let tanks: TankDefinition[] = []; // CRUD via admin, loaded from JSON file
let ammo: AmmoDefinition[] = []; // CRUD via admin, loaded from JSON file
const defaultAmmo: AmmoDefinition[] = [
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
    explosion: 0,
    image: ''
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
    explosion: 50,
    image: ''
  }
];
// Terrains now include metadata so map listings can show thumbnails and size
function defaultFlags(): { red: TeamFlags; blue: TeamFlags } {
  return {
    red: { a: null, b: null, c: null, d: null },
    blue: { a: null, b: null, c: null, d: null }
  };
}
function sanitizeFlags(f: unknown): { red: TeamFlags; blue: TeamFlags } {
  const res = defaultFlags();
  if (!f || typeof f !== 'object') return res;
  ['red', 'blue'].forEach((team) => {
    ['a', 'b', 'c', 'd'].forEach((letter) => {
      const pos = (f as Record<string, Record<string, FlagPoint> | undefined>)?.[team]?.[letter];
      if (pos && typeof pos === 'object' && typeof pos.x === 'number' && typeof pos.y === 'number') {
        res[team as 'red' | 'blue'][letter as keyof TeamFlags] = { x: pos.x, y: pos.y };
      }
    });
  });
  return res;
}

function sanitizeGrid(g: unknown): number[][] {
  if (!Array.isArray(g)) return [];
  return g.map((row) =>
    Array.isArray(row) ? row.map((v) => (typeof v === 'number' ? v : 0)) : []
  );
}

function clampGroundToPalette(grid: number[][], palette: TerrainGroundPaletteEntry[]): number[][] {
  if (!Array.isArray(grid) || grid.length === 0) return [];
  const maxIndex = Math.max(0, palette.length - 1);
  return grid.map((row) =>
    row.map((cell) => (Number.isFinite(cell) ? Math.min(Math.max(0, Math.round(cell)), maxIndex) : 0))
  );
}

const defaultGroundPalette: TerrainGroundPaletteEntry[] = [
  { name: 'grass', color: '#3cb043', traction: 0.9, viscosity: 0.1, texture: 'grass' },
  { name: 'mud', color: '#6b4423', traction: 0.5, viscosity: 0.5, texture: 'mud' },
  { name: 'snow', color: '#ffffff', traction: 0.4, viscosity: 0.2, texture: 'snow' },
  { name: 'sand', color: '#c2b280', traction: 0.6, viscosity: 0.3, texture: 'sand' },
  { name: 'rock', color: '#80868b', traction: 0.8, viscosity: 0.2, texture: 'rock' }
];

function sanitizePalette(p: unknown): TerrainGroundPaletteEntry[] {
  if (!Array.isArray(p) || p.length === 0) return defaultGroundPalette.map((g) => ({ ...g }));
  const cleaned: TerrainGroundPaletteEntry[] = [];
  for (const entry of p) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof (entry as { name?: unknown }).name === 'string' && (entry as { name?: string }).name
      ? (entry as { name: string }).name
      : `ground-${cleaned.length + 1}`;
    const color = typeof (entry as { color?: unknown }).color === 'string'
      ? (entry as { color: string }).color
      : '#888888';
    const traction = Number.isFinite((entry as { traction?: unknown }).traction)
      ? Number((entry as { traction: number }).traction)
      : 0.5;
    const viscosity = Number.isFinite((entry as { viscosity?: unknown }).viscosity)
      ? Number((entry as { viscosity: number }).viscosity)
      : 0.5;
    const texture = typeof (entry as { texture?: unknown }).texture === 'string'
      ? (entry as { texture: string }).texture
      : 'grass';
    cleaned.push({ name, color, traction, viscosity, texture });
  }
  return cleaned.length ? cleaned : defaultGroundPalette.map((g) => ({ ...g }));
}

function sanitizeNoise(n: unknown): TerrainNoiseSettings {
  const defaults: TerrainNoiseSettings = { scale: 12, amplitude: 24 };
  if (!n || typeof n !== 'object') return defaults;
  const scale = Number((n as { scale?: unknown }).scale);
  const amplitude = Number((n as { amplitude?: unknown }).amplitude);
  return {
    scale: Number.isFinite(scale) && scale > 0 ? scale : defaults.scale,
    amplitude: Number.isFinite(amplitude) && amplitude > 0 ? amplitude : defaults.amplitude
  };
}

function sanitizeLighting(l: unknown): TerrainLightingSettings {
  const defaults: TerrainLightingSettings = {
    sunPosition: { x: 200, y: 400, z: 200 },
    sunColor: '#ffe8a3',
    ambientColor: '#1f2a3c'
  };
  if (!l || typeof l !== 'object') return defaults;
  const sun = (l as { sunPosition?: { x?: unknown; y?: unknown; z?: unknown } }).sunPosition || {};
  const x = Number((sun as { x?: unknown }).x);
  const y = Number((sun as { y?: unknown }).y);
  const z = Number((sun as { z?: unknown }).z);
  const sunColor = typeof (l as { sunColor?: unknown }).sunColor === 'string'
    ? (l as { sunColor: string }).sunColor
    : defaults.sunColor;
  const ambientColor = typeof (l as { ambientColor?: unknown }).ambientColor === 'string'
    ? (l as { ambientColor: string }).ambientColor
    : defaults.ambientColor;
  return {
    sunPosition: {
      x: Number.isFinite(x) ? x : defaults.sunPosition.x,
      y: Number.isFinite(y) ? y : defaults.sunPosition.y,
      z: Number.isFinite(z) ? z : defaults.sunPosition.z
    },
    sunColor,
    ambientColor
  };
}
const DEFAULT_GRID_WIDTH = 40;
const DEFAULT_GRID_HEIGHT = 40;
const CELL_METERS = 50;
const DEFAULT_NOISE = sanitizeNoise({ scale: 12, amplitude: 24 });
const DEFAULT_LIGHTING = sanitizeLighting(undefined);

let terrains: TerrainDefinition[] = [{
  name: 'Perlin Foothills',
  type: 'fields',
  size: {
    x: Number((DEFAULT_GRID_WIDTH * CELL_METERS / 1000).toFixed(2)),
    y: Number((DEFAULT_GRID_HEIGHT * CELL_METERS / 1000).toFixed(2))
  },
  flags: defaultFlags(),
  ground: Array.from({ length: DEFAULT_GRID_HEIGHT }, () => Array(DEFAULT_GRID_WIDTH).fill(0)),
  elevation: generateGentleHills(
    DEFAULT_GRID_WIDTH,
    DEFAULT_GRID_HEIGHT,
    1 / DEFAULT_NOISE.scale,
    DEFAULT_NOISE.amplitude
  ),
  palette: defaultGroundPalette.map((g) => ({ ...g })),
  noise: DEFAULT_NOISE,
  lighting: DEFAULT_LIGHTING
}];
let currentTerrain = 0; // index into terrains
let terrain = 'Perlin Foothills'; // currently active terrain name
// Nations persisted separately; maintain array and Set for validation
let nations: NationRecord[] = []; // CRUD via admin, loaded from JSON file
let nationsSet = new Set<string>();

// Users persisted to disk for authentication and stat tracking
let users = new Map<string, UserRecord>(); // username -> { passwordHash, stats }

const TANKS_FILE = new URL('./data/tanks.json', projectRootUrl);
const NATIONS_FILE = new URL('./data/nations.json', projectRootUrl);
const TERRAIN_FILE = new URL('./data/terrains.json', projectRootUrl);
const AMMO_FILE = new URL('./data/ammo.json', projectRootUrl);
const USERS_FILE = new URL('./data/users.json', projectRootUrl);

function buildTerrainPayload(): TerrainPayload {
  return {
    name: terrain,
    definition: terrains[currentTerrain] ?? null
  };
}

// Generic JSON helpers with backup handling to guard against corruption
async function safeReadJson<T>(file: URL, defaults: T): Promise<T> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to read ${file.pathname}:`, message);
    const bak = new URL(file.href + '.bak');
    try {
      const backup = await fs.readFile(bak, 'utf8');
      console.warn(`Recovered ${file.pathname} from backup`);
      try {
        await fs.copyFile(bak, file);
      } catch (copyErr) {
        const copyMsg = copyErr instanceof Error ? copyErr.message : String(copyErr);
        console.warn(`Failed to restore ${file.pathname} from backup:`, copyMsg);
      }
      return JSON.parse(backup) as T;
    } catch {
      console.warn(`No usable data for ${file.pathname}, using defaults`);
      return defaults;
    }
  }
}

async function safeWriteJson(file: URL, data: unknown): Promise<void> {
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
    const renameMsg = renameErr instanceof Error ? renameErr.message : String(renameErr);
    console.warn(`No original file to backup for ${file.pathname}:`, renameMsg);
  }
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to write ${file.pathname}:`, message);
    try {
      await fs.rename(bak, file);
    } catch (restoreErr) {
      const restoreMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
      console.error(`Failed to restore backup for ${file.pathname}:`, restoreMsg);
    }
    throw err;
  }
}

async function loadTanks() {
  const data = await safeReadJson<{ tanks: TankDefinition[] }>(TANKS_FILE, { tanks: [] });
  if (Array.isArray(data.tanks)) {
    // Only tank destroyers should retain a horizontal traverse limit; all other
    // classes rotate freely so we normalize their value to 0 (meaning unlimited).
    tanks = data.tanks.map((t) => ({
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
  const data = await safeReadJson<{ nations: NationRecord[] | string[] }>(NATIONS_FILE, { nations: [] });
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
      name: 'Perlin Foothills',
      type: 'fields',
      size: {
        x: Number((DEFAULT_GRID_WIDTH * CELL_METERS / 1000).toFixed(2)),
        y: Number((DEFAULT_GRID_HEIGHT * CELL_METERS / 1000).toFixed(2))
      },
      flags: defaultFlags(),
      ground: Array.from({ length: DEFAULT_GRID_HEIGHT }, () => Array(DEFAULT_GRID_WIDTH).fill(0)),
      elevation: generateGentleHills(
        DEFAULT_GRID_WIDTH,
        DEFAULT_GRID_HEIGHT,
        1 / DEFAULT_NOISE.scale,
        DEFAULT_NOISE.amplitude
      ),
      palette: defaultGroundPalette.map((g) => ({ ...g })),
      noise: DEFAULT_NOISE,
      lighting: DEFAULT_LIGHTING
    }]
  };
  const data = await safeReadJson<{ current: number; terrains: TerrainDefinition[] }>(
    TERRAIN_FILE,
    defaults
  );
  if (Array.isArray(data.terrains)) {
    terrains = data.terrains.map((t) => {
      const palette = sanitizePalette((t as { palette?: unknown }).palette);
      const noise = sanitizeNoise((t as { noise?: unknown }).noise);
      const lighting = sanitizeLighting((t as { lighting?: unknown }).lighting);
      const rawGround = sanitizeGrid((t as { ground?: unknown }).ground);
      return {
        name: (t as { name?: string }).name || 'Unnamed',
        type: (t as { type?: string }).type || 'fields',
        size: (t as { size?: { x: number; y: number } }).size || { x: 1, y: 1 },
        flags: sanitizeFlags((t as { flags?: unknown }).flags),
        ground: clampGroundToPalette(rawGround, palette),
        elevation: sanitizeGrid((t as { elevation?: unknown }).elevation),
        palette,
        noise,
        lighting
      };
    });
  }
  if (typeof data.current === 'number') currentTerrain = data.current;
  terrain = terrains[currentTerrain]?.name || 'Perlin Foothills';
}

async function saveTerrains() {
  const data = {
    _comment: [
      'Summary: Persisted terrain details and selected index for Tanks for Nothing.',
      'Structure: JSON object with _comment array, current index and terrains list of {name,type,size,flags,ground,elevation,palette,noise,lighting}.',
      'Usage: Managed automatically by server; do not edit manually.'
    ],
    current: currentTerrain,
    terrains: terrains.map((t) => ({
      name: t.name,
      type: t.type,
      size: t.size,
      flags: t.flags,
      ground: t.ground,
      elevation: t.elevation,
      palette: t.palette,
      noise: t.noise,
      lighting: t.lighting
    }))
  };
  await safeWriteJson(TERRAIN_FILE, data);
}

async function loadAmmo() {
  const data = await safeReadJson<{ ammo: AmmoDefinition[] }>(AMMO_FILE, { ammo: defaultAmmo });
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
  const data = await safeReadJson<{ users: Array<{ username: string; passwordHash: string; stats?: UserStats }> }>(
    USERS_FILE,
    { users: [] }
  );
  if (Array.isArray(data.users)) {
    users = new Map(
      data.users.map((u) => {
        const stats: UserStats = {
          games: u.stats?.games ?? 0,
          kills: u.stats?.kills ?? 0,
          deaths: u.stats?.deaths ?? 0
        };
        return [u.username, { passwordHash: u.passwordHash, stats } satisfies UserRecord];
      })
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

function getAmmoCatalog(): AmmoDefinition[] {
  return ammo.length ? ammo : defaultAmmo;
}

function findTankDefinition(name: string, nation: string): TankDefinition | undefined {
  return tanks.find((t) => t.name === name && t.nation === nation);
}

const persistUsers = async (): Promise<void> => {
  try {
    await saveUsers();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to persist users', message);
  }
};

function recordGameStart(username: string): void {
  const record = users.get(username);
  if (!record) return;
  record.stats.games += 1;
  void persistUsers();
}

function recordKill(username: string): void {
  const record = users.get(username);
  if (!record) return;
  record.stats.kills += 1;
}

function recordDeath(username: string): void {
  const record = users.get(username);
  if (!record) return;
  record.stats.deaths += 1;
}

function authenticateHandshake(context: AuthContext): { username: string } | { error: string } {
  try {
    const headerSource = context.req?.headers ?? context.headers ?? {};
    const cookiesHeader = headerSource.cookie ?? '';
    const cookies = cookie.parse(cookiesHeader);
    const token = cookies.token;
    if (!token) throw new Error('Authentication required');
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || typeof payload === 'string') throw new Error('Authentication required');
    const jwtPayload = payload as AuthJwtPayload;
    if (!jwtPayload.username) throw new Error('Authentication required');
    if (!users.has(jwtPayload.username)) throw new Error('Authentication required');
    return { username: jwtPayload.username };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('Colyseus authentication failed:', message);
    return { error: 'Authentication required' };
  }
}

await loadNations();
await loadTanks();
await loadAmmo();
await loadTerrains();
await loadUsers();

gameServer.define('tanksfornothing', TanksForNothingRoom, {
  dependencies: {
    authenticate: authenticateHandshake,
    findTank: findTankDefinition,
    getTanks: () => tanks,
    getAmmo: getAmmoCatalog,
    getTerrain: buildTerrainPayload,
    recordGameStart,
    recordKill,
    recordDeath,
    persistUsers
  }
});

// Middleware: parsers must run before routes that read cookies or body data
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // support classic form posts
app.use(cookieParser()); // ensure req.cookies is populated for auth checks
if (clientBuildAvailable) {
  app.use(express.static(clientDistDir));
  app.use('/js', express.static(clientDistDir));
}
app.use(express.static(clientPublicDir));

// Admin HTML pages require authentication; login assets remain public
app.get('/admin', (req: Request, res: Response) => {
  if (req.cookies && req.cookies.admin === 'true') {
    return res.redirect('/admin/admin.html');
  }
  res.redirect('/admin/login.html');
});
app.get('/admin/:page.html', (req: Request, res: Response, next: NextFunction) => {
  if (req.params.page === 'login') return next();
  if (req.cookies && req.cookies.admin === 'true') return next();
  return res.redirect('/admin/login.html');
});
app.use('/admin', express.static(adminDir));

// Admin authentication middleware
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.cookies && req.cookies.admin === 'true') {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
}

// Admin login endpoint
app.post('/admin/login', (req: Request, res: Response) => {
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
app.post('/admin/logout', (req: Request, res: Response) => {
  res.clearCookie('admin', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  });
  res.json({ success: true });
});

// Quick check endpoint for client to verify admin status
app.get('/admin/status', (req: Request, res: Response) => {
  if (req.cookies && req.cookies.admin === 'true') return res.json({ admin: true });
  res.status(401).json({ admin: false });
});

// Return all user statistics for admin dashboard
app.get('/api/users', requireAdmin, (req: Request, res: Response) => {
  const list = Array.from(users, ([username, u]) => ({ username, stats: u.stats }));
  res.json(list);
});

// User signup endpoint with bcrypt password hashing
app.post('/api/signup', async (req: Request, res: Response) => {
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
app.post('/api/login', async (req: Request, res: Response) => {
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
app.post('/api/logout', (req: Request, res: Response) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  });
  res.json({ success: true });
});

// Authentication middleware using JWT cookie
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies && req.cookies.token;
  if (!token) return res.status(401).json({ error: 'auth required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || typeof payload === 'string') {
      return res.status(401).json({ error: 'auth failed' });
    }
    const jwtPayload = payload as AuthJwtPayload;
    if (typeof jwtPayload.username !== 'string') {
      return res.status(401).json({ error: 'auth failed' });
    }
    (req as AuthenticatedRequest).username = jwtPayload.username;
    return next();
  } catch {
    return res.status(401).json({ error: 'auth failed' });
  }
}

// Fetch current user stats
app.get('/api/stats', requireAuth, (req: Request, res: Response) => {
  const authedReq = req as AuthenticatedRequest;
  const u = authedReq.username ? users.get(authedReq.username) : undefined;
  if (!u || !authedReq.username) return res.status(404).json({ error: 'user not found' });
  res.json({ username: authedReq.username, stats: u.stats });
});

// Admin CRUD endpoints with validation helpers
const classes = new Set(['Light/Scout', 'Medium/MBT', 'Heavy', 'Tank Destroyer']);
const ammoChoices = new Set(['HE', 'HEAT', 'AP', 'Smoke']);
const ammoTypes = new Set(['HE', 'HEAT', 'AP', 'Smoke']);

function validateNation(n: unknown): NationRecord | string {
  if (typeof n === 'string') {
    const trimmed = n.trim();
    if (!trimmed) return 'name required';
    return { name: trimmed, flag: '' };
  }
  if (!n || typeof n !== 'object') return 'name required';
  const record = n as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) return 'name required';
  const flag = typeof record.flag === 'string' ? record.flag : '';
  return { name, flag };
}

function validateTank(t: unknown): TankDefinition | string {
  if (!t || typeof t !== 'object') return 'invalid payload';
  const tank = t as Record<string, unknown>;
  if (typeof tank.name !== 'string' || !tank.name.trim()) return 'name required';
  if (typeof tank.nation !== 'string' || !nationsSet.has(tank.nation)) return 'invalid nation';
  if (typeof tank.br !== 'number' || tank.br < 1 || tank.br > 10) return 'br out of range';
  if (typeof tank.class !== 'string' || !classes.has(tank.class)) return 'invalid class';
  if (typeof tank.armor !== 'number' || tank.armor < 10 || tank.armor > 150) return 'armor out of range';
  if (typeof tank.turretArmor !== 'number' || tank.turretArmor < 10 || tank.turretArmor > 150) return 'turretArmor out of range';
  if (typeof tank.cannonCaliber !== 'number' || tank.cannonCaliber < 20 || tank.cannonCaliber > 150) return 'caliber out of range';
  if (!Array.isArray(tank.ammo) || !tank.ammo.every((a) => typeof a === 'string' && ammoChoices.has(a))) return 'invalid ammo list';
  if (typeof tank.ammoCapacity !== 'number' || tank.ammoCapacity < 1 || tank.ammoCapacity > 120 || tank.ammoCapacity % 1 !== 0)
    return 'invalid ammo capacity';
  if (typeof tank.barrelLength !== 'number' || tank.barrelLength < 1 || tank.barrelLength > 12 || (tank.barrelLength * 4) % 1 !== 0)
    return 'invalid barrel length';
  if (
    typeof tank.mainCannonFireRate !== 'number' ||
    tank.mainCannonFireRate < 1 ||
    tank.mainCannonFireRate > 60 ||
    tank.mainCannonFireRate % 1 !== 0
  )
    return 'invalid main cannon fire rate';
  if (!Number.isInteger(tank.turretXPercent) || Number(tank.turretXPercent) < 0 || Number(tank.turretXPercent) > 100)
    return 'invalid turretXPercent';
  if (!Number.isInteger(tank.turretYPercent) || Number(tank.turretYPercent) < 0 || Number(tank.turretYPercent) > 100)
    return 'invalid turretYPercent';
  if (!Number.isInteger(tank.crew) || Number(tank.crew) <= 0) return 'invalid crew count';
  if (typeof tank.engineHp !== 'number' || tank.engineHp < 100 || tank.engineHp > 1000) return 'invalid engine hp';
  if (typeof tank.maxSpeed !== 'number' || tank.maxSpeed < 10 || tank.maxSpeed > 100 || tank.maxSpeed % 1 !== 0)
    return 'invalid max speed';
  if (
    typeof tank.maxReverseSpeed !== 'number' ||
    tank.maxReverseSpeed < 0 ||
    tank.maxReverseSpeed > 50 ||
    (tank.maxReverseSpeed * 2) % 1 !== 0
  )
    return 'invalid max reverse speed';
  if (typeof tank.incline !== 'number' || tank.incline < 2 || tank.incline > 12) return 'incline out of range';
  if (typeof tank.bodyRotation !== 'number' || tank.bodyRotation < 1 || tank.bodyRotation > 60) return 'invalid body rotation';
  if (typeof tank.turretRotation !== 'number' || tank.turretRotation < 1 || tank.turretRotation > 60) return 'invalid turret rotation';
  if (
    typeof tank.maxTurretIncline !== 'number' ||
    tank.maxTurretIncline < 0 ||
    tank.maxTurretIncline > 50 ||
    tank.maxTurretIncline % 1 !== 0
  )
    return 'invalid turret incline';
  if (
    typeof tank.maxTurretDecline !== 'number' ||
    tank.maxTurretDecline < 0 ||
    tank.maxTurretDecline > 25 ||
    tank.maxTurretDecline % 1 !== 0
  )
    return 'invalid turret decline';
  if (!Number.isInteger(tank.horizontalTraverse) || Number(tank.horizontalTraverse) < 0 || Number(tank.horizontalTraverse) > 20)
    return 'invalid horizontal traverse';
  if (typeof tank.bodyWidth !== 'number' || tank.bodyWidth < 1 || tank.bodyWidth > 5 || (tank.bodyWidth * 4) % 1 !== 0)
    return 'invalid body width';
  if (typeof tank.bodyLength !== 'number' || tank.bodyLength < 1 || tank.bodyLength > 10 || (tank.bodyLength * 4) % 1 !== 0)
    return 'invalid body length';
  if (typeof tank.bodyHeight !== 'number' || tank.bodyHeight < 1 || tank.bodyHeight > 3 || (tank.bodyHeight * 4) % 1 !== 0)
    return 'invalid body height';
  if (typeof tank.turretWidth !== 'number' || tank.turretWidth < 1 || tank.turretWidth > 3 || (tank.turretWidth * 4) % 1 !== 0)
    return 'invalid turret width';
  if (typeof tank.turretLength !== 'number' || tank.turretLength < 1 || tank.turretLength > 5 || (tank.turretLength * 4) % 1 !== 0)
    return 'invalid turret length';
  if (typeof tank.turretHeight !== 'number' || tank.turretHeight < 0.25 || tank.turretHeight > 2 || (tank.turretHeight * 4) % 1 !== 0)
    return 'invalid turret height';
  return {
    name: tank.name.trim(),
    nation: tank.nation,
    br: tank.br,
    class: tank.class,
    armor: tank.armor,
    turretArmor: tank.turretArmor,
    cannonCaliber: tank.cannonCaliber,
    ammo: (tank.ammo as string[]).map((a) => String(a)),
    ammoCapacity: Number(tank.ammoCapacity),
    barrelLength: Number(tank.barrelLength),
    mainCannonFireRate: Number(tank.mainCannonFireRate),
    crew: Number(tank.crew),
    engineHp: Number(tank.engineHp),
    maxSpeed: Number(tank.maxSpeed),
    maxReverseSpeed: Number(tank.maxReverseSpeed),
    incline: Number(tank.incline),
    bodyRotation: Number(tank.bodyRotation),
    turretRotation: Number(tank.turretRotation),
    maxTurretIncline: Number(tank.maxTurretIncline),
    maxTurretDecline: Number(tank.maxTurretDecline),
    // Preserve traverse limits only for tank destroyers; others rotate freely.
    horizontalTraverse: tank.class === 'Tank Destroyer' ? Number(tank.horizontalTraverse) : 0,
    bodyWidth: Number(tank.bodyWidth),
    bodyLength: Number(tank.bodyLength),
    bodyHeight: Number(tank.bodyHeight),
    turretWidth: Number(tank.turretWidth),
    turretLength: Number(tank.turretLength),
    turretHeight: Number(tank.turretHeight),
    turretXPercent: Number(tank.turretXPercent),
    turretYPercent: Number(tank.turretYPercent)
  } satisfies TankDefinition;
}

function validateAmmo(a: unknown): AmmoDefinition | string {
  if (!a || typeof a !== 'object') return 'invalid payload';
  const ammoCandidate = a as Record<string, unknown>;
  if (typeof ammoCandidate.name !== 'string' || !ammoCandidate.name.trim()) return 'name required';
  if (typeof ammoCandidate.nation !== 'string' || !nationsSet.has(ammoCandidate.nation)) return 'invalid nation';
  if (typeof ammoCandidate.caliber !== 'number' || ammoCandidate.caliber < 20 || ammoCandidate.caliber > 150 || ammoCandidate.caliber % 10 !== 0)
    return 'caliber out of range';
  if (typeof ammoCandidate.armorPen !== 'number' || ammoCandidate.armorPen < 20 || ammoCandidate.armorPen > 160 || ammoCandidate.armorPen % 10 !== 0)
    return 'armorPen out of range';
  if (typeof ammoCandidate.type !== 'string' || !ammoTypes.has(ammoCandidate.type)) return 'invalid type';
  if (typeof ammoCandidate.explosionRadius !== 'number' || ammoCandidate.explosionRadius < 0) return 'invalid radius';
  if (typeof ammoCandidate.pen0 !== 'number' || ammoCandidate.pen0 < 20 || ammoCandidate.pen0 > 160 || ammoCandidate.pen0 % 10 !== 0)
    return 'pen0 out of range';
  if (typeof ammoCandidate.pen100 !== 'number' || ammoCandidate.pen100 < 20 || ammoCandidate.pen100 > 160 || ammoCandidate.pen100 % 10 !== 0)
    return 'pen100 out of range';
  if (typeof ammoCandidate.speed !== 'number' || ammoCandidate.speed <= 0) return 'speed required';
  return {
    name: ammoCandidate.name.trim(),
    nation: ammoCandidate.nation,
    caliber: ammoCandidate.caliber,
    armorPen: ammoCandidate.armorPen,
    type: ammoCandidate.type,
    explosionRadius: ammoCandidate.explosionRadius,
    pen0: ammoCandidate.pen0,
    pen100: ammoCandidate.pen100,
    image: typeof ammoCandidate.image === 'string' ? ammoCandidate.image : '',
    // Gameplay fields used by firing logic
    speed: ammoCandidate.speed,
    damage: ammoCandidate.armorPen,
    penetration: ammoCandidate.pen0,
    explosion: ammoCandidate.explosionRadius
  } satisfies AmmoDefinition;
}

app.get('/api/nations', (_req: Request, res: Response) => res.json(nations));
app.post('/api/nations', requireAdmin, async (req: Request, res: Response) => {
  const valid = validateNation(req.body);
  if (typeof valid === 'string') return res.status(400).json({ error: valid });
  nations.push(valid);
  await saveNations();
  res.json({ success: true });
});
app.put('/api/nations/:idx', requireAdmin, async (req: Request, res: Response) => {
  const idx = Number(req.params.idx);
  if (!nations[idx]) return res.status(404).json({ error: 'not found' });
  const valid = validateNation(req.body);
  if (typeof valid === 'string') return res.status(400).json({ error: valid });
  nations[idx] = valid;
  await saveNations();
  res.json({ success: true });
});
app.delete('/api/nations/:idx', requireAdmin, async (req: Request, res: Response) => {
  const idx = Number(req.params.idx);
  if (idx < 0 || idx >= nations.length) return res.status(404).json({ error: 'not found' });
  nations.splice(idx, 1);
  await saveNations();
  res.json({ success: true });
});

app.get('/api/tanks', (_req: Request, res: Response) => res.json(tanks));
app.post('/api/tanks', requireAdmin, async (req: Request, res: Response) => {
  const valid = validateTank(req.body);
  if (typeof valid === 'string') return res.status(400).json({ error: valid });
  tanks.push(valid);
  await saveTanks();
  res.json({ success: true });
});
app.put('/api/tanks/:idx', requireAdmin, async (req: Request, res: Response) => {
  const idx = Number(req.params.idx);
  if (!tanks[idx]) return res.status(404).json({ error: 'not found' });
  const valid = validateTank(req.body);
  if (typeof valid === 'string') return res.status(400).json({ error: valid });
  tanks[idx] = valid;
  await saveTanks();
  res.json({ success: true });
});
app.delete('/api/tanks/:idx', requireAdmin, async (req: Request, res: Response) => {
  const idx = Number(req.params.idx);
  if (idx < 0 || idx >= tanks.length) return res.status(404).json({ error: 'not found' });
  tanks.splice(idx, 1);
  await saveTanks();
  res.json({ success: true });
});

app.get('/api/ammo', (_req: Request, res: Response) => res.json(ammo));
app.post('/api/ammo', requireAdmin, upload.single('image'), async (req: Request, res: Response) => {
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
app.put('/api/ammo/:idx', requireAdmin, upload.single('image'), async (req: Request, res: Response) => {
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
app.delete('/api/ammo/:idx', requireAdmin, async (req: Request, res: Response) => {
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
  const palette = sanitizePalette(req.body.palette);
  const noise = sanitizeNoise(req.body.noise);
  const lighting = sanitizeLighting(req.body.lighting);
  if (!name) return res.status(400).json({ error: 'invalid name' });
  if (!type) return res.status(400).json({ error: 'invalid type' });
  if (!size || typeof size.x !== 'number' || typeof size.y !== 'number') {
    return res.status(400).json({ error: 'invalid size' });
  }
  terrains.push({
    name,
    type,
    size,
    flags,
    ground: clampGroundToPalette(ground, palette),
    elevation,
    palette,
    noise,
    lighting
  });
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
  const palette = sanitizePalette(req.body.palette);
  const noise = sanitizeNoise(req.body.noise);
  const lighting = sanitizeLighting(req.body.lighting);
  if (!name || !type || typeof size?.x !== 'number' || typeof size?.y !== 'number') {
    return res.status(400).json({ error: 'invalid data' });
  }
  terrains[idx] = {
    name,
    type,
    size,
    flags,
    ground: clampGroundToPalette(ground, palette),
    elevation,
    palette,
    noise,
    lighting
  };
  await saveTerrains();
  res.json({ success: true });
});
app.delete('/api/terrains/:idx', requireAdmin, async (req, res) => {
  const idx = Number(req.params.idx);
  if (idx < 0 || idx >= terrains.length) return res.status(404).json({ error: 'not found' });
  terrains.splice(idx, 1);
  if (currentTerrain >= terrains.length) currentTerrain = 0;
  terrain = terrains[currentTerrain]?.name || 'Perlin Foothills';
  await saveTerrains();
  res.json({ success: true });
});

app.post('/api/restart', requireAdmin, async (req, res) => {
  const idx = Number(req.body.index);
  if (!terrains[idx]) return res.status(404).json({ error: 'not found' });
  currentTerrain = idx;
  terrain = terrains[currentTerrain].name;
  await saveTerrains();
  const payload = buildTerrainPayload();
  TanksForNothingRoom.restartAll(payload);
  res.json({ success: true });
});
if (process.argv[1] === __filename) {
  await gameServer.listen(PORT);
  console.log(`Tanks for Nothing server and Colyseus transport running on port ${PORT}`);
}

export { app, server, validateTank };
export type { TankDefinition, AmmoDefinition } from './types.js';
