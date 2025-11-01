// muzzle-clearance.test.ts
// Summary: Validates muzzle spawn logic including depressed cannon clearance and yaw-rotated turret offsets.
// Structure: Bootstraps a ServerWorldController, first forcing a steep gun depression to check terrain clearance,
//            then rotating a hull with an asymmetric turret placement to ensure muzzle origins rotate correctly.
// Usage: Executed via `npm test` which compiles the workspace then runs Node's test runner over dist/tests.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert';

import type { AmmoDefinition, TankDefinition } from '../src/types.js';
import { TransformComponent, TankStatsComponent, ProjectileComponent } from '@tanksfornothing/shared';
import { MUZZLE_TERRAIN_CLEARANCE, ServerWorldController } from '../src/game/server-world.js';

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
  // The production tank catalogue stores decline as a positive magnitude, so mirror that
  // convention here to ensure the server normalises it into a negative clamp value.
  maxTurretDecline: 15,
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
  assert.strictEqual(
    TankStatsComponent.gunDepression[entity],
    -tank.maxTurretDecline,
    'gun depression should be stored as a negative degree magnitude'
  );
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
  const halfBodyHeight = (TankStatsComponent.bodyHeight[entity] ?? tank.bodyHeight ?? 0) / 2;
  const clearanceFloor = tankBaseline - halfBodyHeight + MUZZLE_TERRAIN_CLEARANCE;

  assert.ok(
    muzzleY >= clearanceFloor - 1e-3,
    `expected muzzle height ${muzzleY} to stay above clearance floor ${clearanceFloor}`
  );
  assert.ok(
    Math.abs(muzzleY - clearanceFloor) < 1e-3,
    'steep depression should clamp muzzle precisely to the clearance floor above terrain'
  );

  const projectileBody = controllerInternals.projectileBodies.values().next().value;
  assert.ok(projectileBody, 'physics body should be created for the projectile');
  assert.ok(
    projectileBody.position.y >= clearanceFloor - 1e-3,
    `expected projectile body spawn height ${projectileBody.position.y} to stay above clearance ${clearanceFloor}`
  );
  assert.ok(
    Math.abs(projectileBody.position.y - clearanceFloor) < 1e-3,
    'physics spawn height should mirror the clamped muzzle height'
  );

  const verticalVelocity = ProjectileComponent.vy[projectileEntity];
  assert.ok(
    verticalVelocity < 0,
    `expected depressed shot to start descending, but vy=${verticalVelocity} was not negative`
  );
});

test('muzzle origin rotates asymmetric turret offsets with hull yaw', () => {
  const controller = new ServerWorldController({
    getAmmo: () => [ammo],
    getTerrain: () => null
  });

  controller.addPlayer('session-yaw', 'RotatedTester', tank, { [ammo.name]: 1 }, 1);
  const playerMeta = controller.getMetadataForSession('session-yaw');
  assert.ok(playerMeta, 'player metadata should exist for rotated hull scenario');

  const entity = playerMeta.entity;
  TransformComponent.x[entity] = 12.5;
  TransformComponent.y[entity] = 1.25;
  TransformComponent.z[entity] = -3.75;
  TransformComponent.rot[entity] = Math.PI / 4; // 45° hull yaw.
  TransformComponent.turret[entity] = 0;
  TransformComponent.gun[entity] = 0;

  playerMeta.tank.turretXPercent = 30;
  playerMeta.tank.turretYPercent = 65;
  playerMeta.tank.bodyWidth = Number.NaN;
  playerMeta.tank.bodyLength = Number.NaN;

  const controllerInternals = controller as unknown as {
    processFireRequest: (entity: number, request: { ammoName: string }) => boolean;
    projectileMetadata: Map<string, { entity: number }>;
  };

  const fired = controllerInternals.processFireRequest(entity, { ammoName: ammo.name });
  assert.ok(fired, 'fire request should succeed for rotated hull scenario');

  const projectiles = [...controllerInternals.projectileMetadata.values()];
  assert.strictEqual(projectiles.length, 1, 'one projectile should spawn from the rotated shot');

  const projectileEntity = projectiles[0].entity;
  const muzzleX = TransformComponent.x[projectileEntity];
  const muzzleY = TransformComponent.y[projectileEntity];
  const muzzleZ = TransformComponent.z[projectileEntity];

  const hullYaw = TransformComponent.rot[entity] || 0;
  const turretYaw = TransformComponent.turret[entity] || 0;
  const yaw = hullYaw + turretYaw;
  const pitch = TransformComponent.gun[entity] || 0;
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const sinHullYaw = Math.sin(hullYaw);
  const cosHullYaw = Math.cos(hullYaw);
  const barrelLen = playerMeta.tank.barrelLength || TankStatsComponent.barrelLength[entity] || 3;
  const turretYOffset = (playerMeta.tank.turretYPercent ?? 50) / 100 - 0.5;
  const turretXOffset = 0.5 - (playerMeta.tank.turretXPercent ?? 50) / 100;
  const bodyWidth = TankStatsComponent.bodyWidth[entity] ?? tank.bodyWidth ?? 0;
  const bodyLength = TankStatsComponent.bodyLength[entity] ?? tank.bodyLength ?? 0;
  const offsetRight = turretYOffset * bodyWidth;
  const offsetForward = turretXOffset * bodyLength;
  const rotatedOffsetX = offsetRight * cosHullYaw - offsetForward * sinHullYaw;
  const rotatedOffsetZ = offsetRight * sinHullYaw + offsetForward * cosHullYaw;
  const muzzleDirectionX = -sinYaw * cosPitch;
  const muzzleDirectionY = sinPitch;
  const muzzleDirectionZ = -cosYaw * cosPitch;
  const baselineY = TransformComponent.y[entity] || 0;
  const bodyHeight =
    Number.isFinite(playerMeta.tank.bodyHeight) && typeof playerMeta.tank.bodyHeight === 'number'
      ? playerMeta.tank.bodyHeight
      : TankStatsComponent.bodyHeight[entity] || 0;
  const turretHeightMeta = playerMeta.tank.turretHeight;
  const turretHeight =
    typeof turretHeightMeta === 'number' && Number.isFinite(turretHeightMeta)
      ? turretHeightMeta
      : TankStatsComponent.turretHeight[entity] || 0;
  const halfBodyHeight = Math.max(0, bodyHeight) * 0.5;
  const halfTurretHeight = Math.max(0, turretHeight) * 0.5;
  const pivotY = baselineY + halfBodyHeight + halfTurretHeight;
  // Reconstruct the authoritative computeMuzzle math so we can assert the world offset incorporates hull yaw.
  const expectedX = TransformComponent.x[entity] + rotatedOffsetX + muzzleDirectionX * barrelLen;
  const expectedY = pivotY + muzzleDirectionY * barrelLen;
  const expectedZ = TransformComponent.z[entity] + rotatedOffsetZ + muzzleDirectionZ * barrelLen;

  const precision = 1e-6;
  assert.ok(Math.abs(muzzleX - expectedX) < precision, `expected muzzle x ${expectedX}, got ${muzzleX}`);
  assert.ok(Math.abs(muzzleY - expectedY) < precision, `expected muzzle y ${expectedY}, got ${muzzleY}`);
  assert.ok(Math.abs(muzzleZ - expectedZ) < precision, `expected muzzle z ${expectedZ}, got ${muzzleZ}`);
});
