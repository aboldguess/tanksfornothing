// tanks-room.ts
// Summary: Colyseus Room implementation for Tanks for Nothing providing authoritative
//          multiplayer state management for players, projectiles, and terrain metadata.
// Structure: Defines dependency injection contracts, handles authentication during join,
//            spawns players into the shared Schema state, processes client commands for
//            movement and firing, and simulates projectiles while broadcasting state
//            mutations and high-level events.
// Usage: Instantiated by the HTTP bootstrap when registering the Colyseus transport; other
//        modules call the exported static helpers (e.g. restartAll) to coordinate actions
//        across every active room instance.
// ---------------------------------------------------------------------------

import type { AuthContext, Client } from 'colyseus';
import { Room } from 'colyseus';
import { MapSchema } from '@colyseus/schema';
import {
  GAME_COMMAND,
  GAME_EVENT,
  TanksForNothingState,
  PlayerStateSchema,
  ProjectileStateSchema,
  type AmmoLoadout
} from '@tanksfornothing/shared';

import type { AmmoDefinition, TankDefinition, TerrainPayload } from '../types.js';

interface TanksRoomDependencies {
  authenticate: (context: AuthContext) => { username: string } | { error: string };
  findTank: (name: string, nation: string) => TankDefinition | undefined;
  getTanks: () => TankDefinition[];
  getAmmo: () => AmmoDefinition[];
  getTerrain: () => TerrainPayload;
  recordGameStart: (username: string) => void;
  recordKill: (username: string) => void;
  recordDeath: (username: string) => void;
  persistUsers: () => Promise<void>;
}

interface JoinOptions {
  tank?: { name?: string; nation?: string };
  loadout?: AmmoLoadout;
}

interface PlayerRuntimeState {
  username: string;
  tank: TankDefinition;
  lastFire: number;
}

const GRAVITY = -9.81;

export class TanksForNothingRoom extends Room<TanksForNothingState> {
  private static readonly activeRooms = new Set<TanksForNothingRoom>();

  private dependencies!: TanksRoomDependencies;
  private baseBR: number | null = null;
  private readonly runtime = new Map<string, PlayerRuntimeState>();
  private readonly projectileLife = new Map<string, number>();

  onCreate(options: { dependencies: TanksRoomDependencies }): void {
    this.dependencies = options.dependencies;
    this.setState(new TanksForNothingState());
    const terrain = this.dependencies.getTerrain();
    this.state.terrainName = terrain.name;
    this.state.terrainRevision = Date.now();
    this.clock.setInterval(() => this.stepProjectiles(0.05), 50);
    TanksForNothingRoom.activeRooms.add(this);
    this.onMessage(GAME_COMMAND.PlayerUpdate, (client, message) => {
      this.handlePlayerUpdate(client, message);
    });
    this.onMessage(GAME_COMMAND.PlayerFire, (client, message) => {
      this.handlePlayerFire(client, message);
    });
  }

  onDispose(): void {
    TanksForNothingRoom.activeRooms.delete(this);
  }

  async onAuth(client: Client, options: JoinOptions, context: AuthContext): Promise<boolean> {
    const auth = this.dependencies.authenticate(context);
    if ('error' in auth) {
      throw new Error(auth.error);
    }
    const tankRequest = options?.tank;
    if (!tankRequest?.name || !tankRequest?.nation) {
      throw new Error('Tank selection required');
    }
    const tank = this.dependencies.findTank(tankRequest.name, tankRequest.nation);
    if (!tank) {
      throw new Error('Invalid tank');
    }
    if (this.baseBR === null) {
      this.baseBR = tank.br;
    }
    if (tank.br > (this.baseBR ?? tank.br) + 1) {
      throw new Error('Tank BR too high');
    }
    const loadout = this.sanitizeLoadout(options?.loadout ?? {}, tank);
    const totalLoadout = Object.values(loadout).reduce((sum, count) => sum + count, 0);
    const ammoCapacity = Number.isFinite(tank.ammoCapacity) ? Number(tank.ammoCapacity) : 0;
    const ammoRemaining = totalLoadout > 0 ? Math.min(totalLoadout, ammoCapacity || totalLoadout) : ammoCapacity;

    (client as Client & { auth: TanksClientAuth }).auth = {
      username: auth.username,
      tank,
      loadout,
      ammoRemaining
    } satisfies TanksClientAuth;
    return true;
  }

  onJoin(client: Client, _options: JoinOptions): void {
    const auth = this.getClientAuth(client);
    this.dependencies.recordGameStart(auth.username);
    this.spawnPlayer(client);
    client.send(GAME_EVENT.TanksCatalog, this.dependencies.getTanks());
    client.send(GAME_EVENT.AmmoCatalog, this.dependencies.getAmmo());
    client.send(GAME_EVENT.TerrainDefinition, this.dependencies.getTerrain());
  }

  onLeave(client: Client, _consented: boolean): void {
    this.state.players.delete(client.sessionId);
    this.runtime.delete(client.sessionId);
    if (this.state.players.size === 0) {
      this.baseBR = null;
    }
  }

  static restartAll(payload: TerrainPayload): void {
    for (const room of TanksForNothingRoom.activeRooms) {
      room.restartWithTerrain(payload);
    }
  }

  private restartWithTerrain(payload: TerrainPayload): void {
    this.state.players.clear();
    this.state.projectiles.clear();
    this.runtime.clear();
    this.projectileLife.clear();
    this.baseBR = null;
    this.state.terrainName = payload.name;
    this.state.terrainRevision = Date.now();
    this.broadcast(GAME_EVENT.Restart, true);
    this.broadcast(GAME_EVENT.TerrainDefinition, payload);
  }

  private getClientAuth(client: Client): TanksClientAuth {
    const auth = (client as Client & { auth?: TanksClientAuth }).auth;
    if (!auth) {
      throw new Error('Missing client auth payload');
    }
    return auth;
  }

  private spawnPlayer(client: Client): void {
    const auth = this.getClientAuth(client);
    const tank = auth.tank;
    const playerState = new PlayerStateSchema();
    playerState.username = auth.username;
    playerState.tankName = tank.name;
    playerState.nation = tank.nation;
    playerState.battleRating = tank.br;
    playerState.tankClass = tank.class;
    playerState.armor = tank.armor ?? 0;
    playerState.turretArmor = tank.turretArmor ?? 0;
    playerState.cannonCaliber = tank.cannonCaliber ?? 0;
    playerState.barrelLength = tank.barrelLength ?? 0;
    playerState.mainCannonFireRate = tank.mainCannonFireRate ?? 0;
    playerState.crew = tank.crew ?? 0;
    playerState.engineHp = tank.engineHp ?? 0;
    playerState.maxSpeed = tank.maxSpeed ?? 0;
    playerState.maxReverseSpeed = tank.maxReverseSpeed ?? 0;
    playerState.incline = tank.incline ?? 0;
    playerState.bodyRotation = tank.bodyRotation ?? 0;
    playerState.turretRotation = tank.turretRotation ?? 0;
    playerState.maxTurretIncline = tank.maxTurretIncline ?? 0;
    playerState.maxTurretDecline = tank.maxTurretDecline ?? 0;
    playerState.horizontalTraverse = tank.horizontalTraverse ?? 0;
    playerState.bodyWidth = tank.bodyWidth ?? 0;
    playerState.bodyLength = tank.bodyLength ?? 0;
    playerState.bodyHeight = tank.bodyHeight ?? 0;
    playerState.turretWidth = tank.turretWidth ?? 0;
    playerState.turretLength = tank.turretLength ?? 0;
    playerState.turretHeight = tank.turretHeight ?? 0;
    playerState.turretXPercent = tank.turretXPercent ?? 0;
    playerState.turretYPercent = tank.turretYPercent ?? 0;
    playerState.x = 0;
    playerState.y = 0;
    playerState.z = 0;
    playerState.rot = 0;
    playerState.turret = 0;
    playerState.gun = 0;
    playerState.health = 100;
    playerState.ammoLoadout = new MapSchema<number>();
    for (const [name, count] of Object.entries(auth.loadout)) {
      playerState.ammoLoadout.set(name, count);
    }
    playerState.ammoRemaining = auth.ammoRemaining;
    this.state.players.set(client.sessionId, playerState);
    this.runtime.set(client.sessionId, {
      username: auth.username,
      tank,
      lastFire: 0
    });
  }

  private handlePlayerUpdate(client: Client, payload: unknown): void {
    let playerState = this.state.players.get(client.sessionId);
    if (!playerState) {
      this.spawnPlayer(client);
      playerState = this.state.players.get(client.sessionId);
      if (!playerState) return;
    }
    if (!payload || typeof payload !== 'object') return;
    const next = payload as Partial<Record<keyof PlayerStateSchema, unknown>>;
    playerState.x = this.toNumber(next.x, playerState.x);
    playerState.y = this.toNumber(next.y, playerState.y);
    playerState.z = this.toNumber(next.z, playerState.z);
    playerState.rot = this.toNumber(next.rot, playerState.rot);
    playerState.turret = this.toNumber(next.turret, playerState.turret);
    playerState.gun = this.toNumber(next.gun, playerState.gun);
    if (typeof next.health === 'number' && Number.isFinite(next.health)) {
      playerState.health = Math.max(0, Math.min(100, next.health));
    }
  }

  private handlePlayerFire(client: Client, payload: unknown): void {
    const ammoName = typeof payload === 'string' ? payload : undefined;
    if (!ammoName) return;
    const playerState = this.state.players.get(client.sessionId);
    const runtime = this.runtime.get(client.sessionId);
    if (!playerState || !runtime) return;
    const now = Date.now();
    const fireDelay = runtime.tank.mainCannonFireRate > 0 ? 60000 / runtime.tank.mainCannonFireRate : 0;
    if (fireDelay > 0 && now - runtime.lastFire < fireDelay) return;
    const currentAmmo = playerState.ammoLoadout.get(ammoName) ?? 0;
    if (currentAmmo <= 0 || playerState.ammoRemaining <= 0) return;
    const ammoDef = this.dependencies.getAmmo().find((a) => a.name === ammoName);
    if (!ammoDef) return;

    runtime.lastFire = now;
    playerState.ammoLoadout.set(ammoName, currentAmmo - 1);
    playerState.ammoRemaining = Math.max(0, playerState.ammoRemaining - 1);

    const yaw = (playerState.rot || 0) + (playerState.turret || 0);
    const pitch = playerState.gun || 0;
    const cosPitch = Math.cos(pitch);
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    const speed = ammoDef.speed ?? 200;
    const barrelLen = playerState.barrelLength ?? runtime.tank.barrelLength ?? 3;
    const turretYOffset = (playerState.turretYPercent ?? 50) / 100 - 0.5;
    const turretXOffset = 0.5 - (playerState.turretXPercent ?? 50) / 100;
    const muzzleX = playerState.x + turretYOffset * playerState.bodyWidth - sinYaw * cosPitch * barrelLen;
    const muzzleY = playerState.y + 1 + Math.sin(pitch) * barrelLen;
    const muzzleZ = playerState.z + turretXOffset * playerState.bodyLength - cosYaw * cosPitch * barrelLen;

    const projectile = new ProjectileStateSchema();
    const id = `${now}-${Math.random().toString(16).slice(2)}`;
    projectile.id = id;
    projectile.x = muzzleX;
    projectile.y = muzzleY;
    projectile.z = muzzleZ;
    projectile.vx = -sinYaw * cosPitch * speed;
    projectile.vy = Math.sin(pitch) * speed;
    projectile.vz = -cosYaw * cosPitch * speed;
    projectile.ammo = ammoDef.name;
    projectile.shooter = client.sessionId;

    this.state.projectiles.set(id, projectile);
    this.projectileLife.set(id, 5);
    console.debug('Projectile fired', projectile);
  }

  private stepProjectiles(dt: number): void {
    try {
      for (const [id, projectile] of this.state.projectiles) {
        projectile.vy += GRAVITY * dt;
        projectile.x += projectile.vx * dt;
        projectile.y += projectile.vy * dt;
        projectile.z += projectile.vz * dt;
        if (projectile.y <= 0) {
          this.destroyProjectile(id, projectile);
          continue;
        }
        let exploded = false;
        for (const [sessionId, player] of this.state.players) {
          if (sessionId === projectile.shooter) continue;
          const dx = player.x - projectile.x;
          const dy = player.y - projectile.y;
          const dz = player.z - projectile.z;
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) < 2) {
            this.applyDamage(sessionId, projectile);
            this.destroyProjectile(id, projectile);
            exploded = true;
            break;
          }
        }
        if (exploded) continue;
        const life = (this.projectileLife.get(id) ?? 0) - dt;
        if (life <= 0) {
          this.destroyProjectile(id, projectile);
        } else {
          this.projectileLife.set(id, life);
        }
      }
    } catch (error) {
      console.error('Projectile simulation error', error);
    }
  }

  private destroyProjectile(id: string, projectile: ProjectileStateSchema): void {
    this.state.projectiles.delete(id);
    this.projectileLife.delete(id);
    this.broadcast(GAME_EVENT.ProjectileExploded, {
      id,
      x: projectile.x,
      y: projectile.y,
      z: projectile.z
    });
  }

  private applyDamage(sessionId: string, projectile: ProjectileStateSchema): void {
    const player = this.state.players.get(sessionId);
    if (!player) return;
    const ammoDef = this.dependencies.getAmmo().find((a) => a.name === projectile.ammo);
    const damage = ammoDef?.damage ?? ammoDef?.armorPen ?? 10;
    const penetration = ammoDef?.penetration ?? ammoDef?.pen0 ?? 0;
    const explosion = ammoDef?.explosion ?? ammoDef?.explosionRadius ?? 0;
    const armor = player.armor || 0;
    let total = penetration > armor ? damage : damage / 2;
    total += explosion;
    player.health = Math.max(0, player.health - total);
    this.broadcast(GAME_EVENT.TankDamaged, { id: sessionId, health: player.health });
    if (player.health <= 0) {
      const shooterRuntime = this.runtime.get(projectile.shooter);
      const victimRuntime = this.runtime.get(sessionId);
      if (shooterRuntime) {
        this.dependencies.recordKill(shooterRuntime.username);
      }
      if (victimRuntime) {
        this.dependencies.recordDeath(victimRuntime.username);
      }
      void this.dependencies.persistUsers();
    }
  }

  private sanitizeLoadout(loadout: AmmoLoadout, tank: TankDefinition): AmmoLoadout {
    const allowed = new Set(tank.ammo || []);
    const sanitized: AmmoLoadout = {};
    const capacity = Number.isFinite(tank.ammoCapacity) ? Number(tank.ammoCapacity) : 0;
    let total = 0;
    for (const [name, count] of Object.entries(loadout)) {
      if (!allowed.has(name)) continue;
      const numeric = Number(count);
      if (!Number.isFinite(numeric) || numeric <= 0) continue;
      const safeCount = Math.max(0, Math.floor(numeric));
      sanitized[name] = safeCount;
      total += safeCount;
    }
    if (capacity > 0 && total > capacity) {
      const scale = capacity / total;
      total = 0;
      for (const key of Object.keys(sanitized)) {
        const scaled = Math.max(0, Math.floor(sanitized[key] * scale));
        sanitized[key] = scaled;
        total += scaled;
      }
    }
    return sanitized;
  }

  private toNumber(value: unknown, fallback: number): number {
    const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return num;
  }
}

interface TanksClientAuth {
  username: string;
  tank: TankDefinition;
  loadout: AmmoLoadout;
  ammoRemaining: number;
}
