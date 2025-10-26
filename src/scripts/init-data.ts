// init-data.ts
// Summary: Ensures data directory plus tanks.json, nations.json, ammo.json and terrains.json exist for persistence.
// Structure: create data folder -> write default JSON files if missing.
// Usage: Run with `npm run setup` or `node dist/scripts/init-data.js` prior to starting the server.
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs';
import { generateGentleHills } from '../utils/terrain-noise.js';

const projectRoot = new URL('../../', import.meta.url);
const dataDir = new URL('./data/', projectRoot);
const tanksFile = new URL('tanks.json', dataDir);
const nationsFile = new URL('nations.json', dataDir);
const ammoFile = new URL('ammo.json', dataDir);
const terrainFile = new URL('terrains.json', dataDir);
const usersFile = new URL('users.json', dataDir);

async function init() {
  await fs.mkdir(dataDir, { recursive: true });
  // Ensure tanks.json exists
  try {
    await fs.access(tanksFile);
    console.log('tanks.json already exists');
  } catch {
    const tanksData = {
      _comment: [
        'Summary: Persisted tank definitions for Tanks for Nothing.',
        'Structure: JSON object with _comment array and tanks list including ammoCapacity, cannonCaliber, barrelLength, mainCannonFireRate, turretXPercent and turretYPercent.',
        'Usage: Managed automatically by server; do not edit manually.'
      ],
      tanks: []
    };
    await fs.writeFile(tanksFile, JSON.stringify(tanksData, null, 2));
    console.log('Created data/tanks.json');
  }

  // Ensure nations.json exists
  try {
    await fs.access(nationsFile);
    console.log('nations.json already exists');
  } catch {
    const nationsData = {
      _comment: [
        'Summary: Persisted nation definitions for Tanks for Nothing.',
        'Structure: JSON object with _comment array and nations list of {name,flag}.',
        'Usage: Managed automatically by server; do not edit manually.'
      ],
      nations: [{ name: 'Neutral', flag: '' }]
    };
    await fs.writeFile(nationsFile, JSON.stringify(nationsData, null, 2));
    console.log('Created data/nations.json');
  }

  // Ensure ammo.json exists
  try {
    await fs.access(ammoFile);
    console.log('ammo.json already exists');
  } catch {
    const ammoData = {
      _comment: [
        'Summary: Persisted ammunition definitions for Tanks for Nothing.',
        'Structure: JSON object with _comment array and ammo list including image paths.',
        'Usage: Managed automatically by server; do not edit manually.'
      ],
      ammo: [
        {
          name: 'AP',
          nation: 'Neutral',
          caliber: 75,
          armorPen: 100,
          type: 'AP',
          explosionRadius: 0,
          pen0: 100,
          pen100: 80,
          speed: 900,
          damage: 100,
          penetration: 100,
          explosion: 0,
          image: ''
        },
        {
          name: 'HE',
          nation: 'Neutral',
          caliber: 75,
          armorPen: 30,
          type: 'HE',
          explosionRadius: 50,
          pen0: 30,
          pen100: 20,
          speed: 600,
          damage: 30,
          penetration: 30,
          explosion: 50,
          image: ''
        },
        {
          name: 'HEAT',
          nation: 'Neutral',
          caliber: 90,
          armorPen: 150,
          type: 'HEAT',
          explosionRadius: 40,
          pen0: 150,
          pen100: 140,
          speed: 700,
          damage: 150,
          penetration: 150,
          explosion: 40,
          image: ''
        },
        {
          name: 'Smoke',
          nation: 'Neutral',
          caliber: 75,
          armorPen: 20,
          type: 'Smoke',
          explosionRadius: 0,
          pen0: 20,
          pen100: 20,
          speed: 300,
          damage: 20,
          penetration: 20,
          explosion: 0,
          image: ''
        }
      ]
    };
    await fs.writeFile(ammoFile, JSON.stringify(ammoData, null, 2));
    console.log('Created data/ammo.json');
  }

  // Ensure terrains.json exists
  try {
    await fs.access(terrainFile);
    console.log('terrains.json already exists');
  } catch {
    const elevation = generateGentleHills(20, 20);
    const ground = Array.from({ length: 20 }, () => Array(20).fill(0));
    const terrainData = {
      _comment: [
        'Summary: Persisted terrain details and selected index for Tanks for Nothing.',
        'Structure: JSON object with _comment array, current index and terrains list of {name,type,size,flags,ground,elevation}.',
        'Usage: Managed automatically by server; do not edit manually.'
      ],
      current: 0,
      terrains: [
        {
          name: 'Gentle Hills',
          type: 'fields',
          size: { x: 1, y: 1 },
          flags: {
            red: { a: null, b: null, c: null, d: null },
            blue: { a: null, b: null, c: null, d: null }
          },
          ground,
          elevation
        }
      ]
    };
    await fs.writeFile(terrainFile, JSON.stringify(terrainData, null, 2));
    console.log('Created data/terrains.json');
  }

  // Ensure users.json exists
  try {
    await fs.access(usersFile);
    console.log('users.json already exists');
  } catch {
    const usersData = {
      _comment: [
        'Summary: Persisted user accounts for Tanks for Nothing.',
        'Structure: JSON object with _comment array and users list of {username,passwordHash,stats}.',
        'Usage: Managed automatically by server; do not edit manually.'
      ],
      users: []
    };
    await fs.writeFile(usersFile, JSON.stringify(usersData, null, 2));
    console.log('Created data/users.json');
  }
}

init();
