// import-warthunder-vehicles.js
// Summary: Imports ground vehicle data from the War Thunder Vehicles API into local tanks.json.
// Structure: fetch remote vehicles -> filter ground types -> map to local tank schema -> validate -> safe write results.
// Usage: Run with `node scripts/import-warthunder-vehicles.js` or `npm run import-wt` to refresh tank definitions.
// ---------------------------------------------------------------------------

import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { validateTank } from '../tanksfornothing-server.js';

// War Thunder Vehicles API endpoint. Adjust if the upstream service changes.
const API_URL = 'https://wt.warthunder.com/encyclopedia/api/vehicles/';

// Resolve path to data/tanks.json relative to this script.
const dataDir = new URL('../data/', import.meta.url);
const tanksFile = new URL('tanks.json', dataDir);

/**
 * Safely write JSON data to disk by writing to a temporary file and renaming.
 * This prevents corruption if the process exits mid-write.
 */
async function safeWriteJson(fileUrl, obj) {
  const filePath = fileURLToPath(fileUrl);
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(obj, null, 2));
  await fs.rename(tmpPath, filePath);
}

/** Determine whether an API vehicle entry represents a ground vehicle. */
function isGroundVehicle(v) {
  const type = String(v?.type || v?.vehicleType || '').toLowerCase();
  return type.includes('ground') || type.includes('tank');
}

/** Map a War Thunder vehicle object to the local tank schema used by the game. */
function mapVehicleToTank(v) {
  return {
    name: String(v?.name || 'Unnamed'),
    nation: String(v?.country || 'Neutral'),
    br: Number(v?.br) || 1,
    class: String(v?.class || 'Light Tank'),
    armor: Number(v?.hull_armor?.front) || 50,
    turretArmor: Number(v?.turret_armor?.front) || 50,
    cannonCaliber: Number(v?.weapon?.caliber) || 75,
    ammo: ['AP'], // Placeholder ammo type; adjust when API provides ammo details.
    ammoCapacity: 50,
    barrelLength: 3,
    mainCannonFireRate: 6,
    turretXPercent: 50,
    turretYPercent: 50,
    crew: Number(v?.crew) || 4,
    engineHp: Number(v?.engine_power) || 500,
    maxSpeed: Number(v?.max_speed) || 40,
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
  };
}

/** Main importer routine. */
async function importVehicles() {
  console.log(`Fetching vehicles from ${API_URL}`);
  let res;
  try {
    res = await fetch(API_URL);
  } catch (err) {
    console.error('Network request failed:', err.message);
    throw err;
  }
  if (!res.ok) throw new Error(`API request failed with status ${res.status}`);

  const raw = await res.json();
  const vehicles = Array.isArray(raw) ? raw : raw.vehicles || [];
  console.log(`Retrieved ${vehicles.length} total vehicles`);

  const ground = vehicles.filter(isGroundVehicle);
  console.log(`Filtered to ${ground.length} ground vehicles`);

  const tanks = [];
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
  let fileData = { _comment: ['Imported from War Thunder Vehicles API'], tanks: [] };
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

