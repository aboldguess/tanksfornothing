// init-data.js
// Summary: Ensures data directory plus tanks.json and nations.json exist for persistence.
// Structure: create data folder -> write default tanks.json and nations.json if missing.
// Usage: Run with `node scripts/init-data.js` prior to starting server.
// ---------------------------------------------------------------------------

import { promises as fs } from 'fs';
const dataDir = new URL('../data/', import.meta.url);
const tanksFile = new URL('tanks.json', dataDir);
const nationsFile = new URL('nations.json', dataDir);

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
      nations: []
    };
    await fs.writeFile(nationsFile, JSON.stringify(nationsData, null, 2));
    console.log('Created data/nations.json');
  }
}

init();
