// import-warthunder-vehicles.ts
// Summary: Imports ground vehicle data from the War Thunder Vehicles API into local tanks.json.
// Structure: fetch remote vehicles -> filter ground types -> map to local tank schema -> validate -> safe write results.
// Usage: Run with `npm run import-wt` (or `node dist/src/scripts/import-warthunder-vehicles.js`) after setting up any required network proxy variables.
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetch, ProxyAgent } from 'undici';
import { validateTank } from '../tanksfornothing-server.js';
import type { TankDefinition } from '../tanksfornothing-server.js';

// War Thunder Vehicles API endpoint. Adjust if the upstream service changes.
const API_URL = 'https://wt.warthunder.com/encyclopedia/api/vehicles/';

// Optional proxy support for corporate/firewalled environments. Set
// HTTPS_PROXY/HTTP_PROXY (or lowercase variants) to a URL like
// `http://host:port` and the request will be tunneled through it.
const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

// Resolve path to data/tanks.json relative to this script.
const moduleDir = new URL('.', import.meta.url);
const workspaceDir = moduleDir.pathname.includes('/dist/')
  ? new URL('../../..', moduleDir)
  : new URL('../..', moduleDir);
const projectRoot = new URL('../../', workspaceDir);
const dataDir = new URL('./data/', projectRoot);
const tanksFile = new URL('tanks.json', dataDir);

/**
 * Safely write JSON data to disk by writing to a temporary file and renaming.
 * This prevents corruption if the process exits mid-write.
 */
async function safeWriteJson(fileUrl: URL, obj: unknown): Promise<void> {
  const filePath = fileURLToPath(fileUrl);
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(obj, null, 2));
  await fs.rename(tmpPath, filePath);
}

/** Determine whether an API vehicle entry represents a ground vehicle. */
function isGroundVehicle(v: unknown): boolean {
  const record = v as { type?: string; vehicleType?: string };
  const type = String(record?.type || record?.vehicleType || '').toLowerCase();
  return type.includes('ground') || type.includes('tank');
}

/** Map a War Thunder vehicle object to the local tank schema used by the game. */
function mapVehicleToTank(v: unknown): TankDefinition {
  const vehicle = v as Record<string, any>;
  return {
    name: String(vehicle?.name || 'Unnamed'),
    nation: String(vehicle?.country || 'Neutral'),
    br: Number(vehicle?.br) || 1,
    class: String(vehicle?.class || 'Light Tank'),
    armor: Number(vehicle?.hull_armor?.front) || 50,
    turretArmor: Number(vehicle?.turret_armor?.front) || 50,
    cannonCaliber: Number(vehicle?.weapon?.caliber) || 75,
    ammo: ['AP'], // Placeholder ammo type; adjust when API provides ammo details.
    ammoCapacity: 50,
    barrelLength: 3,
    mainCannonFireRate: 6,
    turretXPercent: 50,
    turretYPercent: 50,
    crew: Number(vehicle?.crew) || 4,
    engineHp: Number(vehicle?.engine_power) || 500,
    maxSpeed: Number(vehicle?.max_speed) || 40,
    maxReverseSpeed: 10,
    incline: 10,
    bodyRotation: 20,
    turretRotation: 20,
    maxTurretIncline: 20,
    maxTurretDecline: 10,
    horizontalTraverse: 0,
    bodyWidth: 3,
    bodyLength: 6,
    bodyHeight: 2,
    turretWidth: 2,
    turretLength: 3,
    turretHeight: 1
  } satisfies TankDefinition;
}

/**
 * Fetch helper that retries once without the proxy on failure and provides
 * detailed error diagnostics to aid debugging.
 */
async function fetchVehicles(): Promise<any> {
  try {
    return await fetch(API_URL, {
      dispatcher,
      headers: { 'User-Agent': 'tanksfornothing-import/1.0' }
    });
  } catch (err) {
    console.error('Network request failed:', err.message);
    if (err.cause) console.error('Underlying error:', err.cause);
    if (dispatcher) {
      console.warn('Retrying without proxy...');
      try {
        return await fetch(API_URL, {
          headers: { 'User-Agent': 'tanksfornothing-import/1.0' }
        });
      } catch (err2) {
        console.error('Retry without proxy failed:', err2.message);
        if (err2.cause) console.error('Underlying error:', err2.cause);
        if (proxyUrl) {
          console.error('Proxy configured:', proxyUrl);
        } else {
          console.error('Set HTTPS_PROXY or HTTP_PROXY if your network requires a proxy.');
        }
        throw err2;
      }
    }
    if (proxyUrl) {
      console.error('Proxy configured:', proxyUrl);
    } else {
      console.error('Set HTTPS_PROXY or HTTP_PROXY if your network requires a proxy.');
    }
    throw err;
  }
}

/** Main importer routine. */
async function importVehicles(): Promise<void> {
  console.log(`Fetching vehicles from ${API_URL}`);
  const res = await fetchVehicles();
  if (!res.ok) throw new Error(`API request failed with status ${res.status}`);

  const raw: any = await res.json();
  const vehicles = Array.isArray(raw) ? raw : raw.vehicles || [];
  console.log(`Retrieved ${vehicles.length} total vehicles`);

  const ground = vehicles.filter(isGroundVehicle);
  console.log(`Filtered to ${ground.length} ground vehicles`);

  const tanks: TankDefinition[] = [];
  for (const veh of ground) {
    const mapped = mapVehicleToTank(veh);
    const valid = validateTank(mapped);
    if (typeof valid === 'string') {
      console.warn(`Skipping ${mapped.name}: ${valid}`);
    } else {
      tanks.push(valid);
    }
  }

  console.log(`Validated ${tanks.length} tanks; writing to data/tanks.json`);
  let fileData: { _comment: string[]; tanks: TankDefinition[] } = {
    _comment: ['Imported from War Thunder Vehicles API'],
    tanks: []
  };
  try {
    fileData = JSON.parse(await fs.readFile(tanksFile, 'utf-8'));
  } catch {
    console.warn('tanks.json missing, a new file will be created');
  }
  fileData.tanks = tanks;
  await safeWriteJson(tanksFile, fileData);
  console.log(`Saved ${tanks.length} tank records`);
}

importVehicles().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});

