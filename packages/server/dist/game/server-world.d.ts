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
export declare class ServerWorld {
    private readonly world;
    private readonly groundMaterial;
    private readonly tankMaterial;
    private readonly projectileMaterial;
    private readonly tanks;
    private readonly projectiles;
    private readonly pendingCollisions;
    private readonly collisionKeys;
    constructor();
    registerTank(id: string, spec: TankSpec, state?: TankKinematicState): void;
    updateTankState(id: string, state: TankKinematicState): void;
    removeTank(id: string): void;
    spawnProjectile(options: ProjectileSpawnOptions): ProjectileSnapshot;
    removeProjectile(id: string, reason?: ProjectileRemovalReason): ProjectileRemoval | null;
    getProjectileMetadata(id: string): ProjectileMetadata | undefined;
    step(deltaSeconds: number, now?: number): PhysicsSnapshot;
    private rebuildTankShape;
    private normalizeTankState;
    private applyTankKinematics;
    private handleBeginContact;
    private drainCollisions;
}
export default ServerWorld;
//# sourceMappingURL=server-world.d.ts.map