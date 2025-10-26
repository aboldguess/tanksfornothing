// ground-textures.ts
// @ts-nocheck
// Summary: Utility helpers for producing stylised ground textures based on admin-selected texture ids and colours.
//          Generates small canvas tiles for each texture type and stitches them into a terrain-wide texture used by the
//          client renderer. Designed to avoid external asset dependencies while still delivering readable biomes.
// Structure: colour helpers -> per-texture painters -> tile caching -> buildGroundTexture export.
// Usage: import { buildGroundTexture } from './ground-textures.js'; pass the palette and ground grid from the server to
//        receive a THREE.CanvasTexture ready for use on the terrain mesh.
// ---------------------------------------------------------------------------
import * as THREE from '../libs/three.module.js';

const tileCache = new Map<string, HTMLCanvasElement>();

function parseHexColour(hex: string) {
  const clean = (hex || '#777777').replace('#', '');
  const value = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean.padEnd(6, '0');
  const intVal = parseInt(value, 16);
  return {
    r: (intVal >> 16) & 255,
    g: (intVal >> 8) & 255,
    b: intVal & 255
  };
}

function clamp(value: number) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function toHex(r: number, g: number, b: number) {
  return `#${clamp(r).toString(16).padStart(2, '0')}${clamp(g).toString(16).padStart(2, '0')}${clamp(b).toString(16).padStart(2, '0')}`;
}

function lighten(base: { r: number; g: number; b: number }, amount: number) {
  return toHex(base.r + amount, base.g + amount, base.b + amount);
}

function darken(base: { r: number; g: number; b: number }, amount: number) {
  return toHex(base.r - amount, base.g - amount, base.b - amount);
}

function paintGrass(ctx: CanvasRenderingContext2D, baseColour: string) {
  ctx.fillStyle = baseColour;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const rgb = parseHexColour(baseColour);
  ctx.strokeStyle = lighten(rgb, 40);
  ctx.lineWidth = 3;
  for (let x = 0; x < ctx.canvas.width; x += 12) {
    ctx.beginPath();
    ctx.moveTo(x, ctx.canvas.height);
    ctx.bezierCurveTo(x + 4, ctx.canvas.height - 16, x - 4, 32, x + 2, 0);
    ctx.stroke();
  }
  ctx.strokeStyle = darken(rgb, 30);
  ctx.lineWidth = 2;
  for (let x = 6; x < ctx.canvas.width; x += 14) {
    ctx.beginPath();
    ctx.moveTo(x, ctx.canvas.height);
    ctx.lineTo(x + 3, ctx.canvas.height - 18);
    ctx.stroke();
  }
}

function paintMud(ctx: CanvasRenderingContext2D, baseColour: string) {
  ctx.fillStyle = baseColour;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const rgb = parseHexColour(baseColour);
  ctx.fillStyle = darken(rgb, 35);
  for (let i = 0; i < 6; i += 1) {
    ctx.beginPath();
    const cx = (i * 23) % ctx.canvas.width;
    const cy = ((i * 37) % ctx.canvas.height);
    ctx.ellipse(cx, cy, 18, 12, (i * Math.PI) / 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = lighten(rgb, 25);
  for (let i = 0; i < 4; i += 1) {
    ctx.beginPath();
    const cx = ((i * 41) + 12) % ctx.canvas.width;
    const cy = ((i * 29) + 8) % ctx.canvas.height;
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintSnow(ctx: CanvasRenderingContext2D, baseColour: string) {
  ctx.fillStyle = lighten(parseHexColour(baseColour), 10);
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = '#dfe9ff';
  for (let i = 0; i < 80; i += 1) {
    const x = (i * 11) % ctx.canvas.width;
    const y = (i * 17) % ctx.canvas.height;
    ctx.fillRect(x, y, 2, 2);
  }
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 40; i += 1) {
    const x = (i * 19) % ctx.canvas.width;
    const y = (i * 23) % ctx.canvas.height;
    ctx.fillRect(x, y, 1, 1);
  }
}

function paintSand(ctx: CanvasRenderingContext2D, baseColour: string) {
  ctx.fillStyle = baseColour;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const rgb = parseHexColour(baseColour);
  ctx.strokeStyle = lighten(rgb, 30);
  ctx.lineWidth = 2;
  for (let y = 8; y < ctx.canvas.height; y += 16) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(ctx.canvas.width / 4, y - 4, ctx.canvas.width / 2, y + 4, ctx.canvas.width, y - 2);
    ctx.stroke();
  }
  ctx.strokeStyle = darken(rgb, 25);
  for (let y = 4; y < ctx.canvas.height; y += 16) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(ctx.canvas.width / 3, y + 6, (ctx.canvas.width * 2) / 3, y - 6, ctx.canvas.width, y + 2);
    ctx.stroke();
  }
}

function paintRock(ctx: CanvasRenderingContext2D, baseColour: string) {
  const rgb = parseHexColour(baseColour);
  ctx.fillStyle = baseColour;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.strokeStyle = darken(rgb, 45);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, ctx.canvas.height / 2);
  ctx.lineTo(ctx.canvas.width / 3, ctx.canvas.height / 3);
  ctx.lineTo((ctx.canvas.width * 2) / 3, (ctx.canvas.height * 2) / 3);
  ctx.lineTo(ctx.canvas.width, ctx.canvas.height / 2);
  ctx.stroke();
  ctx.strokeStyle = lighten(rgb, 40);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ctx.canvas.width / 4, ctx.canvas.height);
  ctx.lineTo(ctx.canvas.width / 2, ctx.canvas.height / 2);
  ctx.lineTo((ctx.canvas.width * 3) / 4, ctx.canvas.height);
  ctx.stroke();
}

function buildTile(textureId: string, baseColour: string) {
  const key = `${textureId}:${baseColour}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  switch (textureId) {
    case 'grass':
      paintGrass(ctx, baseColour);
      break;
    case 'mud':
      paintMud(ctx, baseColour);
      break;
    case 'snow':
      paintSnow(ctx, baseColour);
      break;
    case 'sand':
      paintSand(ctx, baseColour);
      break;
    case 'rock':
    default:
      paintRock(ctx, baseColour);
      break;
  }
  tileCache.set(key, canvas);
  return canvas;
}

export function buildGroundTexture(
  palette: Array<{ color: string; texture?: string }>,
  grid: number[][]
): THREE.CanvasTexture {
  const height = Array.isArray(grid) ? grid.length : 0;
  const width = height ? grid[0].length : 0;
  const canvas = document.createElement('canvas');
  const cellSize = 64;
  canvas.width = Math.max(1, width * cellSize);
  canvas.height = Math.max(1, height * cellSize);
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const paletteIndex = grid[y]?.[x] ?? 0;
      const entry = palette[paletteIndex] || palette[0];
      const tile = buildTile(entry?.texture || 'grass', entry?.color || '#777777');
      const drawY = height - y - 1;
      ctx.drawImage(tile, x * cellSize, drawY * cellSize, cellSize, cellSize);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
