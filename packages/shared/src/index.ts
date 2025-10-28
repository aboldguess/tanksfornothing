// index.ts
// Summary: Public entry point for the shared workspace, re-exporting reusable math and terrain helpers.
// Structure: Named exports for terrain-noise utilities to support both client and server packages.
// Usage: import { generateGentleHills } from '@tanksfornothing/shared';
// ---------------------------------------------------------------------------

export { generateGentleHills } from './terrain-noise.js';
export {
  TanksForNothingState,
  PlayerMetadataSchema,
  PlayerRuntimeBufferSchema,
  ProjectileRuntimeBufferSchema,
  GAME_COMMAND,
  GAME_EVENT,
  type GameCommand,
  type GameEvent,
  type AmmoLoadout
} from './schema.js';
export {
  createGameWorld,
  createEntity,
  destroyEntity,
  TransformComponent,
  TargetComponent,
  VelocityComponent,
  HealthComponent,
  AmmoStateComponent,
  CooldownComponent,
  TankStatsComponent,
  ProjectileComponent,
  PlayerTagComponent,
  type GameWorld
} from './ecs/components.js';
export type { PlayerMetadata, ProjectileMetadata, TankSnapshot } from './ecs/metadata.js';
export {
  writePlayerRuntimeBuffer,
  writeProjectileRuntimeBuffer,
  applyPlayerRuntimeBuffer,
  applyProjectileRuntimeBuffer,
  type EnsureEntityForId
} from './ecs/snapshots.js';
export { cloneAmmoLoadout } from './ecs/metadata.js';
