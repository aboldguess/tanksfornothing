// projectile-tank-sweep.test.ts
// Summary: Regression test verifying swept projectile collision detection registers tank impacts
//          before terrain, applying damage and explosion telemetry to the struck vehicle.
// Structure: Spawn two tanks facing each other, fire a shell down the cannon axis, step the
//            simulation until a collision occurs, and confirm the resulting explosion metadata
//            and health updates target the victim tank.
// Usage: Executed alongside the server test suite via `npm run test --workspace @tanksfornothing/server`.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert';

import type { AmmoDefinition, TankDefinition } from '../src/types.js';
import {
  TransformComponent,
  TargetComponent,
  HealthComponent
} from '@tanksfornothing/shared';
import { ServerWorldController } from '../src/game/server-world.js';

const ammo: AmmoDefinition = {
  name: 'TankSweepShell',
  nation: 'Test',
  caliber: 88,
  armorPen: 150,
  type: 'AP',
  explosionRadius: 0,
  pen0: 150,
  pen100: 130,
  image: 'tank-sweep.png',
  speed: 250,
  damage: 35,
  penetration: 150,
  explosion: 10
};

const tank: TankDefinition = {
  name: 'Collision Regression Tank',
  nation: 'Test',
  br: 2,
  class: 'Heavy Tank',
  armor: 120,
  turretArmor: 100,
  cannonCaliber: 88,
  ammo: [ammo.name],
  ammoCapacity: 5,
  barrelLength: 6,
  mainCannonFireRate: 6,
  crew: 5,
  engineHp: 650,
  maxSpeed: 28,
  maxReverseSpeed: 12,
  incline: 10,
  bodyRotation: 0,
  turretRotation: 45,
  maxTurretIncline: 15,
  maxTurretDecline: 10,
  horizontalTraverse: 0,
  bodyWidth: 3.2,
  bodyLength: 6.4,
  bodyHeight: 2.4,
  turretWidth: 2.8,
  turretLength: 3.4,
  turretHeight: 1.6,
  turretXPercent: 50,
  turretYPercent: 50
};

test('swept projectile collisions damage tanks before touching terrain', () => {
  const controller = new ServerWorldController({
    getAmmo: () => [ammo],
    getTerrain: () => null
  });

  controller.addPlayer('shooter-session', 'Shooter', tank, { [ammo.name]: 5 }, 5);
  controller.addPlayer('target-session', 'Target', tank, { [ammo.name]: 0 }, 0);

  const shooterMeta = controller.getMetadataForSession('shooter-session');
  const targetMeta = controller.getMetadataForSession('target-session');
  assert.ok(shooterMeta, 'shooter metadata should exist after adding player');
  assert.ok(targetMeta, 'target metadata should exist after adding player');

  const shooterEntity = shooterMeta.entity;
  const targetEntity = targetMeta.entity;

  const halfBodyHeight = (tank.bodyHeight ?? 0) / 2;
  const targetBaseline = halfBodyHeight;

  TransformComponent.x[shooterEntity] = 0;
  TransformComponent.y[shooterEntity] = halfBodyHeight;
  TransformComponent.z[shooterEntity] = 0;
  TransformComponent.rot[shooterEntity] = 0;
  TransformComponent.turret[shooterEntity] = 0;
  TransformComponent.gun[shooterEntity] = 0;

  TransformComponent.x[targetEntity] = 0;
  TransformComponent.y[targetEntity] = targetBaseline;
  TransformComponent.z[targetEntity] = -30;
  TransformComponent.rot[targetEntity] = 0;
  TransformComponent.turret[targetEntity] = 0;
  TransformComponent.gun[targetEntity] = 0;

  TargetComponent.x[shooterEntity] = TransformComponent.x[shooterEntity];
  TargetComponent.y[shooterEntity] = TransformComponent.y[shooterEntity];
  TargetComponent.z[shooterEntity] = TransformComponent.z[shooterEntity];
  TargetComponent.rot[shooterEntity] = TransformComponent.rot[shooterEntity];
  TargetComponent.turret[shooterEntity] = TransformComponent.turret[shooterEntity];
  TargetComponent.gun[shooterEntity] = TransformComponent.gun[shooterEntity];

  TargetComponent.x[targetEntity] = TransformComponent.x[targetEntity];
  TargetComponent.y[targetEntity] = TransformComponent.y[targetEntity];
  TargetComponent.z[targetEntity] = TransformComponent.z[targetEntity];
  TargetComponent.rot[targetEntity] = TransformComponent.rot[targetEntity];
  TargetComponent.turret[targetEntity] = TransformComponent.turret[targetEntity];
  TargetComponent.gun[targetEntity] = TransformComponent.gun[targetEntity];

  const internals = controller as unknown as {
    bodyByEntity: Map<
      number,
      {
        position: { set: (x: number, y: number, z: number) => void };
        quaternion: { setFromEuler: (x: number, y: number, z: number) => void };
      }
    >;
  };

  const shooterBody = internals.bodyByEntity.get(shooterEntity);
  const targetBody = internals.bodyByEntity.get(targetEntity);
  assert.ok(shooterBody, 'physics body should exist for shooter tank');
  assert.ok(targetBody, 'physics body should exist for target tank');

  shooterBody.position.set(
    TransformComponent.x[shooterEntity],
    TransformComponent.y[shooterEntity],
    TransformComponent.z[shooterEntity]
  );
  shooterBody.quaternion.setFromEuler(0, TransformComponent.rot[shooterEntity], 0);
  targetBody.position.set(
    TransformComponent.x[targetEntity],
    TransformComponent.y[targetEntity],
    TransformComponent.z[targetEntity]
  );
  targetBody.quaternion.setFromEuler(0, TransformComponent.rot[targetEntity], 0);

  controller.queueFire('shooter-session', ammo.name);

  let explosionTelemetry: ReturnType<ServerWorldController['step']>['explosions'][number] | null = null;
  let reportedDamage: ReturnType<ServerWorldController['step']>['damage'] | null = null;
  const maxSteps = 600;

  for (let i = 0; i < maxSteps; i += 1) {
    const result = controller.step(1 / 60);
    if (result.explosions.length > 0) {
      explosionTelemetry = result.explosions[0];
      reportedDamage = result.damage;
      break;
    }
  }

  assert.ok(explosionTelemetry, 'projectile should explode before timing out');
  assert.strictEqual(explosionTelemetry.hitKind, 'tank', 'sweep collision should register a tank hit');
  assert.strictEqual(
    explosionTelemetry.hitSessionId,
    targetMeta.sessionId,
    'explosion telemetry should reference the struck target session'
  );

  assert.ok(reportedDamage && reportedDamage.length > 0, 'damage array should include tank damage entry');
  const victimDamage = reportedDamage.find((entry) => entry.sessionId === targetMeta.sessionId);
  assert.ok(victimDamage, 'tank sweep should apply damage to the target session');
  assert.strictEqual(victimDamage.shooter, shooterMeta.sessionId, 'damage telemetry should record shooter session id');

  const remainingHealth = HealthComponent.current[targetEntity];
  assert.ok(
    remainingHealth < 100,
    `expected target health to decrease from 100, but received ${remainingHealth}`
  );

  const halfLength = (tank.bodyLength ?? 0) / 2;
  const halfWidth = (tank.bodyWidth ?? 0) / 2;
  const turretHeight = tank.turretHeight ?? 0;
  const minY = TransformComponent.y[targetEntity] - halfBodyHeight;
  const maxY = TransformComponent.y[targetEntity] + halfBodyHeight + turretHeight;

  assert.ok(
    Math.abs(explosionTelemetry.x - TransformComponent.x[targetEntity]) <= halfWidth + 1,
    'explosion X position should fall within target width bounds'
  );
  assert.ok(
    Math.abs(explosionTelemetry.z - TransformComponent.z[targetEntity]) <= halfLength + 1,
    'explosion Z position should fall within target length bounds'
  );
  assert.ok(
    explosionTelemetry.y >= minY - 0.5 && explosionTelemetry.y <= maxY + 0.5,
    'explosion Y position should align with combined hull and turret height'
  );
});
