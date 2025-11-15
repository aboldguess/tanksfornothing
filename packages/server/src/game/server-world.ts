// server-world.ts
// Summary: Authoritative physics world manager for Tanks for Nothing using cannon-es to simulate tanks and projectiles.
// Structure: Defines utility vector helpers, per-entity metadata interfaces, and the ServerWorld class that wraps
//            cannon-es setup, entity lifecycle management, step integration and collision serialization.
// Usage: Instantiate ServerWorld, register tank bodies and projectiles, call step(deltaSeconds) each tick, and consume
//        the returned snapshot to synchronize the ECS/Colyseus layer and apply damage or removal effects.

import crypto from 'node:crypto';

import {
  Body,
  Box,
  ContactMaterial,
  Material,
  Plane,
  Sphere,
  Vec3,
  World
} from 'cannon-es';

interface VectorLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface TankSpec {
  readonly width: number;
  readonly height: number;
  readonly length: number;
  readonly mass?: number;
}

interface TankKinematicState {
  readonly position: VectorLike;
  readonly velocity?: VectorLike;
  readonly rotation?: number;
  readonly turret?: number;
  readonly gun?: number;
}

interface TankSnapshot {
  readonly id: string;
  readonly position: VectorLike;
  readonly velocity: VectorLike;
  readonly rotation: number;
  readonly turret: number;
  readonly gun: number;
}

interface ProjectileMetadata {
  readonly id: string;
  readonly shooterId: string;
  readonly ammoId: string;
  readonly spawnTime: number;
  readonly lifeMs: number;
}

interface ProjectileSpawnOptions {
  readonly id?: string;
  readonly shooterId: string;
  readonly ammoId: string;
  readonly position: VectorLike;
  readonly velocity: VectorLike;
  readonly radius?: number;
  readonly mass?: number;
  readonly lifeMs?: number;
}

interface ProjectileSnapshot {
  readonly id: string;
  readonly position: VectorLike;
  readonly velocity: VectorLike;
}

type ProjectileRemovalReason = 'manual' | 'expired' | 'out-of-bounds' | 'collision';

interface ProjectileRemoval {
  readonly id: string;
  readonly reason: ProjectileRemovalReason;
  readonly position: VectorLike;
  readonly metadata: ProjectileMetadata;
}

type CollisionEventType = 'projectile-tank' | 'projectile-ground';

interface CollisionEvent {
  readonly type: CollisionEventType;
  readonly projectileId: string;
  readonly targetId?: string;
  readonly point: VectorLike;
  readonly relativeVelocity: number;
}

interface PhysicsSnapshot {
  readonly tanks: TankSnapshot[];
  readonly projectiles: ProjectileSnapshot[];
  readonly collisions: CollisionEvent[];
  readonly removedProjectiles: ProjectileRemoval[];
}

interface BodyUserData {
  readonly kind: 'tank' | 'projectile' | 'ground';
  readonly id: string;
}

interface TankRecord {
  readonly body: Body;
  spec: TankSpec;
  kinematics: Required<TankKinematicState>;
}

interface ProjectileRecord {
  readonly body: Body;
  readonly metadata: ProjectileMetadata;
}

const HALF = 0.5;

function toVec3(v: VectorLike): Vec3 {
  return new Vec3(v.x, v.y, v.z);
}

function cloneVec(bodyVec: Vec3): VectorLike {
  return { x: bodyVec.x, y: bodyVec.y, z: bodyVec.z };
}

function ensureBodyUserData(body: Body, data: BodyUserData): void {
  (body as Body & { userData?: BodyUserData }).userData = data;
}

function getBodyUserData(body: Body): BodyUserData | undefined {
  return (body as Body & { userData?: BodyUserData }).userData;
}

function yawToQuaternion(yaw: number): { x: number; y: number; z: number; w: number } {
  const halfYaw = yaw * HALF;
  return {
    x: 0,
    y: Math.sin(halfYaw),
    z: 0,
    w: Math.cos(halfYaw)
  };
}

export class ServerWorld {
  private readonly world: World;
  private readonly groundMaterial: Material;
  private readonly tankMaterial: Material;
  private readonly projectileMaterial: Material;
  private readonly tanks = new Map<string, TankRecord>();
  private readonly projectiles = new Map<string, ProjectileRecord>();
  private readonly pendingCollisions: CollisionEvent[] = [];
  private readonly collisionKeys = new Set<string>();

  public constructor() {
    this.world = new World({ gravity: new Vec3(0, -9.81, 0) });
    this.world.broadphase.useBoundingBoxes = true;
    this.world.allowSleep = false;

    this.groundMaterial = new Material('ground');
    this.tankMaterial = new Material('tank');
    this.projectileMaterial = new Material('projectile');

    const groundBody = new Body({
      mass: 0,
      material: this.groundMaterial
    });
    groundBody.addShape(new Plane());
    ensureBodyUserData(groundBody, { kind: 'ground', id: 'ground' });
    this.world.addBody(groundBody);

    const tankGround = new ContactMaterial(this.tankMaterial, this.groundMaterial, {
      friction: 0.8,
      restitution: 0.01
    });
    const projectileGround = new ContactMaterial(this.projectileMaterial, this.groundMaterial, {
      friction: 0.4,
      restitution: 0.2
    });
    const projectileTank = new ContactMaterial(this.projectileMaterial, this.tankMaterial, {
      friction: 0.3,
      restitution: 0.1
    });

    this.world.addContactMaterial(tankGround);
    this.world.addContactMaterial(projectileGround);
    this.world.addContactMaterial(projectileTank);

    this.world.addEventListener('beginContact', (event: { bodyA: Body; bodyB: Body }) => {
      this.handleBeginContact(event.bodyA, event.bodyB);
      this.handleBeginContact(event.bodyB, event.bodyA);
    });
  }

  public registerTank(id: string, spec: TankSpec, state?: TankKinematicState): void {
    const existing = this.tanks.get(id);
    if (existing) {
      existing.spec = spec;
      const normalized = this.normalizeTankState(state ?? existing.kinematics);
      this.applyTankKinematics(existing.body, normalized);
      existing.kinematics = normalized;
      this.rebuildTankShape(existing.body, spec);
      return;
    }

    const body = new Body({
      mass: spec.mass ?? 30000,
      material: this.tankMaterial,
      linearDamping: 0.3,
      angularDamping: 0.4
    });
    this.rebuildTankShape(body, spec);
    ensureBodyUserData(body, { kind: 'tank', id });
    this.world.addBody(body);

    const normalized = this.normalizeTankState(state ?? {
      position: { x: 0, y: 2, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      rotation: 0,
      turret: 0,
      gun: 0
    });
    this.applyTankKinematics(body, normalized);

    this.tanks.set(id, {
      body,
      spec,
      kinematics: normalized
    });
  }

  public updateTankState(id: string, state: TankKinematicState): void {
    const record = this.tanks.get(id);
    if (!record) return;
    record.kinematics = this.normalizeTankState({ ...record.kinematics, ...state });
    this.applyTankKinematics(record.body, record.kinematics);
  }

  public removeTank(id: string): void {
    const record = this.tanks.get(id);
    if (!record) return;
    this.world.removeBody(record.body);
    this.tanks.delete(id);
  }

  public spawnProjectile(options: ProjectileSpawnOptions): ProjectileSnapshot {
    const id = options.id ?? crypto.randomUUID();
    const radius = options.radius ?? 0.25;
    const mass = options.mass ?? 2;
    const lifeMs = options.lifeMs ?? 5000;
    const body = new Body({
      mass,
      material: this.projectileMaterial,
      linearDamping: 0,
      angularDamping: 0
    });
    body.addShape(new Sphere(radius));
    body.position.copy(toVec3(options.position));
    body.velocity.copy(toVec3(options.velocity));
    ensureBodyUserData(body, { kind: 'projectile', id });
    this.world.addBody(body);

    const metadata: ProjectileMetadata = {
      id,
      shooterId: options.shooterId,
      ammoId: options.ammoId,
      spawnTime: Date.now(),
      lifeMs
    };

    this.projectiles.set(id, {
      body,
      metadata
    });

    return {
      id,
      position: cloneVec(body.position),
      velocity: cloneVec(body.velocity)
    };
  }

  public removeProjectile(id: string, reason: ProjectileRemovalReason = 'manual'): ProjectileRemoval | null {
    const record = this.projectiles.get(id);
    if (!record) return null;
    this.world.removeBody(record.body);
    this.projectiles.delete(id);
    return {
      id,
      reason,
      position: cloneVec(record.body.position),
      metadata: record.metadata
    };
  }

  public getProjectileMetadata(id: string): ProjectileMetadata | undefined {
    return this.projectiles.get(id)?.metadata;
  }

  public step(deltaSeconds: number, now: number = Date.now()): PhysicsSnapshot {
    this.collisionKeys.clear();
    this.world.step(deltaSeconds);

    const removed: ProjectileRemoval[] = [];
    for (const [id, record] of this.projectiles) {
      const age = now - record.metadata.spawnTime;
      if (age > record.metadata.lifeMs) {
        const removal = this.removeProjectile(id, 'expired');
        if (removal) removed.push(removal);
        continue;
      }
      if (record.body.position.y < -50) {
        const removal = this.removeProjectile(id, 'out-of-bounds');
        if (removal) removed.push(removal);
      }
    }

    const tanks: TankSnapshot[] = [];
    for (const [id, record] of this.tanks) {
      const { body, kinematics } = record;
      body.position.y = Math.max(body.position.y, 0.01);
      tanks.push({
        id,
        position: cloneVec(body.position),
        velocity: cloneVec(body.velocity),
        rotation: kinematics.rotation,
        turret: kinematics.turret,
        gun: kinematics.gun
      });
    }

    const projectiles: ProjectileSnapshot[] = [];
    for (const [id, record] of this.projectiles) {
      projectiles.push({
        id,
        position: cloneVec(record.body.position),
        velocity: cloneVec(record.body.velocity)
      });
    }

    const collisions = this.drainCollisions();
    return { tanks, projectiles, collisions, removedProjectiles: removed };
  }

  private rebuildTankShape(body: Body, spec: TankSpec): void {
    body.shapes.length = 0;
    body.addShape(new Box(new Vec3(spec.width * HALF, spec.height * HALF, spec.length * HALF)));
  }

  private normalizeTankState(state: TankKinematicState): Required<TankKinematicState> {
    return {
      position: state.position ?? { x: 0, y: 2, z: 0 },
      velocity: state.velocity ?? { x: 0, y: 0, z: 0 },
      rotation: state.rotation ?? 0,
      turret: state.turret ?? 0,
      gun: state.gun ?? 0
    };
  }

  private applyTankKinematics(body: Body, state: Required<TankKinematicState>): void {
    body.position.copy(toVec3(state.position));
    body.velocity.copy(toVec3(state.velocity));
    const q = yawToQuaternion(state.rotation);
    body.quaternion.set(q.x, q.y, q.z, q.w);
  }

  private handleBeginContact(bodyA: Body, bodyB: Body): void {
    const aData = getBodyUserData(bodyA);
    const bData = getBodyUserData(bodyB);
    if (!aData || !bData) return;

    const key = `${aData.kind}:${aData.id}->${bData.kind}:${bData.id}`;
    if (this.collisionKeys.has(key)) return;
    this.collisionKeys.add(key);

    if (aData.kind === 'projectile' && bData.kind === 'tank') {
      this.pendingCollisions.push({
        type: 'projectile-tank',
        projectileId: aData.id,
        targetId: bData.id,
        point: cloneVec(bodyA.position),
        relativeVelocity: bodyA.velocity.vsub(bodyB.velocity).length()
      });
    } else if (aData.kind === 'projectile' && bData.kind === 'ground') {
      this.pendingCollisions.push({
        type: 'projectile-ground',
        projectileId: aData.id,
        point: cloneVec(bodyA.position),
        relativeVelocity: bodyA.velocity.length()
      });
    }
  }

  private drainCollisions(): CollisionEvent[] {
    const events = [...this.pendingCollisions];
    this.pendingCollisions.length = 0;
    this.collisionKeys.clear();
    return events;
  }
}

export default ServerWorld;
