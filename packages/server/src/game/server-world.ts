// server-world.ts
// Summary: Authoritative ECS controller used by TanksForNothingRoom to manage player and
//          projectile entities, run movement/cooldown systems, and serialise snapshots into the
//          shared Colyseus state.
// Structure: Encapsulates bitecs world management plus metadata/bookkeeping maps so the room
//            can remain focused on networking concerns. Exposes high-level methods for spawning
//            players, applying input targets, handling fire requests, ticking the simulation, and
//            synchronising Colyseus schema buffers.
// Usage: Instantiated once per room; TanksForNothingRoom delegates to the instance for all ECS
//        operations before forwarding resulting events to connected clients.
// ---------------------------------------------------------------------------

import {
  addComponent,
  hasComponent
} from 'bitecs';
import {
  AmmoStateComponent,
  CooldownComponent,
  GameWorld,
  PlayerTagComponent,
  ProjectileComponent,
  TankStatsComponent,
  TargetComponent,
  TransformComponent,
  VelocityComponent,
  HealthComponent,
  createEntity,
  createGameWorld,
  destroyEntity,
  writePlayerRuntimeBuffer,
  writeProjectileRuntimeBuffer,
  type PlayerMetadata,
  type ProjectileMetadata,
  type TankSnapshot,
  cloneAmmoLoadout,
  PlayerMetadataSchema,
  TanksForNothingState
} from '@tanksfornothing/shared';

import { ContactEquation, Vec3 } from 'cannon-es';

import { PhysicsWorldManager, type PhysicsBody } from './physics-world.js';

import type { AmmoDefinition, TankDefinition, TerrainDefinition } from '../types.js';

interface PlayerTargetPayload {
  x?: number;
  y?: number;
  z?: number;
  rot?: number;
  turret?: number;
  gun?: number;
}

interface FireRequest {
  ammoName: string;
}

interface ExplosionTelemetry {
  id: string;
  x: number;
  y: number;
  z: number;
  ammoName: string;
  shooterSessionId: string | null;
  hitKind: 'terrain' | 'tank' | 'timeout' | 'cleanup' | 'lost' | 'unknown';
  hitSessionId: string | null;
  distanceTravelled: number;
  travelTimeMs: number;
  impactSpeed: number;
  impactVelocity: { x: number; y: number; z: number };
}

interface StepResult {
  explosions: ExplosionTelemetry[];
  damage: Array<{ sessionId: string; health: number; shooter: string | null }>;
  kills: Array<{ shooter: string | null; victim: string }>;
}

interface BodyCollisionEvent {
  body: PhysicsBody;
  target: PhysicsBody;
  contact: ContactEquation;
}

interface ServerWorldOptions {
  getAmmo: () => AmmoDefinition[];
  getTerrain?: () => TerrainDefinition | null;
}

const GRAVITY = -9.81;
const PROJECTILE_LIFETIME = 5;
export const MUZZLE_TERRAIN_CLEARANCE = 0.05;

export class ServerWorldController {
  readonly world: GameWorld;
  private readonly playerEntities = new Map<string, number>();
  private readonly metadata = new Map<string, PlayerMetadata>();
  private readonly projectileMetadata = new Map<string, ProjectileMetadata>();
  private readonly fireRequests = new Map<number, FireRequest>();
  private readonly ammoByName = new Map<string, AmmoDefinition>();
  private readonly physics: PhysicsWorldManager;
  private readonly bodyByEntity = new Map<number, PhysicsBody>();
  private readonly projectileBodies = new Map<string, PhysicsBody>();
  private readonly projectileCollisionHandlers = new Map<string, (event: BodyCollisionEvent) => void>();
  private readonly destroyedProjectiles = new Set<string>();
  private activeExplosions: StepResult['explosions'] | null = null;
  private activeDamage: StepResult['damage'] | null = null;
  private activeKills: StepResult['kills'] | null = null;

  constructor(private readonly options: ServerWorldOptions) {
    this.world = createGameWorld();
    this.physics = new PhysicsWorldManager(GRAVITY);
    this.physics.rebuildTerrain(options.getTerrain ? options.getTerrain() : null);
    for (const ammo of options.getAmmo()) {
      this.ammoByName.set(ammo.name, ammo);
    }
  }

  setTerrain(definition: TerrainDefinition | null): void {
    this.physics.rebuildTerrain(definition);
  }

  refreshAmmoCatalog(): void {
    this.ammoByName.clear();
    for (const ammo of this.options.getAmmo()) {
      this.ammoByName.set(ammo.name, ammo);
    }
  }

  addPlayer(
    sessionId: string,
    username: string,
    tank: TankDefinition,
    loadout: Record<string, number>,
    ammoRemaining: number
  ): void {
    const entity = createEntity(this.world);
    this.playerEntities.set(sessionId, entity);

    addComponent(this.world, PlayerTagComponent, entity);
    addComponent(this.world, TransformComponent, entity);
    addComponent(this.world, TargetComponent, entity);
    addComponent(this.world, VelocityComponent, entity);
    addComponent(this.world, HealthComponent, entity);
    addComponent(this.world, AmmoStateComponent, entity);
    addComponent(this.world, CooldownComponent, entity);
    addComponent(this.world, TankStatsComponent, entity);

    TransformComponent.x[entity] = 0;
    TransformComponent.y[entity] = 0;
    TransformComponent.z[entity] = 0;
    TransformComponent.rot[entity] = 0;
    TransformComponent.turret[entity] = 0;
    TransformComponent.gun[entity] = 0;

    TargetComponent.x[entity] = 0;
    TargetComponent.y[entity] = 0;
    TargetComponent.z[entity] = 0;
    TargetComponent.rot[entity] = 0;
    TargetComponent.turret[entity] = 0;
    TargetComponent.gun[entity] = 0;

    VelocityComponent.vx[entity] = 0;
    VelocityComponent.vy[entity] = 0;
    VelocityComponent.vz[entity] = 0;

    HealthComponent.current[entity] = 100;
    HealthComponent.max[entity] = 100;

    AmmoStateComponent.capacity[entity] = Math.max(0, Math.floor(tank.ammoCapacity ?? 0));
    AmmoStateComponent.remaining[entity] = Math.max(0, Math.floor(ammoRemaining));

    CooldownComponent.value[entity] = 0;

    TankStatsComponent.maxSpeed[entity] = tank.maxSpeed ?? 10;
    TankStatsComponent.maxReverseSpeed[entity] = tank.maxReverseSpeed ?? 5;
    TankStatsComponent.turretRotation[entity] = tank.turretRotation ?? 30;
    const rawTurretDecline =
      typeof tank.maxTurretDecline === 'number' && Number.isFinite(tank.maxTurretDecline)
        ? tank.maxTurretDecline
        : 10;
    const declineMagnitude = Math.max(0, Math.abs(rawTurretDecline));
    const signedGunDepression = declineMagnitude === 0 ? 0 : -declineMagnitude;
    // Store depression as a negative angle so downstream radian conversions maintain the
    // "down is negative" convention enforced by updateTankFromPhysics.
    TankStatsComponent.gunDepression[entity] = signedGunDepression;
    TankStatsComponent.gunElevation[entity] = tank.maxTurretIncline ?? 10;
    TankStatsComponent.barrelLength[entity] = tank.barrelLength ?? 3;
    TankStatsComponent.bodyWidth[entity] = tank.bodyWidth ?? 3;
    TankStatsComponent.bodyLength[entity] = tank.bodyLength ?? 6;
    TankStatsComponent.bodyHeight[entity] = tank.bodyHeight ?? 2;
    TankStatsComponent.turretWidth[entity] = tank.turretWidth ?? 2;
    TankStatsComponent.turretLength[entity] = tank.turretLength ?? 3;
    TankStatsComponent.turretHeight[entity] = tank.turretHeight ?? 1.5;
    TankStatsComponent.turretXPercent[entity] = tank.turretXPercent ?? 50;
    TankStatsComponent.turretYPercent[entity] = tank.turretYPercent ?? 50;

    const tankBody = this.physics.createTankBody(
      {
        width: TankStatsComponent.bodyWidth[entity] || tank.bodyWidth || 3,
        height: TankStatsComponent.bodyHeight[entity] || tank.bodyHeight || 2,
        length: TankStatsComponent.bodyLength[entity] || tank.bodyLength || 6
      },
      this.estimateTankMass(tank)
    );
    tankBody.position.set(TransformComponent.x[entity], TransformComponent.y[entity], TransformComponent.z[entity]);
    tankBody.quaternion.setFromEuler(0, TransformComponent.rot[entity], 0);
    tankBody.userData = { kind: 'tank', entity, sessionId };
    this.physics.world.addBody(tankBody);
    this.bodyByEntity.set(entity, tankBody);

    const metadata = this.toPlayerMetadata(sessionId, username, tank, entity, loadout);
    metadata.ammoCapacity = AmmoStateComponent.capacity[entity];
    this.metadata.set(sessionId, metadata);
    this.recalculateAmmoRemaining(metadata);
  }

  removePlayer(sessionId: string): void {
    const entity = this.playerEntities.get(sessionId);
    if (typeof entity === 'number') {
      const body = this.bodyByEntity.get(entity);
      if (body) {
        this.physics.world.removeBody(body);
        this.bodyByEntity.delete(entity);
      }
      destroyEntity(this.world, entity);
    }
    this.playerEntities.delete(sessionId);
    this.metadata.delete(sessionId);
  }

  updatePlayerTarget(sessionId: string, target: PlayerTargetPayload): void {
    const entity = this.playerEntities.get(sessionId);
    if (typeof entity !== 'number') return;

    TargetComponent.x[entity] = this.sanitiseNumber(target.x, TargetComponent.x[entity]);
    TargetComponent.y[entity] = this.sanitiseNumber(target.y, TargetComponent.y[entity]);
    TargetComponent.z[entity] = this.sanitiseNumber(target.z, TargetComponent.z[entity]);
    TargetComponent.rot[entity] = this.normaliseAngle(target.rot, TargetComponent.rot[entity]);
    TargetComponent.turret[entity] = this.normaliseAngle(target.turret, TargetComponent.turret[entity]);
    // Preserve negative depression inputs so integratePlayer can clamp against gunDepression correctly.
    TargetComponent.gun[entity] = this.sanitiseNumber(target.gun, TargetComponent.gun[entity]);
  }

  queueFire(sessionId: string, ammoName: string): void {
    const entity = this.playerEntities.get(sessionId);
    if (typeof entity !== 'number') return;
    this.fireRequests.set(entity, { ammoName });
  }

  step(dt: number): StepResult {
    const explosions: StepResult['explosions'] = [];
    const damage: StepResult['damage'] = [];
    const kills: StepResult['kills'] = [];

    this.activeExplosions = explosions;
    this.activeDamage = damage;
    this.activeKills = kills;
    this.destroyedProjectiles.clear();

    for (const meta of this.metadata.values()) {
      const entity = meta.entity;
      if (!hasComponent(this.world, TransformComponent, entity)) continue;
      this.applyPlayerForces(entity, dt);
    }

    for (const [entity, request] of [...this.fireRequests]) {
      this.processFireRequest(entity, request);
      this.fireRequests.delete(entity);
    }

    this.physics.world.step(1 / 60, dt, 8);

    for (const meta of this.metadata.values()) {
      const entity = meta.entity;
      if (!hasComponent(this.world, TransformComponent, entity)) continue;
      this.updateTankFromPhysics(entity, dt);
    }

    this.updateProjectiles(dt);

    this.activeExplosions = null;
    this.activeDamage = null;
    this.activeKills = null;
    this.destroyedProjectiles.clear();

    return { explosions, damage, kills };
  }

  synchroniseState(state: TanksForNothingState): void {
    const knownSessions = new Set(state.playerMetadata.keys());
    for (const [sessionId, meta] of this.metadata) {
      let schema = state.playerMetadata.get(sessionId);
      if (!schema) {
        schema = new PlayerMetadataSchema();
        state.playerMetadata.set(sessionId, schema);
      }
      schema.entityId = meta.entity;
      schema.username = meta.username;
      schema.tankName = meta.tank.name;
      schema.nation = meta.tank.nation;
      schema.battleRating = meta.tank.battleRating;
      schema.tankClass = meta.tank.tankClass;
      schema.armor = meta.tank.armor;
      schema.turretArmor = meta.tank.turretArmor;
      schema.cannonCaliber = meta.tank.cannonCaliber;
      schema.barrelLength = meta.tank.barrelLength;
      schema.mainCannonFireRate = meta.tank.mainCannonFireRate;
      schema.crew = meta.tank.crew;
      schema.engineHp = meta.tank.engineHp;
      schema.maxSpeed = meta.tank.maxSpeed;
      schema.maxReverseSpeed = meta.tank.maxReverseSpeed;
      schema.incline = meta.tank.incline;
      schema.bodyRotation = meta.tank.bodyRotation;
      schema.turretRotation = meta.tank.turretRotation;
      schema.maxTurretIncline = meta.tank.maxTurretIncline;
      schema.maxTurretDecline = meta.tank.maxTurretDecline;
      schema.horizontalTraverse = meta.tank.horizontalTraverse;
      schema.bodyWidth = meta.tank.bodyWidth;
      schema.bodyLength = meta.tank.bodyLength;
      schema.bodyHeight = meta.tank.bodyHeight;
      schema.turretWidth = meta.tank.turretWidth;
      schema.turretLength = meta.tank.turretLength;
      schema.turretHeight = meta.tank.turretHeight;
      schema.turretXPercent = meta.tank.turretXPercent;
      schema.turretYPercent = meta.tank.turretYPercent;
      schema.ammoCapacity = meta.ammoCapacity;

      const loadoutSchema = schema.ammoLoadout;
      for (const key of [...loadoutSchema.keys()]) {
        if (!(key in meta.ammoLoadout)) {
          loadoutSchema.delete(key);
        }
      }
      for (const [ammo, count] of Object.entries(meta.ammoLoadout)) {
        loadoutSchema.set(ammo, count);
      }

      knownSessions.delete(sessionId);
    }

    for (const sessionId of knownSessions) {
      state.playerMetadata.delete(sessionId);
    }

    writePlayerRuntimeBuffer(this.world, this.metadata.values(), state.playerRuntime);
    writeProjectileRuntimeBuffer(this.world, this.projectileMetadata.values(), state.projectileRuntime);
    state.tick += 1;
  }

  getMetadataForSession(sessionId: string): PlayerMetadata | undefined {
    return this.metadata.get(sessionId);
  }

  getMetadataForEntity(entity: number): PlayerMetadata | undefined {
    for (const meta of this.metadata.values()) {
      if (meta.entity === entity) return meta;
    }
    return undefined;
  }

  removeExpiredProjectiles(): void {
    for (const [id, meta] of [...this.projectileMetadata]) {
      if (!hasComponent(this.world, ProjectileComponent, meta.entity)) {
        const body = this.projectileBodies.get(id);
        this.destroyProjectile(id, body ? body.position.clone() : null, {
          spawnExplosion: false,
          hitKind: 'cleanup'
        });
      }
    }
  }

  private sanitiseNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  private normaliseAngle(value: unknown, fallback: number): number {
    const numeric = this.sanitiseNumber(value, fallback);
    if (!Number.isFinite(numeric)) return fallback;
    const twoPi = Math.PI * 2;
    return ((numeric % twoPi) + twoPi) % twoPi;
  }

  private toPlayerMetadata(
    sessionId: string,
    username: string,
    tank: TankDefinition,
    entity: number,
    loadout: Record<string, number>
  ): PlayerMetadata {
    const tankSnapshot: TankSnapshot = {
      name: tank.name,
      nation: tank.nation,
      battleRating: tank.br,
      tankClass: tank.class,
      armor: tank.armor ?? 0,
      turretArmor: tank.turretArmor ?? 0,
      cannonCaliber: tank.cannonCaliber ?? 0,
      barrelLength: tank.barrelLength ?? 0,
      mainCannonFireRate: tank.mainCannonFireRate ?? 0,
      crew: tank.crew ?? 0,
      engineHp: tank.engineHp ?? 0,
      maxSpeed: tank.maxSpeed ?? 0,
      maxReverseSpeed: tank.maxReverseSpeed ?? 0,
      incline: tank.incline ?? 0,
      bodyRotation: tank.bodyRotation ?? 0,
      turretRotation: tank.turretRotation ?? 0,
      maxTurretIncline: tank.maxTurretIncline ?? 0,
      maxTurretDecline: tank.maxTurretDecline ?? 0,
      horizontalTraverse: tank.horizontalTraverse ?? 0,
      bodyWidth: tank.bodyWidth ?? 0,
      bodyLength: tank.bodyLength ?? 0,
      bodyHeight: tank.bodyHeight ?? 0,
      turretWidth: tank.turretWidth ?? 0,
      turretLength: tank.turretLength ?? 0,
      turretHeight: tank.turretHeight ?? 0,
      turretXPercent: tank.turretXPercent ?? 50,
      turretYPercent: tank.turretYPercent ?? 50
    };

    return {
      entity,
      sessionId,
      username,
      tank: tankSnapshot,
      ammoLoadout: cloneAmmoLoadout(loadout),
      ammoCapacity: tank.ammoCapacity ?? 0
    };
  }

  private recalculateAmmoRemaining(meta: PlayerMetadata): number {
    const entity = meta.entity;
    const total = Object.values(meta.ammoLoadout).reduce((sum, count) => sum + Math.max(0, count), 0);
    AmmoStateComponent.remaining[entity] = Math.max(0, Math.min(total, AmmoStateComponent.capacity[entity] ?? total));
    return AmmoStateComponent.remaining[entity];
  }

  private applyPlayerForces(entity: number, dt: number): void {
    const body = this.bodyByEntity.get(entity);
    if (!body) return;

    const targetX = TargetComponent.x[entity];
    const targetY = TargetComponent.y[entity];
    const targetZ = TargetComponent.z[entity];
    const maxSpeed = TankStatsComponent.maxSpeed[entity] || 10;
    const maxReverse = TankStatsComponent.maxReverseSpeed[entity] || 5;

    const dx = targetX - body.position.x;
    const dz = targetZ - body.position.z;
    const distance = Math.sqrt(dx * dx + dz * dz);

    if (distance > 0.1) {
      const directionX = dx / distance;
      const directionZ = dz / distance;
      const desiredSpeed = Math.min(maxSpeed, distance / Math.max(dt, 0.016));
      const forwardVelocity = body.velocity.x * directionX + body.velocity.z * directionZ;
      const allowedSpeed = forwardVelocity >= 0 ? maxSpeed : maxReverse;
      const clampedSpeed = Math.min(allowedSpeed, Math.abs(desiredSpeed));
      const desiredVelX = directionX * clampedSpeed;
      const desiredVelZ = directionZ * clampedSpeed;
      const impulseX = (desiredVelX - body.velocity.x) * body.mass;
      const impulseZ = (desiredVelZ - body.velocity.z) * body.mass;
      body.applyImpulse(new Vec3(impulseX, 0, impulseZ));
    } else {
      body.velocity.x *= 0.6;
      body.velocity.z *= 0.6;
    }

    if (Number.isFinite(targetY)) {
      const dy = targetY - body.position.y;
      if (Math.abs(dy) > 0.25) {
        const desiredVy = this.clamp(dy / Math.max(dt, 0.016), -5, 5);
        const impulseY = (desiredVy - body.velocity.y) * body.mass;
        body.applyImpulse(new Vec3(0, impulseY, 0));
      }
    }
  }

  private updateTankFromPhysics(entity: number, dt: number): void {
    const body = this.bodyByEntity.get(entity);
    if (!body) return;

    const maxSpeed = TankStatsComponent.maxSpeed[entity] || 10;
    const maxTurretRate = TankStatsComponent.turretRotation[entity] || 30;
    const gunElevation = TankStatsComponent.gunElevation[entity] || 10;
    const gunDepression = TankStatsComponent.gunDepression[entity] || -10;

    const horizontalSpeed = Math.hypot(body.velocity.x, body.velocity.z);
    if (horizontalSpeed > maxSpeed) {
      const scale = maxSpeed / horizontalSpeed;
      body.velocity.x *= scale;
      body.velocity.z *= scale;
    }

    TransformComponent.x[entity] = body.position.x;
    TransformComponent.y[entity] = body.position.y;
    TransformComponent.z[entity] = body.position.z;

    VelocityComponent.vx[entity] = body.velocity.x;
    VelocityComponent.vy[entity] = body.velocity.y;
    VelocityComponent.vz[entity] = body.velocity.z;

    const targetRot = TargetComponent.rot[entity];
    const currentYaw = this.getYawFromBody(body);
    const rotDelta = this.shortestAngleDelta(currentYaw, targetRot);
    const maxRotStep = (maxSpeed > 0 ? maxSpeed : 30) * dt * 0.5;
    const nextYaw = this.wrapAngle(currentYaw + this.clamp(rotDelta, -maxRotStep, maxRotStep));
    body.quaternion.setFromEuler(0, nextYaw, 0);
    TransformComponent.rot[entity] = nextYaw;

    const targetTurret = TargetComponent.turret[entity];
    const turretDelta = this.shortestAngleDelta(TransformComponent.turret[entity], targetTurret);
    const maxTurretStep = (maxTurretRate || 30) * dt * (Math.PI / 180);
    TransformComponent.turret[entity] = this.wrapAngle(
      TransformComponent.turret[entity] + this.clamp(turretDelta, -maxTurretStep, maxTurretStep)
    );

    const clampedGunTarget = this.clamp(
      TargetComponent.gun[entity],
      gunDepression * (Math.PI / 180),
      gunElevation * (Math.PI / 180)
    );
    const gunStep = this.clamp(clampedGunTarget - TransformComponent.gun[entity], -maxTurretStep, maxTurretStep);
    TransformComponent.gun[entity] += gunStep;

    if (CooldownComponent.value[entity] > 0) {
      CooldownComponent.value[entity] = Math.max(0, CooldownComponent.value[entity] - dt);
    }

    const userData = body.userData ?? { kind: 'tank' as const };
    userData.entity = entity;
    const meta = this.getMetadataForEntity(entity);
    if (meta) {
      userData.sessionId = meta.sessionId;
    }
    body.userData = userData;
  }

  private processFireRequest(entity: number, request: FireRequest): boolean {
    if (!hasComponent(this.world, TransformComponent, entity)) return false;
    if (CooldownComponent.value[entity] > 0) return false;
    const ammo = this.ammoByName.get(request.ammoName);
    if (!ammo) return false;

    const meta = this.getMetadataForEntity(entity);
    if (!meta) return false;

    const current = meta.ammoLoadout[ammo.name] ?? 0;
    if (current <= 0) return false;

    const projectileId = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    const projectileEntity = createEntity(this.world);
    addComponent(this.world, ProjectileComponent, projectileEntity);
    addComponent(this.world, TransformComponent, projectileEntity);

    const { muzzleX, muzzleY, muzzleZ, vx, vy, vz } = this.computeMuzzle(meta, ammo, entity);
    TransformComponent.x[projectileEntity] = muzzleX;
    TransformComponent.y[projectileEntity] = muzzleY;
    TransformComponent.z[projectileEntity] = muzzleZ;
    ProjectileComponent.vx[projectileEntity] = vx;
    ProjectileComponent.vy[projectileEntity] = vy;
    ProjectileComponent.vz[projectileEntity] = vz;
    ProjectileComponent.life[projectileEntity] = PROJECTILE_LIFETIME;
    ProjectileComponent.shooter[projectileEntity] = entity;

    const projectileBody = this.physics.createProjectileBody(Math.max(0.2, (ammo.caliber ?? 75) / 1000), 5);
    projectileBody.position.set(muzzleX, muzzleY, muzzleZ);
    projectileBody.velocity.set(vx, vy, vz);
    projectileBody.userData = { kind: 'projectile', entity: projectileEntity, projectileId };
    const collisionHandler = (event: BodyCollisionEvent) => {
      this.handleProjectileCollision(projectileId, projectileEntity, projectileBody, event);
    };
    projectileBody.addEventListener('collide', collisionHandler);
    this.physics.world.addBody(projectileBody);
    this.projectileBodies.set(projectileId, projectileBody);
    this.projectileCollisionHandlers.set(projectileId, collisionHandler);

    meta.ammoLoadout[ammo.name] = current - 1;
    this.recalculateAmmoRemaining(meta);

    CooldownComponent.value[entity] = this.computeCooldown(meta);

    const spawnTimeMs = Date.now();
    this.projectileMetadata.set(projectileId, {
      entity: projectileEntity,
      id: projectileId,
      ammoName: ammo.name,
      shooterSessionId: meta.sessionId,
      damage: ammo.damage ?? ammo.penetration ?? 10,
      penetration: ammo.penetration ?? ammo.pen0 ?? 0,
      explosion: ammo.explosion ?? ammo.explosionRadius ?? 0,
      spawnPosition: { x: muzzleX, y: muzzleY, z: muzzleZ },
      lastKnownPosition: { x: muzzleX, y: muzzleY, z: muzzleZ },
      lastKnownVelocity: { x: vx, y: vy, z: vz },
      distanceTravelled: 0,
      spawnedAtMs: spawnTimeMs,
      lastUpdatedMs: spawnTimeMs
    });

    return true;
  }

  private updateProjectiles(dt: number): void {
    for (const [id, meta] of [...this.projectileMetadata]) {
      const entity = meta.entity;
      if (!hasComponent(this.world, ProjectileComponent, entity) || !hasComponent(this.world, TransformComponent, entity)) {
        this.destroyProjectile(id, null, { spawnExplosion: false, hitKind: 'cleanup' });
        continue;
      }

      const body = this.projectileBodies.get(id);
      if (!body) {
        this.destroyProjectile(id, null, { spawnExplosion: false, hitKind: 'cleanup' });
        continue;
      }

      TransformComponent.x[entity] = body.position.x;
      TransformComponent.y[entity] = body.position.y;
      TransformComponent.z[entity] = body.position.z;

      ProjectileComponent.vx[entity] = body.velocity.x;
      ProjectileComponent.vy[entity] = body.velocity.y;
      ProjectileComponent.vz[entity] = body.velocity.z;
      ProjectileComponent.life[entity] -= dt;

      const projectileMeta = this.projectileMetadata.get(id);
      if (projectileMeta) {
        const last = projectileMeta.lastKnownPosition;
        const dx = body.position.x - last.x;
        const dy = body.position.y - last.y;
        const dz = body.position.z - last.z;
        const segment = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (Number.isFinite(segment) && segment > 0) {
          projectileMeta.distanceTravelled += segment;
        }
        projectileMeta.lastKnownPosition = {
          x: body.position.x,
          y: body.position.y,
          z: body.position.z
        };
        projectileMeta.lastKnownVelocity = {
          x: body.velocity.x,
          y: body.velocity.y,
          z: body.velocity.z
        };
        projectileMeta.lastUpdatedMs = Date.now();
      }

      if (ProjectileComponent.life[entity] <= 0 || body.position.y <= -5) {
        this.destroyProjectile(id, body.position.clone(), { hitKind: 'timeout' });
      }
    }
  }

  private handleProjectileCollision(
    projectileId: string,
    projectileEntity: number,
    projectileBody: PhysicsBody,
    event: BodyCollisionEvent
  ): void {
    if (this.destroyedProjectiles.has(projectileId)) return;

    const projectileMeta = this.projectileMetadata.get(projectileId);
    if (!projectileMeta) return;

    const shooterEntity = ProjectileComponent.shooter[projectileEntity] ?? null;
    const otherBody = event.body;
    const otherData = otherBody?.userData;

    if (otherBody === projectileBody) return;
    if (otherData?.kind === 'projectile') return;
    if (otherData?.kind === 'tank' && typeof otherData.entity === 'number') {
      if (otherData.entity === shooterEntity) return;
      const remaining = this.applyDamage(otherData.entity, projectileMeta);
      const victimMeta = this.getMetadataForEntity(otherData.entity);
      if (victimMeta && this.activeDamage) {
        this.activeDamage.push({ sessionId: victimMeta.sessionId, health: remaining, shooter: projectileMeta.shooterSessionId });
        if (remaining <= 0 && this.activeKills) {
          this.activeKills.push({ shooter: projectileMeta.shooterSessionId, victim: victimMeta.sessionId });
        }
      }
    }

    const position = projectileBody.position.clone();
    const lastKnown = projectileMeta.lastKnownPosition;
    const dx = position.x - lastKnown.x;
    const dy = position.y - lastKnown.y;
    const dz = position.z - lastKnown.z;
    const collisionSegment = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (Number.isFinite(collisionSegment) && collisionSegment > 0) {
      projectileMeta.distanceTravelled += collisionSegment;
    }
    projectileMeta.lastKnownPosition = { x: position.x, y: position.y, z: position.z };
    projectileMeta.lastKnownVelocity = {
      x: projectileBody.velocity.x,
      y: projectileBody.velocity.y,
      z: projectileBody.velocity.z
    };
    projectileMeta.lastUpdatedMs = Date.now();
    const hitKind = (otherData?.kind as ExplosionTelemetry['hitKind']) ?? 'unknown';
    const hitSessionId = typeof otherData?.sessionId === 'string' ? otherData.sessionId : null;
    this.destroyProjectile(projectileId, position, { hitKind, hitSessionId });
  }

  private destroyProjectile(
    projectileId: string,
    explosionPosition: Vec3 | null,
    options: { spawnExplosion?: boolean; hitKind?: ExplosionTelemetry['hitKind']; hitSessionId?: string | null } = {}
  ): void {
    if (this.destroyedProjectiles.has(projectileId)) return;
    this.destroyedProjectiles.add(projectileId);

    const spawnExplosion = options.spawnExplosion ?? true;

    const body = this.projectileBodies.get(projectileId);
    const handler = this.projectileCollisionHandlers.get(projectileId);
    if (body) {
      this.physics.world.removeBody(body);
      if (handler) {
        body.removeEventListener('collide', handler);
      }
      this.projectileBodies.delete(projectileId);
    }
    if (handler) {
      this.projectileCollisionHandlers.delete(projectileId);
    }

    const meta = this.projectileMetadata.get(projectileId);
    if (meta) {
      destroyEntity(this.world, meta.entity);
      this.projectileMetadata.delete(projectileId);
    }

    if (spawnExplosion && explosionPosition && this.activeExplosions) {
      const eventTimestamp = meta?.lastUpdatedMs ?? Date.now();
      const telemetry: ExplosionTelemetry = {
        id: projectileId,
        x: explosionPosition.x,
        y: explosionPosition.y,
        z: explosionPosition.z,
        ammoName: meta?.ammoName ?? 'unknown',
        shooterSessionId: meta?.shooterSessionId ?? null,
        hitKind: options.hitKind ?? 'unknown',
        hitSessionId: options.hitSessionId ?? null,
        distanceTravelled: meta?.distanceTravelled ?? 0,
        travelTimeMs:
          meta && meta.spawnedAtMs ? Math.max(0, eventTimestamp - meta.spawnedAtMs) : 0,
        impactSpeed: meta?.lastKnownVelocity
          ? Math.hypot(
              meta.lastKnownVelocity.x,
              meta.lastKnownVelocity.y,
              meta.lastKnownVelocity.z
            )
          : 0,
        impactVelocity: meta?.lastKnownVelocity ?? { x: 0, y: 0, z: 0 }
      };
      this.activeExplosions.push(telemetry);
    }
  }

  private applyDamage(targetEntity: number, projectile: ProjectileMetadata): number {
    const healthBefore = HealthComponent.current[targetEntity] ?? 100;
    const armor = this.getMetadataForEntity(targetEntity)?.tank.armor ?? 0;
    const penetrationBonus = projectile.penetration > armor ? projectile.damage : projectile.damage / 2;
    const totalDamage = Math.max(5, penetrationBonus + projectile.explosion);
    const nextHealth = Math.max(0, healthBefore - totalDamage);
    HealthComponent.current[targetEntity] = nextHealth;
    return nextHealth;
  }

  private computeCooldown(meta: PlayerMetadata): number {
    const fireRate = meta.tank.mainCannonFireRate ?? 0;
    if (fireRate <= 0) return 1;
    return Math.max(0.1, 60 / fireRate);
  }

  private computeMuzzle(meta: PlayerMetadata, ammo: AmmoDefinition, entity: number): {
    muzzleX: number;
    muzzleY: number;
    muzzleZ: number;
    vx: number;
    vy: number;
    vz: number;
  } {
    const yaw = (TransformComponent.rot[entity] || 0) + (TransformComponent.turret[entity] || 0);
    const pitch = TransformComponent.gun[entity] || 0;
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    const speed = ammo.speed ?? 200;
    const barrelLen = meta.tank.barrelLength || TankStatsComponent.barrelLength[entity] || 3;
    const turretYOffset = (meta.tank.turretYPercent ?? 50) / 100 - 0.5;
    const turretXOffset = 0.5 - (meta.tank.turretXPercent ?? 50) / 100;
    const baselineY = TransformComponent.y[entity] || 0;
    // Use metadata first, but fall back to the authoritative TankStats component when lobby data is missing.
    const bodyHeight =
      Number.isFinite(meta.tank.bodyHeight) && typeof meta.tank.bodyHeight === 'number'
        ? meta.tank.bodyHeight
        : TankStatsComponent.bodyHeight[entity] || 0;
    const turretHeightMeta = meta.tank.turretHeight;
    const turretHeight =
      typeof turretHeightMeta === 'number' && Number.isFinite(turretHeightMeta)
        ? turretHeightMeta
        : TankStatsComponent.turretHeight[entity] || 0;
    // The gun pivot sits atop the combined hull and turret stack; start from the centre-based baseline and
    // add half-height contributions so level shots remain aligned with the previous origin while still
    // accounting for taller turrets.
    const halfBodyHeight = Math.max(0, bodyHeight) * 0.5;
    const halfTurretHeight = Math.max(0, turretHeight) * 0.5;
    const pivotY = baselineY + halfBodyHeight + halfTurretHeight;
    const groundY = baselineY - halfBodyHeight;
    const clearanceY = groundY + MUZZLE_TERRAIN_CLEARANCE;

    const muzzleDirectionX = -sinYaw * cosPitch;
    const muzzleDirectionY = sinPitch;
    const muzzleDirectionZ = -cosYaw * cosPitch;

    const unclampedMuzzleY = pivotY + muzzleDirectionY * barrelLen;
    let effectiveBarrelLen = barrelLen;
    if (muzzleDirectionY < 0 && unclampedMuzzleY < clearanceY) {
      if (Math.abs(muzzleDirectionY) > 1e-5) {
        const allowableLength = (clearanceY - pivotY) / muzzleDirectionY;
        effectiveBarrelLen = Math.max(0, Math.min(barrelLen, allowableLength));
      } else {
        effectiveBarrelLen = 0;
      }
      if (unclampedMuzzleY < clearanceY) {
        console.debug('Clamping depressed muzzle to maintain ground clearance', {
          entity,
          requestedLength: barrelLen,
          adjustedLength: effectiveBarrelLen,
          pivotY,
          clearanceY
        });
      }
    }

    const muzzleX =
      TransformComponent.x[entity] + turretYOffset * meta.tank.bodyWidth + muzzleDirectionX * effectiveBarrelLen;
    const muzzleY = pivotY + muzzleDirectionY * effectiveBarrelLen;
    const muzzleZ =
      TransformComponent.z[entity] + turretXOffset * meta.tank.bodyLength + muzzleDirectionZ * effectiveBarrelLen;
    const vx = muzzleDirectionX * speed;
    const vy = muzzleDirectionY * speed;
    const vz = muzzleDirectionZ * speed;
    return { muzzleX, muzzleY, muzzleZ, vx, vy, vz };
  }

  private getYawFromBody(body: PhysicsBody): number {
    const { x, y, z, w } = body.quaternion;
    const siny = 2 * (w * y + z * x);
    const cosy = 1 - 2 * (y * y + z * z);
    return Math.atan2(siny, cosy);
  }

  private estimateTankMass(tank: TankDefinition): number {
    const width = Number.isFinite(tank.bodyWidth) ? Number(tank.bodyWidth) : 3;
    const height = Number.isFinite(tank.bodyHeight) ? Number(tank.bodyHeight) : 2;
    const length = Number.isFinite(tank.bodyLength) ? Number(tank.bodyLength) : 6;
    const engine = Number.isFinite(tank.engineHp) ? Number(tank.engineHp) : 600;
    const volumeEstimate = width * height * length;
    const tonnage = volumeEstimate * 1.2 + engine / 60;
    return Math.max(20, Math.min(80, tonnage));
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  private wrapAngle(value: number): number {
    const twoPi = Math.PI * 2;
    return ((value % twoPi) + twoPi) % twoPi;
  }

  private shortestAngleDelta(current: number, target: number): number {
    const delta = this.wrapAngle(target) - this.wrapAngle(current);
    if (delta > Math.PI) return delta - Math.PI * 2;
    if (delta < -Math.PI) return delta + Math.PI * 2;
    return delta;
  }
}
