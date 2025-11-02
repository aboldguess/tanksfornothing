// physics-world.ts
// Summary: Dedicated physics integration layer that encapsulates Cannon-es world lifecycle,
//          provides helpers for registering tank and projectile bodies, and mirrors terrain
//          geometry using heightfields or trimeshes so the server simulation remains
//          authoritative.
// Structure: Exports utility types for tagging bodies with metadata plus the
//            PhysicsWorldManager class which owns the Cannon world, terrain body, and
//            factory helpers for tanks/projectiles.
// Usage: Instantiated by ServerWorldController to keep physics concerns isolated from ECS
//        bookkeeping while still exposing the underlying cannon-es World instance.
// ---------------------------------------------------------------------------

import {
  Body,
  Box,
  ContactMaterial,
  Heightfield,
  Material,
  Sphere,
  Trimesh,
  Vec3,
  World
} from 'cannon-es';

import type { TerrainDefinition } from '../types.js';

export interface PhysicsUserData {
  kind: 'terrain' | 'tank' | 'projectile';
  entity?: number;
  sessionId?: string;
  projectileId?: string;
}

export type PhysicsBody = Body & { userData?: PhysicsUserData };

const DEFAULT_GRAVITY = -9.81;
const METERS_PER_KILOMETRE = 1000;

export class PhysicsWorldManager {
  readonly world: World;
  private terrainBody: PhysicsBody | null = null;

  constructor(gravity = DEFAULT_GRAVITY) {
    this.world = new World();
    this.world.gravity.set(0, gravity, 0);
    this.world.allowSleep = true;

    const terrainMaterial = new Material('terrain');
    const defaultMaterial = new Material('default');
    const terrainContact = new ContactMaterial(terrainMaterial, defaultMaterial, {
      friction: 0.4,
      restitution: 0.1
    });

    this.world.defaultContactMaterial.friction = 0.4;
    this.world.defaultContactMaterial.restitution = 0.1;
    this.world.addContactMaterial(terrainContact);
  }

  rebuildTerrain(definition: TerrainDefinition | null | undefined): void {
    if (this.terrainBody) {
      this.world.removeBody(this.terrainBody);
      this.terrainBody = null;
    }

    if (!definition) {
      const plane = this.createFallbackPlane();
      this.world.addBody(plane);
      this.terrainBody = plane;
      return;
    }

    const terrainBody = this.buildTerrainBody(definition) ?? this.createFallbackPlane();
    terrainBody.userData = { kind: 'terrain' };
    this.world.addBody(terrainBody);
    this.terrainBody = terrainBody;
  }

  createTankBody(size: { width: number; height: number; length: number }, mass: number): PhysicsBody {
    const shape = new Box(new Vec3(Math.max(size.width, 1) / 2, Math.max(size.height, 1) / 2, Math.max(size.length, 1) / 2));
    const body: PhysicsBody = new Body({
      mass,
      linearDamping: 0.2,
      angularDamping: 0.6
    });
    body.addShape(shape);
    body.userData = { kind: 'tank' };
    return body;
  }

  createProjectileBody(radius: number, mass: number): PhysicsBody {
    const shape = new Sphere(radius);
    const body: PhysicsBody = new Body({
      mass,
      linearDamping: 0,
      angularDamping: 0.1
    });
    body.addShape(shape);
    body.userData = { kind: 'projectile' };
    return body;
  }

  private buildTerrainBody(definition: TerrainDefinition): PhysicsBody | null {
    const grid = Array.isArray(definition.elevation) ? definition.elevation : null;
    if (!grid || grid.length < 2) return null;
    const columns = grid[0]?.length ?? 0;
    if (columns < 2) return null;

    // Convert every elevation sample to a finite number while tracking extrema so the final
    // physics mesh can be recentered around the renderer's zero-height plane. Cannon bodies are
    // happiest when massless shapes rest near the origin, so normalising prevents the terrain
    // from hovering metres above (or below) projectiles whenever content authors offset the map.
    const sanitisedGrid: number[][] = [];
    let minElevation = Infinity;
    let maxElevation = -Infinity;
    for (let row = 0; row < grid.length; row += 1) {
      const currentRow = grid[row];
      if (!Array.isArray(currentRow) || currentRow.length !== columns) {
        return null;
      }
      const sanitisedRow: number[] = [];
      for (let col = 0; col < columns; col += 1) {
        const sample = currentRow[col];
        const numeric = typeof sample === 'number' && Number.isFinite(sample) ? sample : Number(sample) || 0;
        if (numeric < minElevation) minElevation = numeric;
        if (numeric > maxElevation) maxElevation = numeric;
        sanitisedRow.push(numeric);
      }
      sanitisedGrid.push(sanitisedRow);
    }

    const midpoint = Number.isFinite(minElevation) && Number.isFinite(maxElevation)
      ? (minElevation + maxElevation) / 2
      : 0;
    const normalisedGrid = sanitisedGrid.map((row) => row.map((value) => value - midpoint));

    const widthKilometres = Number(definition.size?.x);
    const depthKilometres = Number(definition.size?.y);
    // Terrain definitions describe extents in kilometres for content tooling, so convert to metres
    // before constructing Cannon-es geometries. If no explicit size is provided, fall back to grid
    // resolution which already represents metre spacing.
    const width =
      Number.isFinite(widthKilometres) && widthKilometres > 0
        ? widthKilometres * METERS_PER_KILOMETRE
        : columns - 1;
    const depth =
      Number.isFinite(depthKilometres) && depthKilometres > 0
        ? depthKilometres * METERS_PER_KILOMETRE
        : grid.length - 1;

    const gridIsSquare = Math.abs(columns - grid.length) <= 1;
    if (gridIsSquare) {
      const matrix = normalisedGrid;
      // With width/depth now in metres, elementSize also represents metres between samples.
      const elementSize = width / Math.max(1, columns - 1);
      const body: PhysicsBody = new Body({ mass: 0 });
      const heightfield = new Heightfield(matrix, { elementSize });
      body.addShape(heightfield, new Vec3(-width / 2, 0, -depth / 2));
      return body;
    }

    const vertices: number[] = [];
    const indices: number[] = [];
    const xStep = width / Math.max(1, columns - 1);
    const zStep = depth / Math.max(1, grid.length - 1);
    const xOffset = width / 2;
    const zOffset = depth / 2;

    for (let row = 0; row < grid.length; row += 1) {
      const currentRow = normalisedGrid[row];
      for (let col = 0; col < columns; col += 1) {
        const x = col * xStep - xOffset;
        const y = currentRow[col];
        const z = row * zStep - zOffset;
        vertices.push(x, y, z);
      }
    }

    for (let row = 0; row < grid.length - 1; row += 1) {
      for (let col = 0; col < columns - 1; col += 1) {
        const a = row * columns + col;
        const b = a + 1;
        const c = a + columns;
        const d = c + 1;
        indices.push(a, c, b);
        indices.push(b, c, d);
      }
    }

    const body: PhysicsBody = new Body({ mass: 0 });
    const shape = new Trimesh(vertices, indices);
    body.addShape(shape);
    return body;
  }

  private createFallbackPlane(): PhysicsBody {
    const planeSize = 500;
    const body: PhysicsBody = new Body({ mass: 0 });
    const shape = new Box(new Vec3(planeSize, 1, planeSize));
    body.addShape(shape, new Vec3(0, -1, 0));
    body.userData = { kind: 'terrain' };
    return body;
  }
}
