// metadata.ts
// Summary: Shared metadata helpers describing non-component state that both the server and
//          client require when translating Colyseus payloads into ECS entities.
// Structure: Declares serialisable interfaces for tank blueprints, player runtime descriptors,
//            and projectile bookkeeping alongside convenience helpers for ammo accounting.
// Usage: import type { PlayerMetadata } from '@tanksfornothing/shared/ecs';
// ---------------------------------------------------------------------------

import type { AmmoLoadout } from '../schema.js';

/**
 * TankSnapshot captures the static, mostly geometric properties of a tank. The structure mirrors
 * the values required to build meshes on the client and to calculate muzzle offsets server-side.
 */
export interface TankSnapshot {
  name: string;
  nation: string;
  battleRating: number;
  tankClass: string;
  armor: number;
  turretArmor: number;
  cannonCaliber: number;
  barrelLength: number;
  mainCannonFireRate: number;
  crew: number;
  engineHp: number;
  maxSpeed: number;
  maxReverseSpeed: number;
  incline: number;
  bodyRotation: number;
  turretRotation: number;
  maxTurretIncline: number;
  maxTurretDecline: number;
  horizontalTraverse: number;
  bodyWidth: number;
  bodyLength: number;
  bodyHeight: number;
  turretWidth: number;
  turretLength: number;
  turretHeight: number;
  turretXPercent: number;
  turretYPercent: number;
}

/**
 * PlayerMetadata captures strings and high-level numbers that would bloat component arrays. It is
 * keyed by Colyseus sessionId when replicated through the schema.
 */
export interface PlayerMetadata {
  entity: number;
  sessionId: string;
  username: string;
  tank: TankSnapshot;
  ammoLoadout: Record<string, number>;
  ammoCapacity: number;
}

/**
 * ProjectileMetadata stores descriptive information about an active projectile that components do
 * not naturally capture (e.g. ammo name for VFX, shooter identity for scoring, etc.).
 */
export interface ProjectileMetadata {
  entity: number;
  id: string;
  ammoName: string;
  shooterSessionId: string;
  damage: number;
  penetration: number;
  explosion: number;
}

/**
 * Utility to deep clone an ammo loadout to avoid mutation leaks across server/client boundaries.
 */
export function cloneAmmoLoadout(loadout: AmmoLoadout): Record<string, number> {
  return Object.fromEntries(
    Object.entries(loadout).map(([key, value]) => [key, Math.max(0, Math.floor(Number(value) || 0))])
  );
}
