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
import {
  GAME_COMMAND,
  GAME_EVENT,
  TanksForNothingState,
  type AmmoLoadout
} from '@tanksfornothing/shared';

import type { AmmoDefinition, TankDefinition, TerrainPayload } from '../types.js';
import { ServerWorldController } from './server-world.js';

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

export class TanksForNothingRoom extends Room<TanksForNothingState> {
  private static readonly activeRooms = new Set<TanksForNothingRoom>();

  private dependencies!: TanksRoomDependencies;
  private baseBR: number | null = null;
  private world!: ServerWorldController;

  onCreate(options: { dependencies: TanksRoomDependencies }): void {
    this.dependencies = options.dependencies;
    this.world = new ServerWorldController({
      getAmmo: () => this.dependencies.getAmmo()
    });
    this.setState(new TanksForNothingState());
    const terrain = this.dependencies.getTerrain();
    this.state.terrainName = terrain.name;
    this.state.terrainRevision = Date.now();
    this.clock.setInterval(() => this.stepSimulation(0.05), 50);
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

  async onAuth(client: Client, options: JoinOptions, context: AuthContext): Promise<TanksClientAuth> {
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

    const authPayload = {
      username: auth.username,
      tank,
      loadout,
      ammoRemaining
    } satisfies TanksClientAuth;
    (client as Client & { auth: TanksClientAuth }).auth = authPayload;
    return authPayload;
  }

  onJoin(client: Client, _options: JoinOptions): void {
    const auth = this.getClientAuth(client);
    this.dependencies.recordGameStart(auth.username);
    this.world.refreshAmmoCatalog();
    this.spawnPlayer(client);
    client.send(GAME_EVENT.TanksCatalog, this.dependencies.getTanks());
    client.send(GAME_EVENT.AmmoCatalog, this.dependencies.getAmmo());
    client.send(GAME_EVENT.TerrainDefinition, this.dependencies.getTerrain());
  }

  onLeave(client: Client, _consented: boolean): void {
    this.world.removePlayer(client.sessionId);
    this.world.synchroniseState(this.state);
    if (this.state.playerMetadata.size === 0) {
      this.baseBR = null;
    }
  }

  static restartAll(payload: TerrainPayload): void {
    for (const room of TanksForNothingRoom.activeRooms) {
      room.restartWithTerrain(payload);
    }
  }

  private restartWithTerrain(payload: TerrainPayload): void {
    this.world = new ServerWorldController({
      getAmmo: () => this.dependencies.getAmmo()
    });
    this.world.synchroniseState(this.state);
    this.baseBR = null;
    this.state.terrainName = payload.name;
    this.state.terrainRevision = Date.now();
    this.state.tick = 0;
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
    this.world.addPlayer(client.sessionId, auth.username, auth.tank, auth.loadout, auth.ammoRemaining);
    this.world.synchroniseState(this.state);
  }

  private handlePlayerUpdate(client: Client, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const next = payload as Record<string, unknown>;
    this.world.updatePlayerTarget(client.sessionId, {
      x: this.toOptionalNumber(next.x),
      y: this.toOptionalNumber(next.y),
      z: this.toOptionalNumber(next.z),
      rot: this.toOptionalNumber(next.rot),
      turret: this.toOptionalNumber(next.turret),
      gun: this.toOptionalNumber(next.gun)
    });
  }

  private handlePlayerFire(client: Client, payload: unknown): void {
    const ammoName = typeof payload === 'string' ? payload : undefined;
    if (!ammoName) return;
    this.world.queueFire(client.sessionId, ammoName);
  }

  private stepSimulation(dt: number): void {
    try {
      const result = this.world.step(dt);
      for (const explosion of result.explosions) {
        this.broadcast(GAME_EVENT.ProjectileExploded, explosion);
      }
      for (const hit of result.damage) {
        this.broadcast(GAME_EVENT.TankDamaged, { id: hit.sessionId, health: hit.health });
      }
      if (result.kills.length > 0) {
        for (const entry of result.kills) {
          const shooterMeta = entry.shooter ? this.world.getMetadataForSession(entry.shooter) : undefined;
          const victimMeta = this.world.getMetadataForSession(entry.victim);
          if (shooterMeta) {
            this.dependencies.recordKill(shooterMeta.username);
          }
          if (victimMeta) {
            this.dependencies.recordDeath(victimMeta.username);
          }
        }
        void this.dependencies.persistUsers();
      }
      this.world.synchroniseState(this.state);
    } catch (error) {
      console.error('ECS simulation error', error);
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

  private toOptionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
}

interface TanksClientAuth {
  username: string;
  tank: TankDefinition;
  loadout: AmmoLoadout;
  ammoRemaining: number;
}
