// schema.ts
// Summary: Shared Colyseus schema definitions and message identifiers for Tanks for Nothing.
// Structure: Defines Schema subclasses representing players, projectiles, and top-level game state
//            alongside string literal message catalogs for client/server communication.
// Usage: Imported by both the server Colyseus Room and the client networking layer to ensure
//        synchronized state shapes and consistent message routing without duplicating literals.
// ---------------------------------------------------------------------------

import { Schema, type, MapSchema } from '@colyseus/schema';

/**
 * PlayerStateSchema captures both static tank configuration and dynamic runtime properties so
 * every client can faithfully reconstruct remote tanks from state patches alone.
 */
export class PlayerStateSchema extends Schema {
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
  @type('number') declare x: number;
  @type('number') declare y: number;
  @type('number') declare z: number;
  @type('number') declare rot: number;
  @type('number') declare turret: number;
  @type('number') declare gun: number;
  @type('number') declare health: number;
  @type('number') declare ammoRemaining: number;
  @type({ map: 'number' }) declare ammoLoadout: MapSchema<number>;
}

/**
 * ProjectileStateSchema mirrors the authoritative projectile simulation handled server-side.
 */
export class ProjectileStateSchema extends Schema {
  @type('string') declare id: string;
  @type('number') declare x: number;
  @type('number') declare y: number;
  @type('number') declare z: number;
  @type('number') declare vx: number;
  @type('number') declare vy: number;
  @type('number') declare vz: number;
  @type('string') declare ammo: string;
  @type('string') declare shooter: string;
}

/**
 * TanksForNothingState is the authoritative root state replicated to every connected client.
 */
export class TanksForNothingState extends Schema {
  @type({ map: PlayerStateSchema })
  declare players: MapSchema<PlayerStateSchema>;

  @type({ map: ProjectileStateSchema })
  declare projectiles: MapSchema<ProjectileStateSchema>;

  @type('string')
  declare terrainName: string;

  @type('number')
  declare terrainRevision: number;

  constructor() {
    super();
    this.players = new MapSchema<PlayerStateSchema>();
    this.projectiles = new MapSchema<ProjectileStateSchema>();
    this.terrainName = 'unknown';
    this.terrainRevision = 0;
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
