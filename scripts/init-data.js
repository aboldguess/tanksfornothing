// init-data.js
// Summary: Ensures data directory and tanks.json exist for persistence.
// Structure: create data folder -> write default tanks.json if missing.
// Usage: Run with `node scripts/init-data.js` prior to starting server.
// ---------------------------------------------------------------------------

import { promises as fs } from 'fs';
const dataDir = new URL('../data/', import.meta.url);
const dataFile = new URL('tanks.json', dataDir);

async function init() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(dataFile);
    console.log('tanks.json already exists');
  } catch {
    const data = {
      _comment: [
        'Summary: Persisted tank definitions for Tanks for Nothing.',
        'Structure: JSON object with _comment array and tanks list.',
        'Usage: Managed automatically by server; do not edit manually.'
      ],
      tanks: []
    };
    await fs.writeFile(dataFile, JSON.stringify(data, null, 2));
    console.log('Created data/tanks.json');
  }
}

init();
