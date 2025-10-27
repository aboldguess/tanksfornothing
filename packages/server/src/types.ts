// types.ts
// Summary: Shared TypeScript interfaces representing persistent game data models used by both
//          the HTTP API layer and the Colyseus room implementation.
// Structure: Defines domain records for nations, tanks, ammunition, terrain metadata, and user
//            authentication stats so separate modules can import a single canonical source.
// Usage: Import from '@tanksfornothing/server/types' within the server workspace to reference
//        these models without creating circular dependencies between feature modules.
// ---------------------------------------------------------------------------

export interface NationRecord {
  name: string;
  flag: string;
}

export interface TankDefinition {
  name: string;
  nation: string;
  br: number;
  class: string;
  armor: number;
  turretArmor: number;
  cannonCaliber: number;
  ammo: string[];
  ammoCapacity: number;
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
  [extra: string]: unknown;
}

export interface AmmoDefinition {
  name: string;
  nation: string;
  caliber: number;
  armorPen: number;
  type: string;
  explosionRadius: number;
  pen0: number;
  pen100: number;
  image: string;
  speed: number;
  damage: number;
  penetration: number;
  explosion: number;
}

export interface FlagPoint {
  x: number;
  y: number;
}

export interface TeamFlags {
  a: FlagPoint | null;
  b: FlagPoint | null;
  c: FlagPoint | null;
  d: FlagPoint | null;
}

export interface TerrainNoiseSettings {
  scale: number;
  amplitude: number;
}

export interface TerrainLightingSettings {
  sunPosition: { x: number; y: number; z: number };
  sunColor: string;
  ambientColor: string;
}

export interface TerrainGroundPaletteEntry {
  name: string;
  color: string;
  traction: number;
  viscosity: number;
  texture: string;
}

export interface TerrainDefinition {
  name: string;
  type: string;
  size: { x: number; y: number };
  flags: { red: TeamFlags; blue: TeamFlags };
  ground: number[][];
  elevation: number[][];
  palette: TerrainGroundPaletteEntry[];
  noise: TerrainNoiseSettings;
  lighting: TerrainLightingSettings;
}

export interface TerrainPayload {
  name: string;
  definition: TerrainDefinition | null;
}

export interface UserStats {
  games: number;
  kills: number;
  deaths: number;
}

export interface UserRecord {
  passwordHash: string;
  stats: UserStats;
}
