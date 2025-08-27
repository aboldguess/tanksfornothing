// turret-traverse.test.js
// Summary: Verifies that only tank destroyers retain horizontal turret traverse limits.
// Structure: spawn server -> fetch tank list -> assert non-TDs report 0 traverse and TDs keep their limit.
// Usage: run with `npm test` which executes `node --test`.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert';

process.env.PORT = 0; // use random available port
const { server } = await import('../tanksfornothing-server.js');
await new Promise(resolve => server.on('listening', resolve));
const base = `http://localhost:${server.address().port}`;

test.after(() => server.close());

// Helper to fetch tank data once
async function getTanks() {
  const res = await fetch(`${base}/api/tanks`);
  return res.json();
}

test('non tank destroyers rotate freely', async () => {
  const list = await getTanks();
  const nonTD = list.find(t => t.class !== 'Tank Destroyer');
  assert.ok(nonTD, 'expected at least one non-tank-destroyer');
  assert.strictEqual(nonTD.horizontalTraverse, 0);
});

test('tank destroyers retain traverse limit', async () => {
  const list = await getTanks();
  const td = list.find(t => t.class === 'Tank Destroyer');
  assert.ok(td, 'expected at least one tank destroyer');
  assert.ok(td.horizontalTraverse > 0);
});
