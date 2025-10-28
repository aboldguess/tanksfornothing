// components.ts
// Summary: Canonical bitecs component declarations shared across server and client worlds
//          to ensure gameplay and rendering systems operate over identical memory layouts.
// Structure: Exports strongly typed component factories plus helpers for world management so
//            simulation systems on the server and renderer adapters on the client can remain
//            decoupled yet interoperable.
// Usage: import { TransformComponent, createGameWorld } from '@tanksfornothing/shared/ecs';
// ---------------------------------------------------------------------------

import {
  IWorld,
  addEntity,
  createWorld,
  defineComponent,
  hasComponent,
  removeEntity,
  Types
} from 'bitecs';

/**
 * TransformComponent stores the current world position/orientation for both player tanks
 * and transient projectile entities.
 */
export const TransformComponent = defineComponent({
  x: Types.f32,
  y: Types.f32,
  z: Types.f32,
  rot: Types.f32,
  turret: Types.f32,
  gun: Types.f32
});

/**
 * TargetComponent encodes the latest desired transform as communicated by player input so the
 * authoritative movement system can apply acceleration limits and smoothing.
 */
export const TargetComponent = defineComponent({
  x: Types.f32,
  y: Types.f32,
  z: Types.f32,
  rot: Types.f32,
  turret: Types.f32,
  gun: Types.f32
});

/**
 * VelocityComponent captures the last computed linear velocity vector. It allows both the
 * physics integrator and the network serializer to expose consistent momentum data.
 */
export const VelocityComponent = defineComponent({
  vx: Types.f32,
  vy: Types.f32,
  vz: Types.f32
});

/**
 * HealthComponent keeps the current and maximum hit points for tanks so damage systems can
 * clamp values while keeping enough context for HUD updates client-side.
 */
export const HealthComponent = defineComponent({
  current: Types.f32,
  max: Types.f32
});

/**
 * AmmoStateComponent records bulk ammo statistics (capacity and remaining rounds). Fine-grained
 * per-ammo bookkeeping is handled via metadata maps to avoid sparse component layouts.
 */
export const AmmoStateComponent = defineComponent({
  capacity: Types.ui16,
  remaining: Types.ui16
});

/**
 * CooldownComponent tracks the remaining time until the main cannon may fire again.
 */
export const CooldownComponent = defineComponent({
  value: Types.f32
});

/**
 * TankStatsComponent stores frequently accessed numeric characteristics of a tank. Keeping
 * these values in component memory enables systems to operate without chasing metadata maps
 * for critical movement limits.
 */
export const TankStatsComponent = defineComponent({
  maxSpeed: Types.f32,
  maxReverseSpeed: Types.f32,
  turretRotation: Types.f32,
  gunDepression: Types.f32,
  gunElevation: Types.f32,
  barrelLength: Types.f32,
  bodyWidth: Types.f32,
  bodyLength: Types.f32,
  bodyHeight: Types.f32,
  turretWidth: Types.f32,
  turretLength: Types.f32,
  turretHeight: Types.f32,
  turretXPercent: Types.f32,
  turretYPercent: Types.f32
});

/**
 * ProjectileComponent identifies projectile entities and stores their inertial state.
 */
export const ProjectileComponent = defineComponent({
  vx: Types.f32,
  vy: Types.f32,
  vz: Types.f32,
  life: Types.f32,
  shooter: Types.ui32
});

/**
 * Tag component attached to player-controlled tank entities so queries can distinguish them
 * from projectiles and other helper entities without maintaining a separate lookup structure.
 */
export const PlayerTagComponent = defineComponent();

/**
 * Factory for a shared world instance. Keeping this helper in the shared package lets both
 * server and client initialise worlds without duplicating configuration boilerplate.
 */
export function createGameWorld(): IWorld {
  return createWorld();
}

/**
 * Utility to provision a new entity identifier within a world.
 */
export function createEntity(world: IWorld): number {
  return addEntity(world);
}

/**
 * Utility to destroy an entity and clear all of its components safely.
 */
export function destroyEntity(world: IWorld, entity: number): void {
  if (hasComponent(world, TransformComponent, entity)) {
    // Remove transform first to avoid stale references when debugging dumps read component
    // arrays. We then fall through to removeEntity which clears every other component slot.
    removeEntity(world, entity);
    return;
  }
  removeEntity(world, entity);
}

export type GameWorld = IWorld;
