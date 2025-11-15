// server-world.ts
// Summary: Authoritative physics world manager for Tanks for Nothing using cannon-es to simulate tanks and projectiles.
// Structure: Defines utility vector helpers, per-entity metadata interfaces, and the ServerWorld class that wraps
//            cannon-es setup, entity lifecycle management, step integration and collision serialization.
// Usage: Instantiate ServerWorld, register tank bodies and projectiles, call step(deltaSeconds) each tick, and consume
//        the returned snapshot to synchronize the ECS/Colyseus layer and apply damage or removal effects.
import crypto from 'node:crypto';
import { Body, Box, ContactMaterial, Material, Plane, Sphere, Vec3, World } from 'cannon-es';
const HALF = 0.5;
function toVec3(v) {
    return new Vec3(v.x, v.y, v.z);
}
function cloneVec(bodyVec) {
    return { x: bodyVec.x, y: bodyVec.y, z: bodyVec.z };
}
function ensureBodyUserData(body, data) {
    body.userData = data;
}
function getBodyUserData(body) {
    return body.userData;
}
function yawToQuaternion(yaw) {
    const halfYaw = yaw * HALF;
    return {
        x: 0,
        y: Math.sin(halfYaw),
        z: 0,
        w: Math.cos(halfYaw)
    };
}
export class ServerWorld {
    world;
    groundMaterial;
    tankMaterial;
    projectileMaterial;
    tanks = new Map();
    projectiles = new Map();
    pendingCollisions = [];
    collisionKeys = new Set();
    constructor() {
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
        this.world.addEventListener('beginContact', (event) => {
            this.handleBeginContact(event.bodyA, event.bodyB);
            this.handleBeginContact(event.bodyB, event.bodyA);
        });
    }
    registerTank(id, spec, state) {
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
    updateTankState(id, state) {
        const record = this.tanks.get(id);
        if (!record)
            return;
        record.kinematics = this.normalizeTankState({ ...record.kinematics, ...state });
        this.applyTankKinematics(record.body, record.kinematics);
    }
    removeTank(id) {
        const record = this.tanks.get(id);
        if (!record)
            return;
        this.world.removeBody(record.body);
        this.tanks.delete(id);
    }
    spawnProjectile(options) {
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
        const metadata = {
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
    removeProjectile(id, reason = 'manual') {
        const record = this.projectiles.get(id);
        if (!record)
            return null;
        this.world.removeBody(record.body);
        this.projectiles.delete(id);
        return {
            id,
            reason,
            position: cloneVec(record.body.position),
            metadata: record.metadata
        };
    }
    getProjectileMetadata(id) {
        return this.projectiles.get(id)?.metadata;
    }
    step(deltaSeconds, now = Date.now()) {
        this.collisionKeys.clear();
        this.world.step(deltaSeconds);
        const removed = [];
        for (const [id, record] of this.projectiles) {
            const age = now - record.metadata.spawnTime;
            if (age > record.metadata.lifeMs) {
                const removal = this.removeProjectile(id, 'expired');
                if (removal)
                    removed.push(removal);
                continue;
            }
            if (record.body.position.y < -50) {
                const removal = this.removeProjectile(id, 'out-of-bounds');
                if (removal)
                    removed.push(removal);
            }
        }
        const tanks = [];
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
        const projectiles = [];
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
    rebuildTankShape(body, spec) {
        body.shapes.length = 0;
        body.addShape(new Box(new Vec3(spec.width * HALF, spec.height * HALF, spec.length * HALF)));
    }
    normalizeTankState(state) {
        return {
            position: state.position ?? { x: 0, y: 2, z: 0 },
            velocity: state.velocity ?? { x: 0, y: 0, z: 0 },
            rotation: state.rotation ?? 0,
            turret: state.turret ?? 0,
            gun: state.gun ?? 0
        };
    }
    applyTankKinematics(body, state) {
        body.position.copy(toVec3(state.position));
        body.velocity.copy(toVec3(state.velocity));
        const q = yawToQuaternion(state.rotation);
        body.quaternion.set(q.x, q.y, q.z, q.w);
    }
    handleBeginContact(bodyA, bodyB) {
        const aData = getBodyUserData(bodyA);
        const bData = getBodyUserData(bodyB);
        if (!aData || !bData)
            return;
        const key = `${aData.kind}:${aData.id}->${bData.kind}:${bData.id}`;
        if (this.collisionKeys.has(key))
            return;
        this.collisionKeys.add(key);
        if (aData.kind === 'projectile' && bData.kind === 'tank') {
            this.pendingCollisions.push({
                type: 'projectile-tank',
                projectileId: aData.id,
                targetId: bData.id,
                point: cloneVec(bodyA.position),
                relativeVelocity: bodyA.velocity.vsub(bodyB.velocity).length()
            });
        }
        else if (aData.kind === 'projectile' && bData.kind === 'ground') {
            this.pendingCollisions.push({
                type: 'projectile-ground',
                projectileId: aData.id,
                point: cloneVec(bodyA.position),
                relativeVelocity: bodyA.velocity.length()
            });
        }
    }
    drainCollisions() {
        const events = [...this.pendingCollisions];
        this.pendingCollisions.length = 0;
        this.collisionKeys.clear();
        return events;
    }
}
export default ServerWorld;
//# sourceMappingURL=server-world.js.map