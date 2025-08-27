// terrain.test.js
// Summary: Integration tests for default terrain setup and editing through the REST API.
// Structure: spawn server on random port -> verify default terrain exists -> update terrain and confirm change.
// Usage: run with `npm test` which executes `node --test`.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'node:fs';
import { generateGentleHills } from '../utils/terrain-noise.js';

process.env.PORT = 0; // allow system to choose an open port
const terrainFile = new URL('../data/terrains.json', import.meta.url);
const elevation = generateGentleHills(20, 20);
const ground = Array.from({ length: 20 }, () => Array(20).fill(0));
const seed = {
  _comment: [
    'Summary: Persisted terrain details and selected index for Tanks for Nothing.',
    'Structure: JSON object with _comment array, current index and terrains list of {name,type,size,flags,ground,elevation}.',
    'Usage: Managed automatically by server; do not edit manually.'
  ],
  current: 0,
  terrains: [{
    name: 'Gentle Hills',
    type: 'fields',
    size: { x: 1, y: 1 },
    flags: { red: { a: null, b: null, c: null, d: null }, blue: { a: null, b: null, c: null, d: null } },
    ground,
    elevation
  }]
};
await fs.writeFile(terrainFile, JSON.stringify(seed, null, 2));

const { server } = await import('../tanksfornothing-server.js');
await new Promise(resolve => server.on('listening', resolve));
const base = `http://localhost:${server.address().port}`;

// Ensure server closed after tests complete
test.after(() => server.close());

test('default terrain exists', async () => {
  const res = await fetch(`${base}/api/terrains`);
  const data = await res.json();
  assert.ok(Array.isArray(data.terrains) && data.terrains.length > 0);
  assert.equal(data.terrains[0].name, 'Gentle Hills');
});

test('terrain can be edited', async () => {
  const res = await fetch(`${base}/api/terrains`);
  const data = await res.json();
  const first = data.terrains[0];
  const updated = { ...first, name: 'Edited Hills' };
  const putRes = await fetch(`${base}/api/terrains/0`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: 'admin=true' },
    body: JSON.stringify(updated)
  });
  assert.equal(putRes.status, 200);
  const verify = await fetch(`${base}/api/terrains`);
  const after = await verify.json();
  assert.equal(after.terrains[0].name, 'Edited Hills');
});
