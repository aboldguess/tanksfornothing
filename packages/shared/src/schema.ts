// schema.ts
// Summary: Shared Colyseus schema definitions and command/event catalogs, now optimised for ECS
//          driven replication by packing component data into dense arrays rather than per-player
//          objects.
// Structure: Declares metadata maps describing static tank information alongside runtime buffers
//            for transforms, physics, and projectile state. Also exports command/event literals
//            consumed by both server and client networking layers.
// Usage: import { TanksForNothingState, GAME_COMMAND } from '@tanksfornothing/shared';
// ---------------------------------------------------------------------------

import { Schema, type, MapSchema, ArraySchema } from '@colyseus/schema';

/**
 * PlayerMetadataSchema stores high-level descriptive information keyed by Colyseus sessionId.
 */
export class PlayerMetadataSchema extends Schema {
  @type('number') declare entityId: number;
  @type('string') declare username: string;
  @type('string') declare tankName: string;
  @type('string') declare nation: string;
  @type('number') declare battleRating: number;
  @type('string') declare tankClass: string;
  @type('number') declare armor: number;
  @type('number') declare turretArmor: number;
  @type('number') declare cannonCaliber: number;
  @type('number') declare barrelLength: number;
  @type('number') declare mainCannonFireRate: number;
  @type('number') declare crew: number;
  @type('number') declare engineHp: number;
  @type('number') declare maxSpeed: number;
  @type('number') declare maxReverseSpeed: number;
  @type('number') declare incline: number;
  @type('number') declare bodyRotation: number;
  @type('number') declare turretRotation: number;
  @type('number') declare maxTurretIncline: number;
  @type('number') declare maxTurretDecline: number;
  @type('number') declare horizontalTraverse: number;
  @type('number') declare bodyWidth: number;
  @type('number') declare bodyLength: number;
  @type('number') declare bodyHeight: number;
  @type('number') declare turretWidth: number;
  @type('number') declare turretLength: number;
  @type('number') declare turretHeight: number;
  @type('number') declare turretXPercent: number;
  @type('number') declare turretYPercent: number;
  @type('number') declare ammoCapacity: number;
  @type({ map: 'number' }) declare ammoLoadout: MapSchema<number>;
}

/**
 * PlayerRuntimeBufferSchema represents dense component data mirrored from the authoritative ECS
 * world. The parallel arrays allow Colyseus patches to send compact diffs even with many players.
 */
export class PlayerRuntimeBufferSchema extends Schema {
  @type(['number']) declare entityId: ArraySchema<number>;
  @type(['number']) declare x: ArraySchema<number>;
  @type(['number']) declare y: ArraySchema<number>;
  @type(['number']) declare z: ArraySchema<number>;
  @type(['number']) declare rot: ArraySchema<number>;
  @type(['number']) declare turret: ArraySchema<number>;
  @type(['number']) declare gun: ArraySchema<number>;
  @type(['number']) declare vx: ArraySchema<number>;
  @type(['number']) declare vy: ArraySchema<number>;
  @type(['number']) declare vz: ArraySchema<number>;
  @type(['number']) declare health: ArraySchema<number>;
  @type(['number']) declare maxHealth: ArraySchema<number>;
  @type(['number']) declare cooldown: ArraySchema<number>;
  @type(['number']) declare ammoRemaining: ArraySchema<number>;

  constructor() {
    super();
    this.entityId = new ArraySchema<number>();
    this.x = new ArraySchema<number>();
    this.y = new ArraySchema<number>();
    this.z = new ArraySchema<number>();
    this.rot = new ArraySchema<number>();
    this.turret = new ArraySchema<number>();
    this.gun = new ArraySchema<number>();
    this.vx = new ArraySchema<number>();
    this.vy = new ArraySchema<number>();
    this.vz = new ArraySchema<number>();
    this.health = new ArraySchema<number>();
    this.maxHealth = new ArraySchema<number>();
    this.cooldown = new ArraySchema<number>();
    this.ammoRemaining = new ArraySchema<number>();
  }
}

/**
 * ProjectileRuntimeBufferSchema mirrors the projectile ECS archetype for the benefit of clients.
 */
export class ProjectileRuntimeBufferSchema extends Schema {
  @type(['string']) declare id: ArraySchema<string>;
  @type(['number']) declare entityId: ArraySchema<number>;
  @type(['number']) declare x: ArraySchema<number>;
  @type(['number']) declare y: ArraySchema<number>;
  @type(['number']) declare z: ArraySchema<number>;
  @type(['number']) declare vx: ArraySchema<number>;
  @type(['number']) declare vy: ArraySchema<number>;
  @type(['number']) declare vz: ArraySchema<number>;
  @type(['string']) declare ammo: ArraySchema<string>;
  @type(['string']) declare shooter: ArraySchema<string>;

  constructor() {
    super();
    this.id = new ArraySchema<string>();
    this.entityId = new ArraySchema<number>();
    this.x = new ArraySchema<number>();
    this.y = new ArraySchema<number>();
    this.z = new ArraySchema<number>();
    this.vx = new ArraySchema<number>();
    this.vy = new ArraySchema<number>();
    this.vz = new ArraySchema<number>();
    this.ammo = new ArraySchema<string>();
    this.shooter = new ArraySchema<string>();
  }
}

/**
 * TanksForNothingState holds authoritative gameplay information replicated to clients.
 */
export class TanksForNothingState extends Schema {
  @type({ map: PlayerMetadataSchema })
  declare playerMetadata: MapSchema<PlayerMetadataSchema>;

  @type(PlayerRuntimeBufferSchema)
  declare playerRuntime: PlayerRuntimeBufferSchema;

  @type(ProjectileRuntimeBufferSchema)
  declare projectileRuntime: ProjectileRuntimeBufferSchema;

  @type('string')
  declare terrainName: string;

  @type('number')
  declare terrainRevision: number;

  @type('number')
  declare tick: number;

  constructor() {
    super();
    this.playerMetadata = new MapSchema<PlayerMetadataSchema>();
    this.playerRuntime = new PlayerRuntimeBufferSchema();
    this.projectileRuntime = new ProjectileRuntimeBufferSchema();
    this.terrainName = 'unknown';
    this.terrainRevision = 0;
    this.tick = 0;
  }
}

/**
 * Message channels for client -> server commands.
 */
export const GAME_COMMAND = {
  PlayerUpdate: 'cmd:player:update',
  PlayerFire: 'cmd:player:fire'
} as const;
export type GameCommand = (typeof GAME_COMMAND)[keyof typeof GAME_COMMAND];

/**
 * Message channels for server -> client events that are not covered by schema replication.
 */
export const GAME_EVENT = {
  TanksCatalog: 'evt:catalog:tanks',
  AmmoCatalog: 'evt:catalog:ammo',
  TerrainDefinition: 'evt:world:terrain',
  JoinDenied: 'evt:error:join-denied',
  ProjectileExploded: 'evt:projectile:exploded',
  TankDamaged: 'evt:tank:damaged',
  Restart: 'evt:world:restart'
} as const;
export type GameEvent = (typeof GAME_EVENT)[keyof typeof GAME_EVENT];

export type AmmoLoadout = Record<string, number>;
