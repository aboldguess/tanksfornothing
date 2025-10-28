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

import type { AmmoDefinition, TankDefinition } from '../types.js';

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

interface StepResult {
  explosions: Array<{ id: string; x: number; y: number; z: number }>;
  damage: Array<{ sessionId: string; health: number; shooter: string | null }>;
  kills: Array<{ shooter: string | null; victim: string }>;
}

interface ServerWorldOptions {
  getAmmo: () => AmmoDefinition[];
}

const GRAVITY = -9.81;
const PROJECTILE_LIFETIME = 5;

export class ServerWorldController {
  readonly world: GameWorld;
  private readonly playerEntities = new Map<string, number>();
  private readonly metadata = new Map<string, PlayerMetadata>();
  private readonly projectileMetadata = new Map<string, ProjectileMetadata>();
  private readonly fireRequests = new Map<number, FireRequest>();
  private readonly ammoByName = new Map<string, AmmoDefinition>();

  constructor(private readonly options: ServerWorldOptions) {
    this.world = createGameWorld();
    for (const ammo of options.getAmmo()) {
      this.ammoByName.set(ammo.name, ammo);
    }
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
    TankStatsComponent.gunDepression[entity] = tank.maxTurretDecline ?? -10;
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

    const metadata = this.toPlayerMetadata(sessionId, username, tank, entity, loadout);
    metadata.ammoCapacity = AmmoStateComponent.capacity[entity];
    this.metadata.set(sessionId, metadata);
    this.recalculateAmmoRemaining(metadata);
  }

  removePlayer(sessionId: string): void {
    const entity = this.playerEntities.get(sessionId);
    if (typeof entity === 'number') {
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
    TargetComponent.gun[entity] = this.normaliseAngle(target.gun, TargetComponent.gun[entity]);
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

    for (const [sessionId, meta] of this.metadata) {
      const entity = meta.entity;
      if (!hasComponent(this.world, TransformComponent, entity)) continue;
      this.integratePlayer(entity, dt);
    }

    for (const [entity, request] of [...this.fireRequests]) {
      this.processFireRequest(entity, request);
      this.fireRequests.delete(entity);
    }

    this.stepProjectiles(dt, explosions, damage, kills);

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
    for (const [id, meta] of this.projectileMetadata) {
      if (!hasComponent(this.world, ProjectileComponent, meta.entity)) {
        this.projectileMetadata.delete(id);
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

  private integratePlayer(entity: number, dt: number): void {
    const targetX = TargetComponent.x[entity];
    const targetY = TargetComponent.y[entity];
    const targetZ = TargetComponent.z[entity];
    const targetRot = TargetComponent.rot[entity];
    const targetTurret = TargetComponent.turret[entity];
    const targetGun = TargetComponent.gun[entity];

    const maxSpeed = TankStatsComponent.maxSpeed[entity] || 10;
    const maxReverse = TankStatsComponent.maxReverseSpeed[entity] || 5;
    const maxTurretRate = TankStatsComponent.turretRotation[entity] || 30;
    const gunElevation = TankStatsComponent.gunElevation[entity] || 10;
    const gunDepression = TankStatsComponent.gunDepression[entity] || -10;

    const dx = targetX - TransformComponent.x[entity];
    const dy = targetY - TransformComponent.y[entity];
    const dz = targetZ - TransformComponent.z[entity];

    const desiredSpeed = Math.sqrt(dx * dx + dz * dz) / Math.max(dt, 0.0001);
    const clampedSpeed = Math.min(desiredSpeed, dx >= 0 ? maxSpeed : maxReverse);
    const speedRatio = desiredSpeed > 0 ? clampedSpeed / desiredSpeed : 0;

    TransformComponent.x[entity] += dx * speedRatio * dt;
    TransformComponent.y[entity] += dy * Math.min(1, dt * 10);
    TransformComponent.z[entity] += dz * speedRatio * dt;

    VelocityComponent.vx[entity] = dx * speedRatio;
    VelocityComponent.vy[entity] = dy * Math.min(1, dt * 10);
    VelocityComponent.vz[entity] = dz * speedRatio;

    const rotDelta = this.shortestAngleDelta(TransformComponent.rot[entity], targetRot);
    const maxRotStep = (maxSpeed > 0 ? maxSpeed : 30) * dt * 0.5;
    TransformComponent.rot[entity] = this.wrapAngle(TransformComponent.rot[entity] + this.clamp(rotDelta, -maxRotStep, maxRotStep));

    const turretDelta = this.shortestAngleDelta(TransformComponent.turret[entity], targetTurret);
    const maxTurretStep = (maxTurretRate || 30) * dt * (Math.PI / 180);
    TransformComponent.turret[entity] = this.wrapAngle(TransformComponent.turret[entity] + this.clamp(turretDelta, -maxTurretStep, maxTurretStep));

    const gunDelta = targetGun - TransformComponent.gun[entity];
    const clampedGunTarget = this.clamp(targetGun, gunDepression * (Math.PI / 180), gunElevation * (Math.PI / 180));
    const gunStep = this.clamp(clampedGunTarget - TransformComponent.gun[entity], -maxTurretStep, maxTurretStep);
    TransformComponent.gun[entity] += gunStep;

    if (CooldownComponent.value[entity] > 0) {
      CooldownComponent.value[entity] = Math.max(0, CooldownComponent.value[entity] - dt);
    }
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

    meta.ammoLoadout[ammo.name] = current - 1;
    this.recalculateAmmoRemaining(meta);

    CooldownComponent.value[entity] = this.computeCooldown(meta);

    this.projectileMetadata.set(projectileId, {
      entity: projectileEntity,
      id: projectileId,
      ammoName: ammo.name,
      shooterSessionId: meta.sessionId,
      damage: ammo.damage ?? ammo.penetration ?? 10,
      penetration: ammo.penetration ?? ammo.pen0 ?? 0,
      explosion: ammo.explosion ?? ammo.explosionRadius ?? 0
    });

    return true;
  }

  private stepProjectiles(
    dt: number,
    explosions: StepResult['explosions'],
    damage: StepResult['damage'],
    kills: StepResult['kills']
  ): void {
    for (const [id, meta] of [...this.projectileMetadata]) {
      const entity = meta.entity;
      if (!hasComponent(this.world, ProjectileComponent, entity) || !hasComponent(this.world, TransformComponent, entity)) {
        this.projectileMetadata.delete(id);
        continue;
      }

      ProjectileComponent.vy[entity] += GRAVITY * dt;
      TransformComponent.x[entity] += ProjectileComponent.vx[entity] * dt;
      TransformComponent.y[entity] += ProjectileComponent.vy[entity] * dt;
      TransformComponent.z[entity] += ProjectileComponent.vz[entity] * dt;
      ProjectileComponent.life[entity] -= dt;

      if (TransformComponent.y[entity] <= 0 || ProjectileComponent.life[entity] <= 0) {
        explosions.push({ id, x: TransformComponent.x[entity], y: TransformComponent.y[entity], z: TransformComponent.z[entity] });
        destroyEntity(this.world, entity);
        this.projectileMetadata.delete(id);
        continue;
      }

      for (const [sessionId, playerMeta] of this.metadata) {
        if (playerMeta.entity === ProjectileComponent.shooter[entity]) continue;
        const targetEntity = playerMeta.entity;
        if (!hasComponent(this.world, TransformComponent, targetEntity)) continue;
        const dx = TransformComponent.x[targetEntity] - TransformComponent.x[entity];
        const dy = TransformComponent.y[targetEntity] - TransformComponent.y[entity];
        const dz = TransformComponent.z[targetEntity] - TransformComponent.z[entity];
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) < 2) {
          const remainingHealth = this.applyDamage(targetEntity, meta);
          damage.push({ sessionId, health: remainingHealth, shooter: meta.shooterSessionId });
          explosions.push({ id, x: TransformComponent.x[entity], y: TransformComponent.y[entity], z: TransformComponent.z[entity] });
          destroyEntity(this.world, entity);
          this.projectileMetadata.delete(id);
          if (remainingHealth <= 0) {
            kills.push({ shooter: meta.shooterSessionId, victim: sessionId });
          }
          break;
        }
      }
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
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    const speed = ammo.speed ?? 200;
    const barrelLen = meta.tank.barrelLength || TankStatsComponent.barrelLength[entity] || 3;
    const turretYOffset = (meta.tank.turretYPercent ?? 50) / 100 - 0.5;
    const turretXOffset = 0.5 - (meta.tank.turretXPercent ?? 50) / 100;
    const muzzleX = TransformComponent.x[entity] + turretYOffset * meta.tank.bodyWidth - sinYaw * cosPitch * barrelLen;
    const muzzleY = TransformComponent.y[entity] + meta.tank.bodyHeight / 2 + Math.sin(pitch) * barrelLen;
    const muzzleZ = TransformComponent.z[entity] + turretXOffset * meta.tank.bodyLength - cosYaw * cosPitch * barrelLen;
    const vx = -sinYaw * cosPitch * speed;
    const vy = Math.sin(pitch) * speed;
    const vz = -cosYaw * cosPitch * speed;
    return { muzzleX, muzzleY, muzzleZ, vx, vy, vz };
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
