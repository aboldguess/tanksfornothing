// snapshots.ts
// Summary: Helper utilities for translating between bitecs component storage and the Colyseus
//          schema buffers defined in ../schema.ts so both server simulators and client renderers
//          can share deterministic packing logic.
// Structure: Provides writer functions that serialise ECS state into schema buffers and reader
//            functions that hydrate ECS components from schema arrays using caller provided
//            entity-mapping callbacks.
// Usage: Server code calls writePlayerRuntimeBuffer before broadcasting; clients call
//        applyPlayerRuntimeBuffer when patches arrive to update their local worlds.
// ---------------------------------------------------------------------------

import { addComponent, hasComponent } from 'bitecs';
import { ArraySchema } from '@colyseus/schema';

import {
  AmmoStateComponent,
  CooldownComponent,
  GameWorld,
  ProjectileComponent,
  TransformComponent,
  VelocityComponent,
  HealthComponent
} from './components.js';
import type { PlayerMetadata, ProjectileMetadata } from './metadata.js';
import {
  PlayerRuntimeBufferSchema,
  ProjectileRuntimeBufferSchema
} from '../schema.js';

function clearArraySchema<T>(array: ArraySchema<T>): void {
  array.splice(0, array.length);
}

/** Serialises all player entities with metadata into the runtime buffer. */
export function writePlayerRuntimeBuffer(
  world: GameWorld,
  metadata: Iterable<PlayerMetadata>,
  runtime: PlayerRuntimeBufferSchema
): void {
  clearArraySchema(runtime.entityId);
  clearArraySchema(runtime.x);
  clearArraySchema(runtime.y);
  clearArraySchema(runtime.z);
  clearArraySchema(runtime.rot);
  clearArraySchema(runtime.turret);
  clearArraySchema(runtime.gun);
  clearArraySchema(runtime.vx);
  clearArraySchema(runtime.vy);
  clearArraySchema(runtime.vz);
  clearArraySchema(runtime.health);
  clearArraySchema(runtime.maxHealth);
  clearArraySchema(runtime.cooldown);
  clearArraySchema(runtime.ammoRemaining);

  for (const entry of metadata) {
    const entity = entry.entity;
    if (!hasComponent(world, TransformComponent, entity)) continue;

    runtime.entityId.push(entity);
    runtime.x.push(TransformComponent.x[entity] || 0);
    runtime.y.push(TransformComponent.y[entity] || 0);
    runtime.z.push(TransformComponent.z[entity] || 0);
    runtime.rot.push(TransformComponent.rot[entity] || 0);
    runtime.turret.push(TransformComponent.turret[entity] || 0);
    runtime.gun.push(TransformComponent.gun[entity] || 0);
    runtime.vx.push(VelocityComponent.vx[entity] || 0);
    runtime.vy.push(VelocityComponent.vy[entity] || 0);
    runtime.vz.push(VelocityComponent.vz[entity] || 0);
    runtime.health.push(HealthComponent.current[entity] || 0);
    runtime.maxHealth.push(HealthComponent.max[entity] || 0);
    runtime.cooldown.push(CooldownComponent.value[entity] || 0);
    runtime.ammoRemaining.push(AmmoStateComponent.remaining[entity] || 0);
  }
}

/** Serialises projectile entities into the projectile runtime buffer. */
export function writeProjectileRuntimeBuffer(
  world: GameWorld,
  projectiles: Iterable<ProjectileMetadata>,
  buffer: ProjectileRuntimeBufferSchema
): void {
  clearArraySchema(buffer.id);
  clearArraySchema(buffer.entityId);
  clearArraySchema(buffer.x);
  clearArraySchema(buffer.y);
  clearArraySchema(buffer.z);
  clearArraySchema(buffer.vx);
  clearArraySchema(buffer.vy);
  clearArraySchema(buffer.vz);
  clearArraySchema(buffer.ammo);
  clearArraySchema(buffer.shooter);

  for (const entry of projectiles) {
    const entity = entry.entity;
    if (!hasComponent(world, TransformComponent, entity) || !hasComponent(world, ProjectileComponent, entity)) {
      continue;
    }
    buffer.id.push(entry.id);
    buffer.entityId.push(entity);
    buffer.x.push(TransformComponent.x[entity] || 0);
    buffer.y.push(TransformComponent.y[entity] || 0);
    buffer.z.push(TransformComponent.z[entity] || 0);
    buffer.vx.push(ProjectileComponent.vx[entity] || 0);
    buffer.vy.push(ProjectileComponent.vy[entity] || 0);
    buffer.vz.push(ProjectileComponent.vz[entity] || 0);
    buffer.ammo.push(entry.ammoName);
    buffer.shooter.push(entry.shooterSessionId);
  }
}

export type EnsureEntityForId = (serverEntityId: number) => number | null;

/** Hydrates or updates player entities client-side from the runtime buffer. */
export function applyPlayerRuntimeBuffer(
  world: GameWorld,
  runtime: PlayerRuntimeBufferSchema,
  ensureEntity: EnsureEntityForId
): Set<number> {
  const seenEntities = new Set<number>();
  for (let i = 0; i < runtime.entityId.length; i += 1) {
    const serverEntity = runtime.entityId[i] ?? 0;
    const localEntity = ensureEntity(serverEntity);
    if (localEntity === null) continue;

    if (!hasComponent(world, TransformComponent, localEntity)) {
      addComponent(world, TransformComponent, localEntity);
    }
    if (!hasComponent(world, VelocityComponent, localEntity)) {
      addComponent(world, VelocityComponent, localEntity);
    }
    if (!hasComponent(world, HealthComponent, localEntity)) {
      addComponent(world, HealthComponent, localEntity);
    }
    if (!hasComponent(world, AmmoStateComponent, localEntity)) {
      addComponent(world, AmmoStateComponent, localEntity);
    }
    if (!hasComponent(world, CooldownComponent, localEntity)) {
      addComponent(world, CooldownComponent, localEntity);
    }

    TransformComponent.x[localEntity] = runtime.x[i] ?? 0;
    TransformComponent.y[localEntity] = runtime.y[i] ?? 0;
    TransformComponent.z[localEntity] = runtime.z[i] ?? 0;
    TransformComponent.rot[localEntity] = runtime.rot[i] ?? 0;
    TransformComponent.turret[localEntity] = runtime.turret[i] ?? 0;
    TransformComponent.gun[localEntity] = runtime.gun[i] ?? 0;
    VelocityComponent.vx[localEntity] = runtime.vx[i] ?? 0;
    VelocityComponent.vy[localEntity] = runtime.vy[i] ?? 0;
    VelocityComponent.vz[localEntity] = runtime.vz[i] ?? 0;
    HealthComponent.current[localEntity] = runtime.health[i] ?? 0;
    HealthComponent.max[localEntity] = runtime.maxHealth[i] ?? 0;
    CooldownComponent.value[localEntity] = runtime.cooldown[i] ?? 0;
    AmmoStateComponent.remaining[localEntity] = runtime.ammoRemaining[i] ?? 0;
    seenEntities.add(serverEntity);
  }
  return seenEntities;
}

/** Hydrates projectile ECS entities client-side. */
export function applyProjectileRuntimeBuffer(
  world: GameWorld,
  buffer: ProjectileRuntimeBufferSchema,
  ensureEntity: EnsureEntityForId
): Set<number> {
  const seen = new Set<number>();
  for (let i = 0; i < buffer.entityId.length; i += 1) {
    const serverEntity = buffer.entityId[i] ?? 0;
    const localEntity = ensureEntity(serverEntity);
    if (localEntity === null) continue;
    if (!hasComponent(world, TransformComponent, localEntity)) {
      addComponent(world, TransformComponent, localEntity);
    }
    if (!hasComponent(world, ProjectileComponent, localEntity)) {
      addComponent(world, ProjectileComponent, localEntity);
    }
    TransformComponent.x[localEntity] = buffer.x[i] ?? 0;
    TransformComponent.y[localEntity] = buffer.y[i] ?? 0;
    TransformComponent.z[localEntity] = buffer.z[i] ?? 0;
    ProjectileComponent.vx[localEntity] = buffer.vx[i] ?? 0;
    ProjectileComponent.vy[localEntity] = buffer.vy[i] ?? 0;
    ProjectileComponent.vz[localEntity] = buffer.vz[i] ?? 0;
    ProjectileComponent.life[localEntity] = 0;
    seen.add(serverEntity);
  }
  return seen;
}
