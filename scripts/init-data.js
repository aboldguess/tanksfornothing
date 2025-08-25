// init-data.js
// Summary: Ensures data directory plus tanks.json, nations.json, ammo.json and terrains.json exist for persistence.
// Structure: create data folder -> write default JSON files if missing.
// Usage: Run with `node scripts/init-data.js` prior to starting server.
// ---------------------------------------------------------------------------

import { promises as fs } from 'fs';
const dataDir = new URL('../data/', import.meta.url);
const tanksFile = new URL('tanks.json', dataDir);
const nationsFile = new URL('nations.json', dataDir);
const ammoFile = new URL('ammo.json', dataDir);
const terrainFile = new URL('terrains.json', dataDir);

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
        'Structure: JSON object with _comment array and tanks list.',
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
        'Summary: Persisted nation names for Tanks for Nothing.',
        'Structure: JSON object with _comment array and nations list.',
        'Usage: Managed automatically by server; do not edit manually.'
      ],
      nations: ['Neutral']
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
        'Structure: JSON object with _comment array and ammo list.',
        'Usage: Managed automatically by server; do not edit manually.'
      ],
      ammo: [
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
    const terrainData = {
      _comment: [
        'Summary: Persisted terrain details and selected index for Tanks for Nothing.',
        'Structure: JSON object with _comment array, current index and terrains list of {name,type,size}.',
        'Usage: Managed automatically by server; do not edit manually.'
      ],
      current: 0,
      terrains: [
        { name: 'flat', type: 'default', size: { x: 1, y: 1 } }
      ]
    };
    await fs.writeFile(terrainFile, JSON.stringify(terrainData, null, 2));
    console.log('Created data/terrains.json');
  }
}

init();
