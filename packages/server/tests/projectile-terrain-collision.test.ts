// projectile-terrain-collision.test.ts
// Summary: Regression test ensuring level projectiles collide with non-zero terrain after physics normalisation.
// Structure: Initialise ServerWorldController with elevated terrain, fire a shell horizontally, step simulation until
//            an explosion occurs, and verify the collision is attributed to the terrain rather than a timeout.
// Usage: Compiled alongside other server tests via `npm run test --workspace @tanksfornothing/server`.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert';

import type { AmmoDefinition, TankDefinition, TerrainDefinition } from '../src/types.js';
import { TransformComponent } from '@tanksfornothing/shared';
import { ServerWorldController } from '../src/game/server-world.js';

test('level projectile impacts normalised terrain before timing out', () => {
  const ammo: AmmoDefinition = {
    name: 'TerrainTestShell',
    nation: 'Test',
    caliber: 75,
    armorPen: 100,
    type: 'AP',
    explosionRadius: 0,
    pen0: 100,
    pen100: 90,
    image: 'terrain-test.png',
    speed: 150,
    damage: 20,
    penetration: 100,
    explosion: 0
  };

  const tank: TankDefinition = {
    name: 'Terrain Regression Tank',
    nation: 'Test',
    br: 1,
    class: 'Medium Tank',
    armor: 30,
    turretArmor: 25,
    cannonCaliber: 75,
    ammo: [ammo.name],
    ammoCapacity: 5,
    barrelLength: 4,
    mainCannonFireRate: 10,
    crew: 3,
    engineHp: 400,
    maxSpeed: 30,
    maxReverseSpeed: 15,
    incline: 10,
    bodyRotation: 0,
    turretRotation: 45,
    maxTurretIncline: 15,
    maxTurretDecline: 10,
    horizontalTraverse: 0,
    bodyWidth: 3,
    bodyLength: 5,
    bodyHeight: 2,
    turretWidth: 2,
    turretLength: 3,
    turretHeight: 1,
    turretXPercent: 50,
    turretYPercent: 50
  };

  const elevatedTerrain: TerrainDefinition = {
    name: 'UnitTest Mesa',
    type: 'test',
    size: { x: 0, y: 0 },
    flags: {
      red: { a: null, b: null, c: null, d: null },
      blue: { a: null, b: null, c: null, d: null }
    },
    ground: [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ],
    elevation: [
      [2, 3, 2],
      [3, 4, 3],
      [2, 3, 2]
    ],
    palette: [
      { name: 'Test Soil', color: '#654321', traction: 1, viscosity: 0, texture: 'test.png' }
    ],
    noise: { scale: 1, amplitude: 0 },
    lighting: { sunPosition: { x: 0, y: 1, z: 0 }, sunColor: '#ffffff', ambientColor: '#222222' }
  };

  const controller = new ServerWorldController({
    getAmmo: () => [ammo],
    getTerrain: () => elevatedTerrain
  });

  const sessionId = 'terrain-session';
  controller.addPlayer(sessionId, 'TerrainTester', tank, { [ammo.name]: 5 }, 5);
  const metadata = controller.getMetadataForSession(sessionId);
  assert.ok(metadata, 'player metadata should be available for regression scenario');
  const entity = metadata.entity;

  const halfBodyHeight = (tank.bodyHeight ?? 0) / 2;
  TransformComponent.x[entity] = 0;
  TransformComponent.y[entity] = halfBodyHeight;
  TransformComponent.z[entity] = 0;
  TransformComponent.rot[entity] = 0;
  TransformComponent.turret[entity] = 0;
  TransformComponent.gun[entity] = 0;

  const internals = controller as unknown as {
    bodyByEntity: Map<number, { position: { set: (x: number, y: number, z: number) => void } }>;
  };
  const tankBody = internals.bodyByEntity.get(entity);
  assert.ok(tankBody, 'physics body should be registered for the player tank');
  tankBody.position.set(0, halfBodyHeight, 0);

  controller.queueFire(sessionId, ammo.name);

  let terrainImpactDetected = false;
  let timeoutReported = false;
  const maxSteps = 600; // ten seconds of simulation time, far beyond projectile lifetime
  for (let i = 0; i < maxSteps; i += 1) {
    const { explosions } = controller.step(1 / 60);
    if (explosions.some((explosion) => explosion.hitKind === 'terrain')) {
      terrainImpactDetected = true;
      break;
    }
    if (explosions.some((explosion) => explosion.hitKind === 'timeout')) {
      timeoutReported = true;
      break;
    }
  }

  assert.ok(!timeoutReported, 'projectile should not report a timeout before colliding with terrain');
  assert.ok(terrainImpactDetected, 'expected projectile to collide with terrain after normalisation');
});
