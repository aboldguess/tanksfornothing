// turret-traverse.test.ts
// Summary: Verifies that only tank destroyers retain horizontal turret traverse limits.
// Structure: spawn server -> fetch tank list -> assert non-TDs report 0 traverse and TDs keep their limit.
// Usage: run with `npm test` which executes `node --test packages/server/dist/tests` after building the workspace.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert';
import type { AddressInfo } from 'node:net';

process.env.PORT = '0'; // use random available port
const { server } = await import('../src/tanksfornothing-server.js');
await new Promise<void>((resolve, reject) => {
  const onError = (error: Error) => {
    server.off('error', onError);
    reject(error);
  };
  server.once('error', onError);
  server.listen(0, () => {
    server.off('error', onError);
    resolve();
  });
});
const address = server.address();
const port = typeof address === 'object' && address !== null ? (address as AddressInfo).port : 0;
const base = `http://localhost:${port}`;

test.after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

// Helper to fetch tank data once
async function getTanks() {
  const res = await fetch(`${base}/api/tanks`);
  return res.json() as Promise<any>;
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
