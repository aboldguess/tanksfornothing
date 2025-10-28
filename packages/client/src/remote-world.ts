// remote-world.ts
// Summary: Client-side helper that mirrors the server ECS component schema so remote player
//          tanks can be rendered by iterating bitecs worlds instead of ad-hoc maps.
// Structure: Wraps a shared GameWorld instance and handles metadata-driven mesh creation, runtime
//            buffer application, and per-frame mesh synchronisation.
// Usage: Instantiate within the multiplayer bootstrap and forward Colyseus metadata/runtime
//        updates to keep remote tanks in sync with the authoritative server simulation.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import {
  applyPlayerRuntimeBuffer,
  createEntity,
  createGameWorld,
  destroyEntity,
  GameWorld,
  PlayerMetadataSchema,
  PlayerRuntimeBufferSchema,
  TransformComponent,
  type EnsureEntityForId,
  type TankSnapshot
} from '@tanksfornothing/shared';

interface RemoteMeshBundle {
  mesh: THREE.Object3D;
  turret: THREE.Object3D;
  gun: THREE.Object3D | null;
}

export class RemoteWorldRenderer {
  private world: GameWorld = createGameWorld();
  private readonly sessionToServer = new Map<string, number>();
  private readonly serverToSession = new Map<number, string>();
  private readonly serverToLocal = new Map<number, number>();
  private readonly meshes = new Map<number, RemoteMeshBundle>();
  private readonly ensureEntity: EnsureEntityForId;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly createTankMesh: (tank: TankSnapshot) => RemoteMeshBundle,
    private readonly getLocalSessionId: () => string
  ) {
    this.ensureEntity = (serverEntityId) => {
      const ownerSession = this.serverToSession.get(serverEntityId);
      if (!ownerSession || ownerSession === this.getLocalSessionId()) {
        return null;
      }
      if (!this.serverToLocal.has(serverEntityId)) {
        const local = createEntity(this.world);
        this.serverToLocal.set(serverEntityId, local);
      }
      return this.serverToLocal.get(serverEntityId) ?? null;
    };
  }

  addOrUpdateMetadata(sessionId: string, schema: PlayerMetadataSchema): void {
    this.sessionToServer.set(sessionId, schema.entityId);
    this.serverToSession.set(schema.entityId, sessionId);

    if (sessionId === this.getLocalSessionId()) {
      return;
    }

    const existing = this.meshes.get(schema.entityId);
    if (existing) {
      return;
    }

    const bundle = this.createTankMesh({
      name: schema.tankName,
      nation: schema.nation,
      battleRating: schema.battleRating,
      tankClass: schema.tankClass,
      armor: schema.armor,
      turretArmor: schema.turretArmor,
      cannonCaliber: schema.cannonCaliber,
      barrelLength: schema.barrelLength,
      mainCannonFireRate: schema.mainCannonFireRate,
      crew: schema.crew,
      engineHp: schema.engineHp,
      maxSpeed: schema.maxSpeed,
      maxReverseSpeed: schema.maxReverseSpeed,
      incline: schema.incline,
      bodyRotation: schema.bodyRotation,
      turretRotation: schema.turretRotation,
      maxTurretIncline: schema.maxTurretIncline,
      maxTurretDecline: schema.maxTurretDecline,
      horizontalTraverse: schema.horizontalTraverse,
      bodyWidth: schema.bodyWidth,
      bodyLength: schema.bodyLength,
      bodyHeight: schema.bodyHeight,
      turretWidth: schema.turretWidth,
      turretLength: schema.turretLength,
      turretHeight: schema.turretHeight,
      turretXPercent: schema.turretXPercent,
      turretYPercent: schema.turretYPercent
    });
    this.scene.add(bundle.mesh);
    this.meshes.set(schema.entityId, bundle);
  }

  removeMetadata(sessionId: string): void {
    const serverEntity = this.sessionToServer.get(sessionId);
    if (typeof serverEntity === 'number') {
      this.sessionToServer.delete(sessionId);
      this.serverToSession.delete(serverEntity);
      const localEntity = this.serverToLocal.get(serverEntity);
      if (typeof localEntity === 'number') {
        destroyEntity(this.world, localEntity);
        this.serverToLocal.delete(serverEntity);
      }
      const bundle = this.meshes.get(serverEntity);
      if (bundle) {
        this.disposeMesh(bundle.mesh);
        this.meshes.delete(serverEntity);
      }
    }
  }

  applyRuntime(runtime: PlayerRuntimeBufferSchema): void {
    const seen = applyPlayerRuntimeBuffer(this.world, runtime, this.ensureEntity);
    for (const [serverEntity, localEntity] of [...this.serverToLocal]) {
      if (!seen.has(serverEntity)) {
        destroyEntity(this.world, localEntity);
        this.serverToLocal.delete(serverEntity);
        const bundle = this.meshes.get(serverEntity);
        if (bundle) {
          this.disposeMesh(bundle.mesh);
          this.meshes.delete(serverEntity);
        }
      }
    }
  }

  updateMeshes(): void {
    for (const [serverEntity, bundle] of this.meshes) {
      const localEntity = this.serverToLocal.get(serverEntity);
      if (typeof localEntity !== 'number') continue;
      bundle.mesh.position.set(
        TransformComponent.x[localEntity] || 0,
        TransformComponent.y[localEntity] || 0,
        TransformComponent.z[localEntity] || 0
      );
      bundle.mesh.rotation.y = TransformComponent.rot[localEntity] || 0;
      bundle.turret.rotation.y = TransformComponent.turret[localEntity] || 0;
      if (bundle.gun) {
        bundle.gun.rotation.x = TransformComponent.gun[localEntity] || 0;
      }
    }
  }

  clear(): void {
    for (const bundle of this.meshes.values()) {
      this.disposeMesh(bundle.mesh);
    }
    this.meshes.clear();
    this.sessionToServer.clear();
    this.serverToSession.clear();
    this.serverToLocal.clear();
    this.world = createGameWorld();
  }

  getWorld(): GameWorld {
    return this.world;
  }

  private disposeMesh(mesh: THREE.Object3D): void {
    this.scene.remove(mesh);
    mesh.traverse((obj: THREE.Object3D) => {
      const meshObj = obj as THREE.Mesh;
      if (meshObj.geometry) {
        meshObj.geometry.dispose();
      }
      const material = meshObj.material;
      if (Array.isArray(material)) {
        material.forEach((m) => {
          if (m && typeof m.dispose === 'function') m.dispose();
        });
      } else if (material && typeof material.dispose === 'function') {
        material.dispose();
      }
    });
  }
}
