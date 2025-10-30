// muzzle-clearance.test.ts
// Summary: Ensures depressed cannon shots spawn their muzzle and physics bodies above the ground plane.
// Structure: Bootstraps a ServerWorldController with a single tank, forces a steep gun depression, fires once,
//            and checks both ECS and physics spawn heights against the tank's terrain baseline.
// Usage: Executed via `npm test` which compiles the workspace then runs Node's test runner over dist/tests.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert';

import type { AmmoDefinition, TankDefinition } from '../src/types.js';
import { TransformComponent } from '@tanksfornothing/shared';
import { ServerWorldController } from '../src/game/server-world.js';

const ammo: AmmoDefinition = {
  name: 'UnitTestShell',
  nation: 'Test',
  caliber: 75,
  armorPen: 120,
  type: 'AP',
  explosionRadius: 0,
  pen0: 120,
  pen100: 100,
  image: 'unit-test.png',
  speed: 900,
  damage: 10,
  penetration: 120,
  explosion: 0
};

const tank: TankDefinition = {
  name: 'UnitTest Tank',
  nation: 'Test',
  br: 1,
  class: 'Medium Tank',
  armor: 50,
  turretArmor: 45,
  cannonCaliber: 75,
  ammo: [ammo.name],
  ammoCapacity: 1,
  barrelLength: 5,
  mainCannonFireRate: 10,
  crew: 4,
  engineHp: 500,
  maxSpeed: 40,
  maxReverseSpeed: 20,
  incline: 10,
  bodyRotation: 0,
  turretRotation: 60,
  maxTurretIncline: 20,
  maxTurretDecline: -15,
  horizontalTraverse: 0,
  bodyWidth: 3,
  bodyLength: 6,
  bodyHeight: 2,
  turretWidth: 2,
  turretLength: 3,
  turretHeight: 1,
  turretXPercent: 50,
  turretYPercent: 50
};

test('muzzle height clamps to terrain during steep depression', () => {
  const controller = new ServerWorldController({
    getAmmo: () => [ammo],
    getTerrain: () => null
  });

  controller.addPlayer('session', 'Tester', tank, { [ammo.name]: 1 }, 1);
  const playerMeta = controller.getMetadataForSession('session');
  assert.ok(playerMeta, 'player metadata should exist after adding a player');

  const entity = playerMeta.entity;
  TransformComponent.y[entity] = 0;
  TransformComponent.rot[entity] = 0;
  TransformComponent.turret[entity] = 0;
  TransformComponent.gun[entity] = (-60 * Math.PI) / 180;

  // Force metadata turret height to NaN so the compute routine exercises the TankStats fallback path.
  playerMeta.tank.turretHeight = Number.NaN;

  // Reach into the controller internals to synchronously invoke the fire logic and inspect spawned projectiles.
  const controllerInternals = controller as unknown as {
    processFireRequest: (entity: number, request: { ammoName: string }) => boolean;
    projectileMetadata: Map<string, { entity: number }>;
    projectileBodies: Map<string, { position: { y: number } }>;
  };

  const fired = controllerInternals.processFireRequest(entity, { ammoName: ammo.name });
  assert.ok(fired, 'fire request should succeed with valid ammo');

  const projectiles = [...controllerInternals.projectileMetadata.values()];
  assert.strictEqual(projectiles.length, 1, 'one projectile should spawn from the shot');

  const projectileEntity = projectiles[0].entity;
  const muzzleY = TransformComponent.y[projectileEntity];
  const tankBaseline = TransformComponent.y[entity];

  assert.ok(
    muzzleY >= tankBaseline,
    `expected muzzle height ${muzzleY} to stay above terrain baseline ${tankBaseline}`
  );
  assert.strictEqual(
    muzzleY,
    tankBaseline,
    'steep depression should clamp muzzle exactly to the baseline when it would otherwise dip underground'
  );

  const projectileBody = controllerInternals.projectileBodies.values().next().value;
  assert.ok(projectileBody, 'physics body should be created for the projectile');
  assert.ok(
    projectileBody.position.y >= tankBaseline,
    `expected projectile body spawn height ${projectileBody.position.y} to stay above baseline ${tankBaseline}`
  );
  assert.ok(
    Math.abs(projectileBody.position.y - tankBaseline) < 1e-6,
    'physics spawn height should mirror the clamped muzzle height'
  );
});
